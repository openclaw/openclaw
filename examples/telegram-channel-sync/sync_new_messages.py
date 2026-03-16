#!/usr/bin/env python3
"""
journey_of_someone 频道新消息同步脚本（增强版）
- 添加超时保护
- 添加连接复用
- 添加详细日志
"""
import asyncio
import os
import sys
import signal
from telethon import TelegramClient
from telethon.errors import FloodWaitError, RPCError
from datetime import datetime

# 配置
API_ID = 34417503
API_HASH = "44ffd372b38f182f6145eab6bf060377"
CHANNEL = "journey_of_someone"
SESSION_FILE = "/root/.openclaw/workspace/tg-channel-note/BensonTradingDesk/benson_scraper"
NEW_MSG_FILE = "/root/.openclaw/workspace/tg-channel-note/journey_of_someone/journey_of_someone_new_messages.md"
LAST_ID_FILE = "/root/.openclaw/workspace/tg-channel-note/journey_of_someone/last_synced_message_id.txt"
TIMEOUT_SECONDS = 180  # 3分钟超时

class TimeoutError(Exception):
    pass

def timeout_handler(signum, frame):
    raise TimeoutError(f"脚本执行超过 {TIMEOUT_SECONDS} 秒")

async def sync_new_messages():
    start_time = datetime.now()
    print(f"[{start_time.strftime('%Y-%m-%d %H:%M:%S')}] 🚀 开始同步 journey_of_someone 频道消息")
    
    # 设置超时信号
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(TIMEOUT_SECONDS)
    
    try:
        # 读取上次同步的最后消息ID
        last_id = 0
        if os.path.exists(LAST_ID_FILE):
            with open(LAST_ID_FILE, 'r') as f:
                content = f.read().strip()
                if content.isdigit():
                    last_id = int(content)
        
        print(f"📌 上次同步到消息ID: {last_id}")
        
        # 创建客户端（复用 session）
        client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
        
        try:
            await client.connect()
            
            if not await client.is_user_authorized():
                print("❌ 未授权，请先完成登录")
                return 1
            
            print("✅ 已登录 Telegram")
            
            # 获取频道实体
            try:
                channel = await client.get_entity(CHANNEL)
                print(f"✅ 找到频道: {channel.title}")
            except RPCError as e:
                print(f"❌ 获取频道失败: {e}")
                return 1
            
            # 抓取新消息（限制最多100条，防止超时）
            new_messages = []
            msg_count = 0
            max_messages = 100  # 限制单次同步数量
            
            async for message in client.iter_messages(channel, min_id=last_id, limit=max_messages):
                if message.text:
                    new_messages.append({
                        'id': message.id,
                        'date': message.date.strftime('%Y-%m-%d %H:%M:%S'),
                        'text': message.text,
                        'views': message.views or 0
                    })
                    msg_count += 1
                    if msg_count >= max_messages:
                        print(f"⚠️ 达到单次同步上限 ({max_messages} 条)，剩余消息下次同步")
                        break
            
            if not new_messages:
                print("✅ 没有新消息，无需更新")
                return 0
            
            # 按时间正序排列
            new_messages.sort(key=lambda x: x['id'])
            print(f"🆕 发现 {len(new_messages)} 条新消息，开始写入...")
            
            # 初始化文件（如果不存在）
            if not os.path.exists(NEW_MSG_FILE):
                os.makedirs(os.path.dirname(NEW_MSG_FILE), exist_ok=True)
                with open(NEW_MSG_FILE, 'w', encoding='utf-8') as f:
                    f.write("# journey_of_someone 新消息记录\n\n")
                    f.write("**频道**: https://t.me/journey_of_someone\n")
                    f.write("**说明**: 本文件记录历史抓取后的所有新消息\n\n")
                    f.write("---\n\n")
            
            # 追加写入新消息
            with open(NEW_MSG_FILE, 'a', encoding='utf-8') as f:
                f.write(f"\n## 同步时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
                for msg in new_messages:
                    f.write(f"### 消息 #{msg['id']}\n\n")
                    f.write(f"**时间**: {msg['date']}\n")
                    f.write(f"**浏览量**: {msg['views']}\n\n")
                    f.write(f"{msg['text']}\n\n")
                    f.write("---\n\n")
            
            # 更新最新消息ID
            latest_id = new_messages[-1]['id']
            with open(LAST_ID_FILE, 'w') as f:
                f.write(str(latest_id))
            
            elapsed = (datetime.now() - start_time).total_seconds()
            print(f"✅ 已写入 {len(new_messages)} 条新消息")
            print(f"📌 更新最新消息ID: {latest_id}")
            print(f"📁 文件: {NEW_MSG_FILE}")
            print(f"⏱️ 耗时: {elapsed:.1f} 秒")
            return 0
            
        except FloodWaitError as e:
            print(f"❌ 触发 Telegram 速率限制，需要等待 {e.seconds} 秒")
            return 1
        except TimeoutError:
            print(f"❌ 执行超时（>{TIMEOUT_SECONDS}秒），请检查网络或稍后重试")
            return 1
        finally:
            signal.alarm(0)  # 取消超时
            await client.disconnect()
            
    except Exception as e:
        print(f"❌ 未预期错误: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    exit_code = asyncio.run(sync_new_messages())
    sys.exit(exit_code)
