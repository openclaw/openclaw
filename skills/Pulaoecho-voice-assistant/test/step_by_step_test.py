#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
分步调试测试脚本
1. 发送 higoogle.wav (唤醒词)
2. 等待 wakeup 信号
3. 发送 whatsyourname.wav (问题)
4. 等待 feedback 信号和音频响应
"""

import asyncio
import base64
import json
import os
import sys
import time
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_device_client import TestDeviceClient

class StepByStepTest:
    """分步测试"""
    
    def __init__(self):
        self.client = TestDeviceClient("ws://localhost:18181/v1/audio/stream")
        self.wakeup_received = False
        self.feedback_received = False
        self.sleep_received = False
        self.audio_chunks_received = 0
        
    async def wait_for_wakeup(self, timeout=10):
        """等待wakeup信号"""
        print("\n⏳ Waiting for wakeup signal...")
        start_time = asyncio.get_event_loop().time()
        
        while not self.wakeup_received:
            if asyncio.get_event_loop().time() - start_time > timeout:
                print("❌ Timeout waiting for wakeup")
                return False
            await asyncio.sleep(0.1)
        
        print("✅ Wakeup signal received!")
        return True
    
    async def wait_for_feedback(self, timeout=30):
        """等待feedback信号"""
        print("\n⏳ Waiting for feedback signal...")
        start_time = asyncio.get_event_loop().time()
        
        while not self.feedback_received:
            if asyncio.get_event_loop().time() - start_time > timeout:
                print("❌ Timeout waiting for feedback")
                return False
            await asyncio.sleep(0.1)
        
        print("✅ Feedback signal received!")
        return True
    
    async def custom_receive_messages(self):
        """接收消息：音频只做内存累积，信号才打印"""
        try:
            async for message in self.client.websocket:
                msg = json.loads(message)
                msg_type = msg.get("type")

                if msg_type == "audio":
                    pcm = base64.b64decode(msg.get("data", ""))
                    self.client.recv_pcm.extend(pcm)
                    self.audio_chunks_received += 1

                elif msg_type == "wakeup":
                    print("[RECV] wakeup ✅")
                    self.wakeup_received = True

                elif msg_type == "process":
                    print("[RECV] process ⏳")

                elif msg_type == "feedback":
                    print("[RECV] feedback ✅")
                    self.feedback_received = True
                    self.client.recv_pcm = bytearray()  # 重置，只保留本次响应

                elif msg_type == "sleep":
                    print("[RECV] sleep 😴")
                    self.sleep_received = True

        except websockets.exceptions.ConnectionClosed:
            pass
    
    async def run(self):
        """运行分步测试"""
        print("=" * 60)
        print("分步调试测试")
        print("=" * 60)
        
        try:
            async with websockets.connect(self.client.server_url) as websocket:
                self.client.websocket = websocket
                print("\n✅ Connected to server!")
                
                # 启动接收任务
                receive_task = asyncio.create_task(self.custom_receive_messages())
                
                # 等待1秒
                await asyncio.sleep(1)
                
                # ========== 步骤1: 发送唤醒词 ==========
                print("\n" + "=" * 60)
                print("步骤1: 发送唤醒词 (higoogle.wav)")
                print("=" * 60)
                
                await self.client.send_real_audio_file("higoogle.wav")
                
                # 等待wakeup信号
                if not await self.wait_for_wakeup(timeout=20):
                    print("\n❌ 测试失败: 未收到wakeup信号")
                    receive_task.cancel()
                    return
                
                # ========== 步骤2: 发送问题 ==========
                print("\n" + "=" * 60)
                print("步骤2: 发送问题 (whatsyourname.wav)")
                print("=" * 60)
                
                await asyncio.sleep(1)  # 短暂延迟
                await self.client.send_real_audio_file("whatsyourname.wav")
                
                # 等待feedback信号
                if not await self.wait_for_feedback(timeout=90):
                    print("\n❌ 测试失败: 未收到feedback信号")
                    receive_task.cancel()
                    return
                
                # ══════════ 步骤3: 等待TTS音频接收完成 ══════════
                print("\n" + "=" * 60)
                print("步骤3: 接收TTS音频")
                print("=" * 60)
                print("⏳ Receiving audio (waiting for sleep signal or 15s timeout)...")

                # 等到sleep信号或超时15秒
                sleep_wait = 0
                while sleep_wait < 15:
                    await asyncio.sleep(0.5)
                    sleep_wait += 0.5
                    # 检查是否收到sleep信号（通过receive loop设置标志）
                    if self.sleep_received:
                        break

                # 取消接收任务
                receive_task.cancel()
                
                # 保存合并的音频
                if self.client.recv_pcm:
                    timestamp = int(time.time() * 1000)
                    filename = f"response_combined_{timestamp}.wav"
                    
                    print(f"\nSaving {len(self.client.recv_pcm)} bytes PCM to output/{filename}")
                    self.client.save_pcm_as_wav(filename)
                
                # ========== 测试总结 ==========
                print("\n" + "=" * 60)
                print("测试总结")
                print("=" * 60)
                print(f"✅ Wakeup signal: {'Received' if self.wakeup_received else 'NOT received'}")
                print(f"✅ Feedback signal: {'Received' if self.feedback_received else 'NOT received'}")
                print(f"📦 Audio chunks received: {self.audio_chunks_received}")
                
                if self.wakeup_received and self.feedback_received and self.audio_chunks_received > 0:
                    print("\n🎉 测试成功！完整流程验证通过！")
                else:
                    print("\n⚠️  测试部分成功，但有些步骤未完成")
                
        except Exception as e:
            print(f"\n❌ Error: {e}")
            import traceback
            traceback.print_exc()

async def main():
    """主函数"""
    test = StepByStepTest()
    await test.run()

if __name__ == "__main__":
    asyncio.run(main())
