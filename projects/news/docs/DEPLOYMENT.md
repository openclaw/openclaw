# LINE Bot Webhook 部署指南

## 前置準備

### 1. 取得 LINE Bot 憑證

前往 [LINE Developers Console](https://developers.line.biz/console/)

1. 選擇你的 LINE Bot Channel
2. 在 **Messaging API** 分頁中找到：
   - `Channel access token` (長期有效的 token)
   - `Channel secret`

### 2. Vercel 帳號

確認已經登入 Vercel 帳號。

---

## 部署步驟

### 方法 1: 使用 Vercel CLI（推薦）

```bash
# 1. 進入專案目錄
cd /Users/thinkercafe/Documents/thinker-news

# 2. 部署到 Vercel（會自動創建專案）
vercel --prod

# 3. 設定環境變數
vercel env add LINE_CHANNEL_ACCESS_TOKEN production
# 貼上你的 LINE Channel Access Token

vercel env add LINE_CHANNEL_SECRET production
# 貼上你的 LINE Channel Secret

# 4. 重新部署（套用環境變數）
vercel --prod
```

### 方法 2: 使用 Vercel Dashboard

1. 前往 [Vercel Dashboard](https://vercel.com/dashboard)
2. 點擊 **Add New Project**
3. 選擇 **Import Git Repository** 並選擇 `thinker-news` repo
4. 在 **Environment Variables** 設定：
   - `LINE_CHANNEL_ACCESS_TOKEN` = `你的 token`
   - `LINE_CHANNEL_SECRET` = `你的 secret`
5. 點擊 **Deploy**

---

## 設定 LINE Webhook URL

部署完成後，你會得到一個 Vercel URL，例如：

```
https://thinker-news.vercel.app
```

### 設定步驟：

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 選擇你的 Bot Channel
3. 進入 **Messaging API** 分頁
4. 設定 **Webhook URL**：

   ```
   https://thinker-news.vercel.app/api/line-webhook
   ```

5. 點擊 **Verify** 確認 webhook 正常
6. 開啟 **Use webhook** 選項

---

## 測試

### 1. 健康檢查

```bash
curl https://thinker-news.vercel.app/api/line-webhook
```

預期回應：
```json
{
  "status": "ok",
  "message": "LINE Bot Webhook is running"
}
```

### 2. LINE 測試

在 LINE 中加入你的 Bot，發送以下任一關鍵字：

- `/news`
- `新聞`
- `news`
- `今日新聞`
- `每日新聞`

Bot 應該會回覆當日新聞內容。

---

## 驗證部署

檢查項目清單：

- [ ] Vercel 部署成功
- [ ] 環境變數已設定 (LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET)
- [ ] 健康檢查 API 回應正常
- [ ] LINE Webhook URL 設定正確
- [ ] LINE Webhook 驗證通過
- [ ] Bot 能正確回應測試關鍵字

---

## 常見問題

### Q: Bot 沒有回應

**檢查項目**:
1. Vercel 函數是否正常運作（查看 Vercel Dashboard > Functions 日誌）
2. 環境變數是否正確設定
3. LINE Webhook URL 是否正確
4. LINE Webhook 是否已開啟

### Q: 回應 403 Invalid signature

**原因**: `LINE_CHANNEL_SECRET` 設定錯誤

**解決方案**:
```bash
vercel env rm LINE_CHANNEL_SECRET production
vercel env add LINE_CHANNEL_SECRET production
vercel --prod
```

### Q: 回應 500 Internal Server Error

**檢查**:
1. Vercel Functions 日誌（Vercel Dashboard > Functions > Logs）
2. `latest.json` 是否正確生成並上傳到 GitHub

---

## 監控

### Vercel Dashboard

查看即時日誌：
1. 前往 [Vercel Dashboard](https://vercel.com/dashboard)
2. 選擇 `thinker-news` 專案
3. 點擊 **Functions** 標籤
4. 選擇 `api/line-webhook.py`
5. 查看 **Logs**

### LINE Developers Console

查看 webhook 狀態：
1. [LINE Developers Console](https://developers.line.biz/console/)
2. 選擇 Bot Channel
3. **Messaging API** > **Webhook settings**
4. 查看最後驗證時間和狀態

---

## 更新部署

當你修改程式碼後：

```bash
# 推送到 GitHub
git add .
git commit -m "Update LINE webhook logic"
git push

# 如果是 GitHub integration，Vercel 會自動部署
# 或手動部署：
vercel --prod
```

---

## 回滾到 n8n（緊急情況）

如果 Vercel 部署有問題，可以暫時切回 n8n：

1. 在 LINE Developers Console 將 Webhook URL 改回 n8n 的 URL
2. 確認 n8n workflow 仍在運行
3. 調查 Vercel 部署問題
4. 修正後再切回 Vercel

原始 n8n workflow 備份在：`docs/n8n_workflows/LINE自動發消息.json`
