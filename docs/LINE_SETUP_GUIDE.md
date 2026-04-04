# LINE 通知系統設定指南

## 📋 前置作業檢查清單

- [ ] 已有 LINE Official Account
- [ ] 已在 LINE Developers Console 建立 Messaging API Channel
- [ ] 已取得 Channel Access Token
- [ ] 已取得 Channel Secret
- [ ] 已部署到 Vercel（或其他生產環境）

## 🚀 設定步驟

### 步驟 1：取得 LINE Credentials

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)

2. 選擇你的 Provider（或建立新的）

3. 建立 **Messaging API Channel**：
   - Channel type: **Messaging API**
   - Provider: 選擇現有或建立新的
   - Channel name: `思考者咖啡通知系統`
   - Channel description: `課程報名與繳費通知`
   - Category: `Education`
   - Subcategory: `Online learning`

4. 建立完成後，取得兩個重要資訊：

   **A. Channel Secret**（Basic settings 頁面）
   ```
   Channel Secret: 像這樣的字串 → abc123def456...
   ```

   **B. Channel Access Token**（Messaging API 頁面）
   - 點擊 "Issue" 按鈕產生 Token
   - 複製產生的 Token
   ```
   Channel Access Token: 長長的字串 → eyJhbGciOiJIUzI1NiIsInR5cCI6...
   ```

### 步驟 2：設定環境變數到 Vercel

使用 Vercel CLI：

```bash
# 1. 安裝 Vercel CLI（如果還沒有）
npm i -g vercel

# 2. 登入
vercel login

# 3. 連結專案（如果還沒有）
vercel link

# 4. 設定環境變數到 production
vercel env add LINE_CHANNEL_ACCESS_TOKEN production
# 貼上你的 Channel Access Token

vercel env add LINE_CHANNEL_SECRET production
# 貼上你的 Channel Secret

# 5. 同步到本地開發環境（Optional）
vercel env pull .env.local
```

或使用 Vercel Dashboard：

1. 前往 [Vercel Dashboard](https://vercel.com/dashboard)
2. 選擇 `thinker-official-website` 專案
3. Settings → Environment Variables
4. 新增以下變數：
   - `LINE_CHANNEL_ACCESS_TOKEN` = `<你的 token>`
   - `LINE_CHANNEL_SECRET` = `<你的 secret>`
5. 選擇 Environment: **Production, Preview, Development**

### 步驟 3：設定 Webhook URL

1. 回到 [LINE Developers Console](https://developers.line.biz/console/)

2. 選擇你的 Channel → Messaging API

3. **Webhook settings** 區塊：
   ```
   Webhook URL: https://www.thinker.cafe/api/line/webhook
   ```

   ⚠️ **重要**：必須使用 `www.thinker.cafe`，不能用 `thinker.cafe`（會 redirect 導致 307 錯誤）

4. 點擊 **Update**

5. 點擊 **Verify** 驗證連線
   - 應該看到 ✅ Success

6. 開啟 **Use webhook**

### 步驟 4：關閉預設自動回覆（重要！）

在 Messaging API → Response settings：

- **Auto-reply messages**: OFF（關閉）
- **Greeting messages**: OFF（關閉）
- **Webhooks**: ON（開啟）

這樣訊息才會送到你的 webhook endpoint，而不是使用 LINE 內建的自動回覆。

### 步驟 5：取得 QR Code

在 Messaging API 頁面：

1. 找到 **Bot basic ID** 或 **QR code**
2. 掃描 QR code 加入好友（用於測試）

### 步驟 6：測試通知

#### 方法 A：測試 Webhook 連線

```bash
curl https://www.thinker.cafe/api/line/webhook
```

應該看到：
```json
{
  "status": "ok",
  "message": "LINE Webhook endpoint is ready"
}
```

⚠️ 注意：必須使用 `www.thinker.cafe`

#### 方法 B：測試繳費提醒通知

需要一個真實的訂單 ID（從 Supabase orders table）：

```bash
curl -X POST https://thinker.cafe/api/line/notify \
  -H "Content-Type: application/json" \
  -d '{
    "type": "payment_reminder",
    "orderId": 123
  }'
```

如果成功，你的 LINE 帳號應該會收到一則通知訊息！

#### 方法 C：透過現有的 Email API 測試

```bash
curl -X POST https://thinker.cafe/api/email/send-payment-reminder \
  -H "Content-Type: application/json" \
  -d '{"orderId": 123}'
```

這會同時發送 Email 和 LINE 通知。

## 🔍 除錯

### 問題 1：Webhook 驗證失敗

**症狀**：LINE Console 顯示 "Webhook verification failed"

**解決方法**：
1. 確認使用正確的 URL：`https://www.thinker.cafe/api/line/webhook`（必須有 `www`）
2. 檢查 Vercel 部署是否成功
3. 檢查環境變數是否已設定
4. 查看 Vercel Logs：
   ```bash
   vercel logs --follow
   ```

### 問題 2：通知沒有收到

**症狀**：API 返回成功，但 LINE 沒收到訊息

**除錯步驟**：

1. 確認用戶有 `line_user_id`：
   ```sql
   SELECT user_id, line_user_id, full_name
   FROM profiles
   WHERE user_id = '<user_id>';
   ```

2. 確認 `line_user_id` 格式正確（應該以 'U' 開頭）

3. 確認該用戶已加入 LINE Bot 好友

4. 查看 Vercel Logs：
   ```bash
   vercel logs --filter "LINE" --follow
   ```

5. 測試 LINE Bot 連線：
   ```bash
   # 使用 LINE Bot SDK 測試
   curl -X POST https://api.line.me/v2/bot/message/push \
     -H "Authorization: Bearer <YOUR_CHANNEL_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "to": "<USER_LINE_ID>",
       "messages": [{
         "type": "text",
         "text": "Test message"
       }]
     }'
   ```

### 問題 3：環境變數沒生效

**症狀**：`LINE_CHANNEL_ACCESS_TOKEN is not set` 錯誤

**解決方法**：
1. 確認環境變數已設定：
   ```bash
   vercel env ls
   ```

2. 觸發重新部署：
   ```bash
   git commit --allow-empty -m "chore: redeploy"
   git push
   ```

3. 或在 Vercel Dashboard 手動 Redeploy

## 📊 監控

### 查看 LINE 通知歷史

```bash
# 即時查看 Logs
vercel logs --follow

# 只看 LINE 相關
vercel logs --filter "LINE"

# 只看錯誤
vercel logs --filter "error" --filter "LINE"
```

### 檢查 LINE Bot 用量

LINE Developers Console → Statistics：
- 發送訊息數量
- 加入好友數
- 封鎖數

## ✅ 設定完成檢查

- [ ] Webhook URL 已設定並驗證成功
- [ ] 環境變數已設定到 Vercel Production
- [ ] 自動回覆已關閉
- [ ] Webhooks 已開啟
- [ ] 已用自己的 LINE 帳號測試收到通知
- [ ] Vercel Logs 沒有錯誤訊息

## 🎉 下一步

設定完成後，系統會自動：

1. **報名時**：發送訂單確認（Email + LINE）
2. **繳費提醒**：24 小時內未繳費，發送提醒（Email + LINE）
3. **繳費成功**：確認收款後，發送成功通知（LINE）

## 📚 參考資料

- [LINE Messaging API 文件](https://developers.line.biz/en/docs/messaging-api/)
- [Webhook 事件](https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects)
- [Flex Message Simulator](https://developers.line.biz/flex-simulator/)
- [系統 README](../lib/line/README.md)
