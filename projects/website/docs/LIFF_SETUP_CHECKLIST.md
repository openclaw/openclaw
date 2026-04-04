# LIFF 設定檢查清單

## 錯誤：400 Bad Request

這個錯誤通常是因為 LIFF Endpoint URL 設定問題。

## 檢查步驟

### 1. 前往 LINE Developers Console

https://developers.line.biz/console/

### 2. 選擇你的 Channel

- Channel Name: ThinkerCafe (或你的 Channel 名稱)
- Channel ID: 2008401529

### 3. 點擊 「LIFF」 分頁

### 4. 檢查 LIFF App 設定

**LIFF ID**: `2008315861-L29vEYpa`

**必須檢查的項目**:

#### Endpoint URL
```
https://thinker.cafe/line-login
```

或

```
https://thinker-official-website-3k9phomnn-cruz-5538s-projects.vercel.app/line-login
```

**重要**:
- ✅ 必須是 HTTPS
- ✅ 必須指向 `/line-login` 路徑
- ✅ 不能有尾部斜線 `/`
- ❌ 不能是 `localhost`

#### Scopes（權限範圍）
- ✅ `profile` - 必須勾選
- ✅ `openid` - 建議勾選
- ⚠️ `email` - 可選（LINE Login 不一定有 email）

#### Botprompt
- 選項：`normal` 或 `aggressive`
- 建議：`normal`

### 5. 儲存設定

點擊「Update」儲存所有變更

### 6. 重新測試

1. 清除 LINE App 快取
2. 重新開啟 LIFF URL
3. 應該能正常顯示登入頁面

## 如果還是 400 錯誤

### 方案 A：使用 Vercel Production URL

1. 取得最新的 Vercel URL：
   ```
   https://thinker-official-website-3k9phomnn-cruz-5538s-projects.vercel.app
   ```

2. 在 LIFF 設定中，Endpoint URL 改為：
   ```
   https://thinker-official-website-3k9phomnn-cruz-5538s-projects.vercel.app/line-login
   ```

### 方案 B：使用自訂域名

如果你有設定 `thinker.cafe`：

```
https://thinker.cafe/line-login
```

## 常見錯誤

### ❌ 錯誤 1：Endpoint URL 有尾部斜線
```
https://thinker.cafe/line-login/  ← 錯誤！
```

應該是：
```
https://thinker.cafe/line-login   ← 正確
```

### ❌ 錯誤 2：使用 HTTP 而非 HTTPS
```
http://thinker.cafe/line-login  ← 錯誤！
```

應該是：
```
https://thinker.cafe/line-login  ← 正確
```

### ❌ 錯誤 3：URL 路徑錯誤
```
https://thinker.cafe/  ← 錯誤！
https://thinker.cafe/login  ← 錯誤！
```

應該是：
```
https://thinker.cafe/line-login  ← 正確
```

## 驗證步驟

設定完成後，在瀏覽器直接開啟 Endpoint URL：

```
https://thinker.cafe/line-login
```

應該會看到：
- ✅ LINE Login 頁面正常顯示
- ✅ 不會出現 404 或 500 錯誤
- ✅ LIFF 開始初始化

## 需要協助？

如果以上步驟都檢查過還是無法解決：

1. 截圖 LIFF 設定頁面
2. 截圖錯誤訊息
3. 檢查瀏覽器 Console 的錯誤訊息
