#!/usr/bin/env python3
"""
TTS Handler - 处理文本转语音，支持多设备隔离
每个 TTS 请求都携带 device_id，确保响应发送到正确的设备
"""

import logging
import queue
import re
import threading
from typing import Callable, Optional, Tuple

logger = logging.getLogger(__name__)

try:
    import io

    from gtts import gTTS
    has_tts = True
except ImportError:
    has_tts = False
    logger.warning("gTTS not available, TTS will be disabled")


class TTSHandler:
    """TTS 处理器 - 为每个设备独立生成和发送 TTS"""
    
    def __init__(self):
        self.tts_queue = queue.Queue()  # (device_id, text, generation)
        self.stop_flag = threading.Event()
        self.tts_callback: Optional[Callable[[str, bytes], None]] = None  # (device_id, audio_data)
        self.signal_callback: Optional[Callable[[str, str], None]] = None  # (device_id, signal_type)
        
        # 每个设备的当前 generation（用于中断检测）
        self.device_generations = {}  # {device_id: generation}
        self.generation_lock = threading.Lock()
        
    def set_tts_callback(self, callback: Callable[[str, bytes], None]):
        """设置 TTS 音频回调 (device_id, audio_data)"""
        self.tts_callback = callback
        
    def set_signal_callback(self, callback: Callable[[str, str], None]):
        """设置信号回调 (device_id, signal_type)"""
        self.signal_callback = callback
    
    def submit_tts(self, device_id: str, text: str, generation: int):
        """提交 TTS 请求"""
        self.tts_queue.put((device_id, text, generation))
        logger.debug(f"[TTS:{device_id[:8]}] Queued: {text[:30]}... (gen={generation})")
    
    def interrupt_device(self, device_id: str):
        """中断指定设备的 TTS"""
        with self.generation_lock:
            if device_id in self.device_generations:
                self.device_generations[device_id] += 1
                logger.info(f"[TTS:{device_id[:8]}] Interrupted, gen={self.device_generations[device_id]}")
    
    def get_device_generation(self, device_id: str) -> int:
        """获取设备当前 generation"""
        with self.generation_lock:
            return self.device_generations.get(device_id, 0)
    
    def set_device_generation(self, device_id: str, generation: int):
        """设置设备 generation"""
        with self.generation_lock:
            self.device_generations[device_id] = generation
    
    def _split_sentences(self, text: str) -> list:
        """分句处理，支持流式 TTS"""
        sentences = re.split(r'([。！？\.\!\?]+)', text)
        result = []
        for i in range(0, len(sentences) - 1, 2):
            sentence = sentences[i] + (sentences[i + 1] if i + 1 < len(sentences) else '')
            if sentence.strip():
                result.append(sentence.strip())
        if len(sentences) % 2 == 1 and sentences[-1].strip():
            result.append(sentences[-1].strip())
        return result if result else [text]
    
    def tts_thread(self):
        """TTS 线程 - 处理所有设备的 TTS 请求"""
        logger.info("[TTS] Thread started")
        
        if not has_tts:
            logger.error("[TTS] TTS libraries not available")
            return
        
        while not self.stop_flag.is_set():
            try:
                device_id, text, generation = self.tts_queue.get(timeout=1.0)
                
                # 检查是否被中断
                current_gen = self.get_device_generation(device_id)
                if generation != current_gen:
                    logger.info(f"[TTS:{device_id[:8]}] Skipped (gen mismatch: {generation} != {current_gen})")
                    continue
                
                logger.info(f"[TTS:{device_id[:8]}] Generating: {text[:50]}... (gen={generation})")
                
                # 发送 feedback 信号
                if self.signal_callback:
                    self.signal_callback(device_id, "feedback")
                
                # 分句处理
                sentences = self._split_sentences(text)
                
                for i, sentence in enumerate(sentences):
                    # 再次检查是否被中断
                    if generation != self.get_device_generation(device_id):
                        logger.info(f"[TTS:{device_id[:8]}] Interrupted during generation")
                        break
                    
                    logger.info(f"[TTS:{device_id[:8]}] Sentence {i+1}/{len(sentences)}: {sentence[:30]}...")
                    
                    try:
                        # 生成 TTS
                        tts = gTTS(text=sentence, lang='en', slow=False)
                        mp3_fp = io.BytesIO()
                        tts.write_to_fp(mp3_fp)
                        mp3_data = mp3_fp.getvalue()
                        
                        # 发送 TTS 音频（带设备 ID）
                        if self.tts_callback:
                            self.tts_callback(device_id, mp3_data)
                            logger.info(f"[TTS:{device_id[:8]}] Sent {len(mp3_data)} bytes")
                        
                    except Exception as e:
                        logger.error(f"[TTS:{device_id[:8]}] Error generating TTS: {e}")
                        break
                
                # 发送 sleep 信号
                if self.signal_callback:
                    self.signal_callback(device_id, "sleep")
                    logger.info(f"[TTS:{device_id[:8]}] Sent sleep signal")
                
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"[TTS] Error: {e}")
        
        logger.info("[TTS] Thread stopped")
    
    def start(self):
        """启动 TTS 线程"""
        thread = threading.Thread(target=self.tts_thread, daemon=True, name="TTS")
        thread.start()
        return thread
    
    def stop(self):
        """停止 TTS 线程"""
        self.stop_flag.set()
