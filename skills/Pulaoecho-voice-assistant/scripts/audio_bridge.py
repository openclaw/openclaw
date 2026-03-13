#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音频桥接模块
WebSocket服务器和voice_assistant之间的音频数据桥接
使用ping-pong buffer和队列实现无阻塞的音频转发
"""

import asyncio
import logging
import queue
import threading
import time
from typing import Callable, Optional

logger = logging.getLogger('Bridge')


# 接收队列深度警告阈值：超过100个包（每包80ms）= 8秒积压
_RECV_QUEUE_WARN_DEPTH = 100


class AudioReceiveQueue:
    """
    音频接收队列。
    - WebSocket线程调用 put()，每次放入一个原始包（device_id, 80ms PCM）。
    - VA录音线程调用 get() 阻塞读取。
    - 队列深度超过 100 时打 WARNING（表示VA消费速度跟不上）。
    """

    def __init__(self, warn_depth: int = _RECV_QUEUE_WARN_DEPTH):
        self.warn_depth = warn_depth
        self._q: queue.Queue = queue.Queue()

    def put(self, device_id: str, data: bytes):
        """WebSocket线程调用，放入一个音频包（带设备ID）。"""
        self._q.put((device_id, data))
        depth = self._q.qsize()
        if depth > self.warn_depth:
            logger.warning(f"[Bridge] Audio recv queue depth {depth} > {self.warn_depth}, VA may be too slow")

    def get(self, timeout: float = 1.0) -> Optional[tuple]:
        """VA录音线程调用，阻塞等待下一个音频包。返回 (device_id, data) 或 None"""
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def clear(self):
        """清空队列（唤醒/打断时调用）。"""
        cleared = 0
        while not self._q.empty():
            try:
                self._q.get_nowait()
                cleared += 1
            except queue.Empty:
                break
        if cleared:
            logger.debug(f"[Bridge] Audio recv queue cleared {cleared} packets")

    def depth(self) -> int:
        return self._q.qsize()


class AudioSendQueue:
    """音频发送队列，用于TTS音频发送"""
    
    def __init__(self, chunk_size: int = 2560):  # 80ms at 16kHz 16-bit
        self.chunk_size = chunk_size
        self.queue = queue.Queue()
        self.stopped = False
        
    def put(self, audio_data: bytes):
        """添加音频数据到队列（会自动分块）"""
        # 将音频数据分成80ms的块
        for i in range(0, len(audio_data), self.chunk_size):
            chunk = audio_data[i:i + self.chunk_size]
            # 如果最后一块不足chunk_size，填充0
            if len(chunk) < self.chunk_size:
                chunk = chunk + b'\x00' * (self.chunk_size - len(chunk))
            self.queue.put(chunk)
        logger.debug(f"Added {len(audio_data)} bytes to send queue, split into {(len(audio_data) + self.chunk_size - 1) // self.chunk_size} chunks")
    
    def get(self, timeout: Optional[float] = None) -> Optional[bytes]:
        """从队列获取一个音频块"""
        try:
            return self.queue.get(timeout=timeout)
        except queue.Empty:
            return None
    
    def clear(self):
        """清空队列"""
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except queue.Empty:
                break
        logger.debug("Send queue cleared")
    
    def size(self) -> int:
        """返回队列中的块数"""
        return self.queue.qsize()


class AudioBridge:
    """音频桥接器，连接WebSocket和voice_assistant
    
    新架构：所有数据都携带 device_id，不再使用全局 active_device_id
    """
    
    def __init__(self):
        # 音频接收队列（WebSocket → voice_assistant）每个元素 = (device_id, audio_data)
        self.recv_queue = AudioReceiveQueue()
        
        # TTS 音频发送回调 (device_id, audio_data)
        self.tts_callback: Optional[Callable[[str, bytes], None]] = None
        
        # 信号发送回调 (device_id, signal_type)
        self.signal_callback: Optional[Callable[[str, str], None]] = None
        
        # 兼容层：为旧代码保留
        self.active_device_id: Optional[str] = None
        self.last_audio_device_id: Optional[str] = None
        self.send_queue = AudioSendQueue()
        self.running = False
        self.send_thread: Optional[threading.Thread] = None
        
    def set_tts_callback(self, callback: Callable[[str, bytes], None]):
        """设置 TTS 音频回调 (device_id, audio_data)"""
        self.tts_callback = callback
        
    def set_signal_callback(self, callback: Callable[[str, str], None]):
        """设置信号回调 (device_id, signal_type)"""
        self.signal_callback = callback
    
    def write_audio(self, device_id: str, data: bytes):
        """WebSocket线程调用：将一个音频包入队，不阻塞
        
        Args:
            device_id: 发送该音频的设备ID
            data: 音频数据
        """
        self.recv_queue.put(device_id, data)

    def get_audio_packet(self, timeout: float = 1.0) -> Optional[tuple]:
        """VA录音线程调用：阻塞获取下一个音频包，返回 (device_id, data) 或 None"""
        return self.recv_queue.get(timeout=timeout)
    
    def send_tts_audio(self, device_id: str, audio_data: bytes):
        """发送 TTS 音频到指定设备"""
        if self.tts_callback:
            self.tts_callback(device_id, audio_data)
    
    def send_signal(self, device_id: str, signal_type: str):
        """发送信号给指定设备"""
        if self.signal_callback:
            self.signal_callback(device_id, signal_type)
    
    # ========== 兼容层方法（为旧代码保留）==========
    
    def set_active_device(self, device_id: str):
        """设置当前活动设备ID（兼容旧代码）"""
        self.active_device_id = device_id
    
    def queue_tts_audio(self, audio_data: bytes):
        """将TTS音频加入发送队列（兼容旧代码）"""
        self.send_queue.put(audio_data)
    
    def clear_send_queue(self):
        """清空发送队列（兼容旧代码）"""
        self.send_queue.clear()
    
    def start_send_thread(self):
        """启动发送线程（兼容旧代码）"""
        if self.send_thread and self.send_thread.is_alive():
            return
        self.running = True
        self.send_thread = threading.Thread(target=self._send_loop, daemon=True)
        self.send_thread.start()
        logger.info("Audio send thread started")
    
    def stop_send_thread(self):
        """停止发送线程（兼容旧代码）"""
        self.running = False
        if self.send_thread:
            self.send_thread.join(timeout=2)
        logger.info("Audio send thread stopped")
    
    def _send_loop(self):
        """发送线程主循环（兼容旧代码）"""
        while self.running:
            chunk = self.send_queue.get(timeout=0.1)
            if chunk and self.active_device_id:
                # 使用新架构的回调
                if self.tts_callback:
                    self.tts_callback(self.active_device_id, chunk)
                time.sleep(0.08)
