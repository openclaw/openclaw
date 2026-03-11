#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试设备客户端
模拟音频设备与WebSocket服务器通信
"""

import asyncio
import base64
import json
import os
import ssl
import sys
import time
import wave
import websockets

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


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


class TestDeviceClient:
    """测试设备客户端"""
    
    def __init__(self, server_url: str = "ws://localhost:18181/v1/audio/stream", ssl_context: ssl.SSLContext = None):
        self.server_url = server_url
        self.ssl_context = ssl_context
        self.seq = 0
        self.websocket = None
        self.output_dir = "output"
        # 原始PCM累积缓冲（bytearray，退出时转WAV）
        self.recv_pcm = bytearray()
        # 设备ID
        self.device_id = f"test_device_{int(time.time() * 1000)}"
        
        # 创建输出目录
        if not os.path.exists(self.output_dir):
            os.makedirs(self.output_dir)
        
    def load_test_audio(self, wav_file: str) -> bytes:
        """加载测试音频文件并转换为PCM"""
        try:
            with wave.open(wav_file, 'rb') as wav:
                pcm_data = wav.readframes(wav.getnframes())
                return pcm_data
        except Exception as e:
            print(f"Failed to load audio file: {e}")
            return None
    
    def create_audio_message(self, pcm_data: bytes, sample_rate: int = 16000) -> dict:
        """创建音频消息"""
        self.seq += 1
        return {
            "proto": 1,
            "seq": self.seq,
            "type": "audio",
            "format": "pcm",
            "sampleRate": sample_rate,
            "channels": 1,
            "bits": 16,
            "txdata": base64.b64encode(pcm_data).decode('utf-8'),
            "ts": int(time.time() * 1000),
            "deviceid": self.device_id
        }
    
    def create_ping_message(self) -> dict:
        """创建心跳消息"""
        return {
            "proto": 1,
            "type": "ping",
            "ts": int(time.time() * 1000),
            "deviceid": self.device_id
        }
    
    async def send_message(self, msg: dict):
        """发送消息"""
        if self.websocket:
            await self.websocket.send(json.dumps(msg))
            print(f"[SENT] {msg['type']}")
    
    def save_pcm_as_wav(self, filename: str, pcm_data: bytes = None, sample_rate: int = 16000) -> str:
        """将PCM数据保存为WAV文件，默认使用 recv_pcm"""
        data = pcm_data if pcm_data is not None else bytes(self.recv_pcm)
        if not data:
            print("  ⚠️  No PCM data to save")
            return None
        try:
            filepath = os.path.join(self.output_dir, filename)
            with wave.open(filepath, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)  # 16-bit
                wav.setframerate(sample_rate)
                wav.writeframes(data)
            print(f"  ✓ Saved WAV: {filepath} ({len(data)} bytes PCM)")
            return filepath
        except Exception as e:
            print(f"  ✗ Failed to save WAV: {e}")
            return None
    
    async def receive_messages(self):
        """接收服务器消息，音频只做内存累积"""
        try:
            async for message in self.websocket:
                msg = json.loads(message)
                msg_type = msg.get("type")
                
                if msg_type == "audio":
                    pcm = base64.b64decode(msg.get("data", ""))
                    self.recv_pcm.extend(pcm)
                    
                elif msg_type == "wakeup":
                    print("[RECV] wakeup")
                    
                elif msg_type == "process":
                    print("[RECV] process")
                    
                elif msg_type == "feedback":
                    print("[RECV] feedback")
                    self.recv_pcm = bytearray()  # 重置，只保留本次响应
                    
                elif msg_type == "sleep":
                    print("[RECV] sleep")
                    
                elif msg_type == "pong":
                    pass  # 心跳无需打印
                    
        except websockets.exceptions.ConnectionClosed:
            pass
    
    async def heartbeat_loop(self):
        """心跳循环"""
        while True:
            await asyncio.sleep(30)
            try:
                await self.send_message(self.create_ping_message())
            except Exception as e:
                print(f"Heartbeat error: {e}")
                break
    
    async def send_real_audio_file(self, wav_file: str):
        """发送真实的WAV音频文件"""
        print(f"\n[TEST] Loading audio file: {wav_file}")
        
        # 加载WAV文件
        pcm_data = self.load_test_audio(wav_file)
        if not pcm_data:
            print("[ERROR] Failed to load audio file")
            return
        
        print(f"[TEST] Loaded {len(pcm_data)} bytes of PCM data")
        
        # 分块发送（每80ms一块）
        chunk_size = 1280  # 80ms at 16kHz, 16-bit (16000 * 0.08 * 2)
        total_chunks = (len(pcm_data) + chunk_size - 1) // chunk_size
        
        print(f"[TEST] Sending {total_chunks} chunks...")
        
        for i in range(total_chunks):
            start = i * chunk_size
            end = min(start + chunk_size, len(pcm_data))
            chunk = pcm_data[start:end]
            
            # 如果最后一块不足chunk_size，填充0
            if len(chunk) < chunk_size:
                chunk = chunk + b'\x00' * (chunk_size - len(chunk))
            
            msg = self.create_audio_message(chunk)
            await self.send_message(msg)
            await asyncio.sleep(0.08)  # 80ms间隔
            
            if (i + 1) % 10 == 0:
                print(f"  Progress: {i+1}/{total_chunks} chunks")
        
        print(f"[TEST] ✓ Sent all {total_chunks} chunks")
    
    async def interactive_mode(self):
        """交互模式"""
        print("\n=== Interactive Mode ===")
        print("Commands:")
        print("  file <path>  - Send WAV file")
        print("  test1        - Send test1.wav")
        print("  ping         - Send heartbeat")
        print("  quit         - Exit")
        print()
        
        while True:
            try:
                cmd = await asyncio.get_event_loop().run_in_executor(
                    None, input, ">>> "
                )
                cmd = cmd.strip()
                
                if cmd == "quit":
                    break
                elif cmd == "test1":
                    await self.send_real_audio_file("test1.wav")
                elif cmd.startswith("file "):
                    wav_path = cmd[5:].strip()
                    await self.send_real_audio_file(wav_path)
                elif cmd == "ping":
                    await self.send_message(self.create_ping_message())
                else:
                    print("Unknown command")
                    
            except EOFError:
                break
            except Exception as e:
                print(f"Error: {e}")
    
    async def run(self):
        """运行客户端"""
        print(f"Connecting to {self.server_url}...")
        print(f"Using deviceid: {self.device_id}")
        
        try:
            async with websockets.connect(self.server_url, ssl=self.ssl_context) as websocket:
                self.websocket = websocket
                
                # 服务端密码
                server_password = "pulaoecho_secure_password_2026"
                # 加密密码
                encrypted_password = aes_encrypt(server_password)
                
                # 发送初始化消息，包含deviceid和加密的密码
                init_msg = {
                    "deviceid": self.device_id,
                    "password": encrypted_password,
                    "ts": int(time.time() * 1000)
                }
                await self.send_message(init_msg)
                
                # 启动心跳任务
                heartbeat_task = asyncio.create_task(self.heartbeat_loop())
                
                # 启动接收任务
                receive_task = asyncio.create_task(self.receive_messages())
                
                # 交互模式
                await self.interactive_mode()
                
                # 取消任务
                heartbeat_task.cancel()
                receive_task.cancel()
                
        except Exception as e:
            print(f"Connection error: {e}")


async def main():
    """主函数"""
    server_url = "ws://localhost:18181/v1/audio/stream"
    
    if len(sys.argv) > 1:
        server_url = sys.argv[1]
    
    client = TestDeviceClient(server_url)
    await client.run()


if __name__ == "__main__":
    asyncio.run(main())
