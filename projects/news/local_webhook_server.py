#!/usr/bin/env python3
"""
本地 LINE webhook 測試伺服器
配合 ngrok 使用
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os
import urllib.request
import urllib.error
import hashlib
import hmac
import base64
from dotenv import load_dotenv

# 載入環境變數
load_dotenv()

class LineWebhookHandler(BaseHTTPRequestHandler):

    def do_POST(self):
        """處理 LINE Webhook POST 請求"""
        print("\n" + "="*60)
        print("🔔 收到 LINE Webhook 請求！")
        print("="*60)

        try:
            # 讀取請求內容
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            print(f"📦 請求大小: {len(body)} bytes")
            print(f"📋 Headers:")
            for header, value in self.headers.items():
                print(f"   {header}: {value}")

            # 驗證 LINE 簽名
            signature = self.headers.get('X-Line-Signature', '')
            print(f"\n🔐 簽名驗證:")
            print(f"   收到的簽名: {signature[:30]}..." if signature else "   ⚠️  沒有簽名")

            if not self.verify_signature(body, signature):
                print("❌ 簽名驗證失敗！")
                self.send_error(403, "Invalid signature")
                return

            print("✅ 簽名驗證通過")

            # 解析請求
            webhook_data = json.loads(body.decode('utf-8'))
            print(f"\n📨 Webhook 內容:")
            print(json.dumps(webhook_data, indent=2, ensure_ascii=False))

            # 處理事件
            events_processed = 0
            for event in webhook_data.get('events', []):
                if event['type'] == 'message' and event['message']['type'] == 'text':
                    print(f"\n💬 處理文字訊息:")
                    print(f"   用戶訊息: {event['message']['text']}")
                    print(f"   Reply Token: {event['replyToken']}")

                    self.handle_text_message(event)
                    events_processed += 1

            print(f"\n✅ 處理了 {events_processed} 個事件")

            # 回應成功
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())

        except Exception as e:
            print(f"\n❌ 錯誤: {str(e)}")
            import traceback
            traceback.print_exc()
            self.send_error(500, f"Internal server error: {str(e)}")

    def do_GET(self):
        """處理 GET 請求（健康檢查）"""
        print("\n✅ 收到健康檢查請求")
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            'status': 'ok',
            'message': 'LINE Bot Webhook is running locally'
        }).encode())

    def verify_signature(self, body, signature):
        """驗證 LINE 簽名"""
        channel_secret = os.environ.get('LINE_CHANNEL_SECRET', '')
        if not channel_secret:
            print("⚠️  警告: LINE_CHANNEL_SECRET 未設定")
            return True  # 開發階段可以暫時跳過驗證

        hash_digest = hmac.new(
            channel_secret.encode('utf-8'),
            body,
            hashlib.sha256
        ).digest()

        expected_signature = base64.b64encode(hash_digest).decode('utf-8')

        print(f"   預期的簽名: {expected_signature[:30]}...")
        print(f"   簽名匹配: {signature == expected_signature}")

        return signature == expected_signature

    def handle_text_message(self, event):
        """處理文字訊息"""
        user_message = event['message']['text'].strip().lower()

        # 觸發關鍵字
        trigger_keywords = ['/news', '新聞', 'news', '今日新聞', '每日新聞']

        print(f"   檢查關鍵字: {trigger_keywords}")

        if any(keyword in user_message for keyword in trigger_keywords):
            print(f"   ✅ 匹配到關鍵字！")

            # 從 GitHub 拉取最新新聞
            print(f"\n📰 拉取新聞...")
            news_content = self.fetch_latest_news()

            if news_content:
                print(f"   ✅ 成功拉取新聞")
                print(f"   新聞長度: {len(news_content)} 字元")
                print(f"\n預覽:")
                print(news_content[:200] + "...")

                # 發送新聞到 LINE
                self.send_line_message(
                    event['replyToken'],
                    news_content
                )
            else:
                print(f"   ❌ 拉取新聞失敗")
                self.send_line_message(
                    event['replyToken'],
                    "抱歉，目前無法獲取新聞內容，請稍後再試。"
                )
        else:
            print(f"   ⚠️  沒有匹配到關鍵字")

    def fetch_latest_news(self):
        """從 GitHub 拉取最新新聞 JSON"""
        try:
            github_url = "https://raw.githubusercontent.com/ThinkerCafe-tw/thinker-news/main/latest.json"

            with urllib.request.urlopen(github_url, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))

                # 組裝回覆訊息
                message = self.format_news_message(data)
                return message

        except Exception as e:
            print(f"   ❌ 拉取新聞錯誤: {str(e)}")
            return None

    def format_news_message(self, data):
        """格式化新聞訊息"""
        try:
            # 直接使用 line_content 欄位（與 n8n 相同）
            line_content = data.get('line_content', '')
            website_url = data.get('website_url', '')
            generated_at = data.get('generated_at', '')

            if not line_content:
                return "抱歉，新聞內容為空。"

            # 組裝最終訊息（與 n8n 相同格式）
            final_text = f"{line_content}\n\n🔗 完整內容：{website_url}"

            if generated_at:
                # 格式化時間：取前 16 字元並替換 T 為空格
                formatted_time = generated_at[:16].replace('T', ' ')
                final_text += f"\n\n⏰ 更新時間：{formatted_time}"

            return final_text

        except Exception as e:
            print(f"   ❌ 格式化錯誤: {str(e)}")
            return "抱歉，新聞格式化失敗。"

    def send_line_message(self, reply_token, message):
        """發送 LINE 訊息"""
        try:
            print(f"\n📤 發送 LINE 訊息...")
            print(f"   Reply Token: {reply_token}")
            print(f"   訊息長度: {len(message)} 字元")

            channel_access_token = os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '')
            if not channel_access_token:
                print("   ❌ LINE_CHANNEL_ACCESS_TOKEN 未設定")
                return

            url = "https://api.line.me/v2/bot/message/reply"

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {channel_access_token}'
            }

            payload = {
                'replyToken': reply_token,
                'messages': [
                    {
                        'type': 'text',
                        'text': message
                    }
                ]
            }

            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers=headers,
                method='POST'
            )

            with urllib.request.urlopen(req, timeout=10) as response:
                print(f"   ✅ LINE 訊息發送成功: {response.status}")

        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            print(f"   ❌ LINE API 錯誤: {e.code} - {error_body}")
        except Exception as e:
            print(f"   ❌ 發送錯誤: {str(e)}")

    def log_message(self, format, *args):
        """覆寫日誌方法，減少內建日誌"""
        pass

if __name__ == '__main__':
    PORT = 8888

    print("="*60)
    print("🚀 啟動本地 LINE Webhook 伺服器")
    print("="*60)
    print(f"   監聽端口: {PORT}")
    print(f"   本地 URL: http://localhost:{PORT}")
    print()
    print("📋 下一步:")
    print("   1. 啟動 ngrok: ngrok http 8000")
    print("   2. 複製 ngrok 的 HTTPS URL")
    print("   3. 在 LINE Developers Console 設定 Webhook URL")
    print("   4. 在 LINE 發送訊息測試")
    print()
    print("按 Ctrl+C 停止伺服器")
    print("="*60)
    print()

    server = HTTPServer(('0.0.0.0', PORT), LineWebhookHandler)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\n👋 伺服器已停止")
        server.shutdown()
