# LINE 通知系統

## 概述

LINE 通知系統用於自動發送課程相關通知給已綁定 LINE 帳號的用戶。

## 架構

```
lib/line/
├── client.js                  # LINE Bot Client 初始化與 Webhook 驗證
├── notify.js                  # 通知服務（各種通知類型）
├── templates/                 # LINE Flex Message 模板
│   ├── paymentReminder.js     # 繳費提醒
│   └── orderConfirmation.js   # 訂單確認
└── README.md                  # 本文件

app/api/line/
├── webhook/route.js           # 接收 LINE Platform 事件
└── notify/route.js            # 內部通知 API
```

## 環境變數設定

在 Vercel 或本地 `.env.local` 中設定：

```bash
# LINE Messaging API
LINE_CHANNEL_ACCESS_TOKEN=<你的 Channel Access Token>
LINE_CHANNEL_SECRET=<你的 Channel Secret>
```

### 取得 LINE Credentials

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 選擇你的 Provider（或建立新的）
3. 建立 Messaging API Channel
4. 在 Channel 設定中取得：
   - **Channel Secret** (Basic settings 頁面)
   - **Channel Access Token** (Messaging API 頁面 → Issue)

## Webhook 設定

### 1. 設定 Webhook URL

在 LINE Developers Console：
1. Messaging API → Webhook settings
2. Webhook URL: `https://thinker.cafe/api/line/webhook`
3. 開啟 "Use webhook"
4. 點擊 "Verify" 驗證連線

### 2. 關閉自動回覆（Optional）

Messaging API → Response settings：
- 關閉 "Greeting message"（加入好友時的自動問候）
- 關閉 "Auto-response message"（關鍵字自動回覆）
- 開啟 "Webhooks"

## 通知類型

### 1. 繳費提醒 (Payment Reminder)

觸發時機：訂單建立後 24 小時內未繳費

```javascript
// 發送方式 1：透過內部 API
POST /api/line/notify
{
  "type": "payment_reminder",
  "orderId": 123
}

// 發送方式 2：透過現有的 email API（會自動發送 LINE 通知）
POST /api/email/send-payment-reminder
{
  "orderId": 123
}

// 發送方式 3：直接呼叫函數
import { sendPaymentReminder } from '@/lib/line/notify';
await sendPaymentReminder(lineUserId, {
  studentName: "學員姓名",
  orderID: "123",
  courseName: "課程名稱",
  amount: 5000,
  expiresAt: 1699999999999,
  paymentURL: "https://thinker.cafe/order/123"
});
```

### 2. 訂單確認 (Order Confirmation)

觸發時機：用戶完成報名表單後

```javascript
POST /api/line/notify
{
  "type": "order_confirmation",
  "orderId": 123
}
```

### 3. 繳費成功 (Payment Success)

觸發時機：確認收到款項後

```javascript
POST /api/line/notify
{
  "type": "payment_success",
  "orderId": 123
}
```

### 4. 課程開課提醒 (Course Start Reminder)

觸發時機：課程開始前 1-3 天

```javascript
POST /api/line/notify
{
  "type": "course_start",
  "orderId": 123
}
```

## 訊息格式

### Flex Message（卡片式訊息）

繳費提醒和訂單確認使用 Flex Message 格式，提供：
- 清晰的視覺層次
- 訂單資訊一目了然
- 行動按鈕（立即繳費、查看訂單）
- 響應式設計

### Text Message（文字訊息）

繳費成功和課程開課提醒使用簡單文字訊息。

## 開發與測試

### 本地測試

1. 安裝依賴：
```bash
pnpm install
```

2. 設定環境變數：
```bash
cp .env.example .env.local
# 編輯 .env.local，加入 LINE credentials
```

3. 啟動開發伺服器：
```bash
pnpm dev
```

4. 使用 ngrok 建立 tunnel（測試 webhook）：
```bash
ngrok http 3000
# 將 ngrok URL 設定到 LINE Developers Console
```

### 測試 Webhook

```bash
# 測試連線
curl https://thinker.cafe/api/line/webhook

# 模擬 webhook 事件（需要正確的 signature）
curl -X POST https://thinker.cafe/api/line/webhook \
  -H "Content-Type: application/json" \
  -H "X-Line-Signature: <signature>" \
  -d '{"events":[]}'
```

### 測試通知 API

```bash
# 繳費提醒
curl -X POST http://localhost:3000/api/line/notify \
  -H "Content-Type: application/json" \
  -d '{"type":"payment_reminder","orderId":123}'

# 訂單確認
curl -X POST http://localhost:3000/api/line/notify \
  -H "Content-Type: application/json" \
  -d '{"type":"order_confirmation","orderId":123}'
```

## 整合流程

### Email + LINE 雙通道通知

現有的 email 通知 API 已整合 LINE 通知：

```typescript
// app/api/email/send-payment-reminder/route.ts

1. 發送 Email（必要）
2. 如果用戶有 line_user_id：
   - 同時發送 LINE 通知
   - 錯誤不影響 Email 發送成功
3. 返回結果包含 lineNotificationSent 標記
```

### 訂單流程整合建議

```javascript
// 1. 用戶完成報名
→ 建立訂單（orders table）
→ 發送訂單確認（Email + LINE）

// 2. 24 小時內未繳費
→ 發送繳費提醒（Email + LINE）

// 3. 收到款項
→ 更新訂單狀態
→ 發送繳費成功（LINE）

// 4. 課程開始前
→ 發送開課提醒（LINE）
```

## 錯誤處理

- Webhook 錯誤：即使處理失敗也返回 200，避免 LINE 重複發送
- 通知失敗：記錄錯誤但不影響主流程（如 Email 發送）
- Signature 驗證失敗：返回 401 Unauthorized

## 安全性

- ✅ Webhook Signature 驗證
- ✅ 環境變數保護（Service Role Key, Channel Secret）
- ✅ 內部 API 需要驗證（TODO: 加入 API Key 或 Supabase Auth）

## 監控與日誌

所有通知都會記錄在 console：
- `✅` 成功發送
- `⚠️` 警告（如 LINE 發送失敗但 Email 成功）
- `❌` 錯誤

建議使用 Vercel Logs 或 Datadog 監控：
```bash
vercel logs --follow
```

## TODO

- [ ] 加入 API Key 驗證 (`/api/line/notify`)
- [ ] 實作 Rich Menu（選單）
- [ ] 實作自動回覆（訂單查詢、課程諮詢）
- [ ] 加入用戶行為追蹤（點擊率、開信率）
- [ ] 建立通知歷史記錄（notifications table）
- [ ] 課程開課提醒自動化（Cron Job）

## 參考資料

- [LINE Messaging API 文件](https://developers.line.biz/en/docs/messaging-api/)
- [Flex Message Simulator](https://developers.line.biz/flex-simulator/)
- [@line/bot-sdk](https://github.com/line/line-bot-sdk-nodejs)
