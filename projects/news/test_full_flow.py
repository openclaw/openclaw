#!/usr/bin/env python3
"""
完整測試 LINE Bot 流程：發送 /news 訊息並檢查回應
"""

import json
import hmac
import hashlib
import base64
import urllib.request
import os
from dotenv import load_dotenv

load_dotenv()

# 模擬 LINE 發送的完整事件（包含 /news 訊息）
webhook_event = {
    "destination": "U123456789abcdef",
    "events": [
        {
            "type": "message",
            "replyToken": "test_reply_token_12345678",
            "source": {
                "userId": "U123456789abcdef",
                "type": "user"
            },
            "timestamp": 1762557900000,
            "mode": "active",
            "message": {
                "type": "text",
                "id": "123456789",
                "text": "/news"
            }
        }
    ]
}

body = json.dumps(webhook_event).encode('utf-8')

# 計算簽名
channel_secret = os.environ.get('LINE_CHANNEL_SECRET', '')
print(f"📝 測試資訊：")
print(f"   Channel Secret: {channel_secret[:10]}...{channel_secret[-5:]}")
print(f"   Body length: {len(body)} bytes")
print(f"   Message text: {webhook_event['events'][0]['message']['text']}")

hash_digest = hmac.new(
    channel_secret.encode('utf-8'),
    body,
    hashlib.sha256
).digest()

signature = base64.b64encode(hash_digest).decode('utf-8')
print(f"   Signature: {signature[:30]}...")

# 發送 POST 請求到 Vercel
url = "https://thinker-news.vercel.app/api/line-webhook"

headers = {
    'Content-Type': 'application/json',
    'X-Line-Signature': signature
}

print(f"\n🚀 發送請求到: {url}")
print(f"   包含觸發關鍵字: /news")

try:
    req = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method='POST'
    )

    with urllib.request.urlopen(req, timeout=30) as response:
        response_data = response.read().decode('utf-8')
        print(f"\n✅ Response Status: {response.status}")
        print(f"✅ Response Body: {response_data}")

        # 檢查是否有錯誤
        if response.status == 200:
            print(f"\n🎉 測試成功！")
            print(f"\n⚠️  注意：由於使用的是測試 replyToken，")
            print(f"   實際回覆訊息到 LINE 會失敗（這是正常的）。")
            print(f"   但 webhook 邏輯本身是正常運作的。")

except urllib.error.HTTPError as e:
    print(f"\n❌ HTTP Error: {e.code} - {e.reason}")
    error_body = e.read().decode('utf-8')
    print(f"   Error Response: {error_body}")
except Exception as e:
    print(f"\n❌ Error: {str(e)}")

print("\n" + "="*60)
print("如果看到 200 OK，表示 webhook 正常工作。")
print("實際使用時，當真實用戶在 LINE 發送 /news，")
print("Bot 會用真實的 replyToken 回覆新聞內容。")
