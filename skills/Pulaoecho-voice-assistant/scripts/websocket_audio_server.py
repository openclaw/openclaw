#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WebSocket音频服务器
纯粹的音频转发层，不做任何语音识别和处理
负责：
1. 接收设备音频 → 转发给voice_assistant（通过audio_bridge）
2. 接收voice_assistant的TTS → 分包发送给设备
3. 转发控制信号（wakeup, process, feedback, sleep）
"""

import asyncio
import base64
import json
import logging
import os
import ssl
import time
import websockets
from typing import Dict, Optional

from audio_bridge import AudioBridge
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# Logging configured centrally in main.py; get module logger here
logger = logging.getLogger('WS')


def aes_encrypt(plaintext: str) -> str:
    """AES加密"""
    # 使用固定长度的密钥（AES-256需要32字节）
    key_bytes = b'0123456789abcdef0123456789abcdef'  # 恰好32字节
    # 生成随机IV
    iv = os.urandom(16)
    # 创建加密器
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    # 对明文进行填充
    padder = padding.PKCS7(128).padder()
    padded_data = padder.update(plaintext.encode('utf-8')) + padder.finalize()
    # 加密
    ciphertext = encryptor.update(padded_data) + encryptor.finalize()
    # 将IV和密文一起编码为base64
    return base64.b64encode(iv + ciphertext).decode('utf-8')


def aes_decrypt(ciphertext: str) -> str:
    """AES解密"""
    # 使用固定长度的密钥（AES-256需要32字节）
    key_bytes = b'0123456789abcdef0123456789abcdef'  # 恰好32字节
    # 解码base64
    data = base64.b64decode(ciphertext)
    # 提取IV（前16字节）
    iv = data[:16]
    # 提取密文
    ciphertext_bytes = data[16:]
    # 创建解密器
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    # 解密
    padded_plaintext = decryptor.update(ciphertext_bytes) + decryptor.finalize()
    # 移除填充
    unpadder = padding.PKCS7(128).unpadder()
    plaintext = unpadder.update(padded_plaintext) + unpadder.finalize()
    return plaintext.decode('utf-8')


class AudioDevice:
    """音频设备连接"""
    
    def __init__(self, websocket, device_id: str):
        self.websocket = websocket
        self.device_id = device_id
        self.last_ping = time.time()
        self.seq = 0
        
    async def send_audio(self, pcm_data: bytes, sample_rate: int = 16000):
        """发送音频数据给设备"""
        self.seq += 1
        msg = {
            "proto": 1,
            "seq": self.seq,
            "type": "audio",
            "format": "pcm",
            "sampleRate": sample_rate,
            "channels": 1,
            "bits": 16,
            "data": base64.b64encode(pcm_data).decode('utf-8'),
            "ts": int(time.time() * 1000)
        }
        await self.websocket.send(json.dumps(msg))
        
    async def send_signal(self, signal_type: str):
        """发送控制信号"""
        msg = {
            "proto": 1,
            "type": signal_type,
            "ts": int(time.time() * 1000)
        }
        await self.websocket.send(json.dumps(msg))
        logger.info(f"Sent {signal_type} signal to {self.device_id}")
    
    async def send_pong(self):
        """发送pong响应"""
        await self.send_signal("pong")


class WebSocketAudioServer:
    """WebSocket音频服务器"""
    
    def __init__(self, host: str = "0.0.0.0", port: int = 18181, ssl_context: Optional[ssl.SSLContext] = None, password: str = "pulaoecho_secure_password_2026"):
        self.host = host
        self.port = port
        self.ssl_context = ssl_context
        self.devices: Dict[str, AudioDevice] = {}
        self.audio_bridge: Optional[AudioBridge] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None  # asyncio事件循环引用
        # 服务端密码
        self.password = password
        
    def set_audio_bridge(self, bridge: AudioBridge):
        """设置音频桥接器"""
        self.audio_bridge = bridge
        
        # 设置桥接器的回调
        bridge.set_send_callback(self._on_tts_audio)
        bridge.set_signal_callback(self._on_signal)
    
    def _on_tts_audio(self, audio_chunk: bytes):
        """当有TTS音频需要发送时的回调（可从任意线程调用）"""
        if not self.loop:
            return
        # 只向当前活动设备发送TTS音频
        if self.audio_bridge and self.audio_bridge.active_device_id:
            device_id = self.audio_bridge.active_device_id
            if device_id in self.devices:
                device = self.devices[device_id]
                asyncio.run_coroutine_threadsafe(device.send_audio(audio_chunk), self.loop)
                logger.debug(f"Sent TTS audio to active device: {device_id}")
            else:
                logger.warning(f"Active device not found: {device_id}")
        else:
            logger.warning("No active device set, skipping TTS audio")
    
    def _on_signal(self, signal_type: str):
        """当需要发送信号时的回调（可从任意线程调用）"""
        if not self.loop:
            logger.warning(f"[WS] No event loop, cannot send signal: {signal_type}")
            return
        # 只向当前活动设备发送信号
        if self.audio_bridge and self.audio_bridge.active_device_id:
            device_id = self.audio_bridge.active_device_id
            if device_id in self.devices:
                device = self.devices[device_id]
                asyncio.run_coroutine_threadsafe(device.send_signal(signal_type), self.loop)
                logger.info(f"[WS] Sent signal '{signal_type}' to active device: {device_id}")
            else:
                logger.warning(f"[WS] Active device not found: {device_id}")
        else:
            logger.warning("[WS] No active device set, skipping signal: {signal_type}")
    
    async def handle_device(self, websocket):
        """处理设备连接"""
        device_id = None
        device = None
        
        try:
            # 首先接收设备的连接消息，要求包含deviceid和密码
            init_message = await websocket.recv()
            try:
                init_msg = json.loads(init_message)
                device_id = init_msg.get("deviceid")
                encrypted_password = init_msg.get("password")
                
                if not device_id:
                    logger.error("Device connection rejected: no deviceid provided")
                    await websocket.close(code=4000, reason="Missing deviceid")
                    return
                
                if not encrypted_password:
                    logger.error("Device connection rejected: no password provided")
                    await websocket.close(code=4001, reason="Missing password")
                    return
                
                # 验证密码
                try:
                    decrypted_password = aes_decrypt(encrypted_password)
                    if decrypted_password != self.password:
                        logger.error("Device connection rejected: invalid password")
                        await websocket.close(code=4002, reason="Invalid password")
                        return
                except Exception as e:
                    logger.error(f"Error decrypting password: {e}")
                    await websocket.close(code=4003, reason="Invalid password format")
                    return
                    
            except json.JSONDecodeError:
                logger.error("Invalid JSON in init message")
                await websocket.close(code=4000, reason="Invalid JSON")
                return
            
            # 创建设备实例
            device = AudioDevice(websocket, device_id)
            self.devices[device_id] = device
            
            logger.info(f"Device connected: {device_id}")
            
            # 发送连接成功信号
            await device.send_signal("connected")
            
            # 处理后续消息
            async for message in websocket:
                try:
                    msg = json.loads(message)
                    msg_type = msg.get("type")
                    
                    # 检查所有消息是否包含deviceid
                    msg_device_id = msg.get("deviceid")
                    if not msg_device_id or msg_device_id != device_id:
                        logger.warning(f"Message rejected: invalid deviceid")
                        continue
                    
                    if msg_type == "audio":
                        await self.handle_audio(device, msg)
                    elif msg_type == "ping":
                        await self.handle_ping(device)
                    else:
                        logger.warning(f"Unknown message type: {msg_type}")
                        
                except json.JSONDecodeError:
                    logger.error("Invalid JSON message")
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    
        except websockets.exceptions.ConnectionClosed:
            if device_id:
                logger.info(f"Device disconnected: {device_id}")
        finally:
            if device_id and device_id in self.devices:
                del self.devices[device_id]
    
    async def handle_audio(self, device: AudioDevice, msg: Dict):
        """处理音频消息 - 纯转发，不做处理"""
        try:
            # 解码音频数据
            if "txdata" in msg:
                tx_audio_data_b64 = msg["txdata"]
            else:
                logger.warning("No audio data in message")
                return
                
            tx_pcm_data = base64.b64decode(tx_audio_data_b64)
            
            # 转发给voice_assistant（通过audio_bridge）
            if self.audio_bridge:
                # 设置当前活动设备ID
                self.audio_bridge.set_active_device(device.device_id)
                self.audio_bridge.write_audio(tx_pcm_data)
            
            # 处理双声道情况的rxdata（如果存在）
            if "rxdata" in msg:
                try:
                    rx_audio_data_b64 = msg["rxdata"]
                    rx_pcm_data = base64.b64decode(rx_audio_data_b64)
                    # 这里可以根据需要处理rxdata，例如转发到其他地方
                    logger.debug(f"Received rxdata: {len(rx_pcm_data)} bytes")
                except Exception as e:
                    logger.error(f"Error handling rxdata: {e}")
            
        except Exception as e:
            logger.error(f"Error handling audio: {e}")
    
    async def handle_ping(self, device: AudioDevice):
        """处理心跳"""
        device.last_ping = time.time()
        await device.send_pong()
    
    async def start(self):
        """启动服务器"""
        # 保存事件循环引用，供跨线程回调使用
        self.loop = asyncio.get_running_loop()

        scheme = "wss" if self.ssl_context else "ws"
        logger.info(f"Starting WebSocket audio server on {self.host}:{self.port} ({scheme.upper()})")
        logger.info(f"WebSocket URL: {scheme}://{self.host}:{self.port}/v1/audio/stream")

        # 启动音频发送线程
        if self.audio_bridge:
            self.audio_bridge.start_send_thread()

        async with websockets.serve(self.handle_device, self.host, self.port, ssl=self.ssl_context):
            await asyncio.Future()  # 永久运行


async def main():
    """主函数"""
    # 创建音频桥接器
    bridge = AudioBridge()
    
    # 创建WebSocket服务器
    server = WebSocketAudioServer()
    server.set_audio_bridge(bridge)
    
    # TODO: 这里需要启动voice_assistant并连接到bridge
    # 暂时先启动服务器
    
    await server.start()


if __name__ == "__main__":
    asyncio.run(main())
