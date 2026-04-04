# 🚀 Google Analytics 4 快速設定指南

## ✅ 已完成的設定

1. ✅ 安裝 `@next/third-parties` 套件
2. ✅ 建立 `GoogleAnalytics` 元件
3. ✅ 建立追蹤函式庫 (`lib/analytics.ts`)
4. ✅ 整合到 `app/layout.tsx`
5. ✅ 更新環境變數檔案

---

## 📝 你需要做的事(5分鐘)

### Step 1: 建立 Google Analytics 4 帳號

1. **前往 Google Analytics**
   - 網址: https://analytics.google.com/
   - 使用你的 Google 帳號登入

2. **建立新屬性**
   - 點擊左下角「管理」
   - 點擊「建立屬性」
   - 屬性名稱: `Thinker Cafe 官網`
   - 時區: `台灣 (GMT+8)`
   - 貨幣: `新台幣 (TWD)`

3. **設定資料串流**
   - 選擇「網站」
   - 網站網址: `https://你的網域.com` (或先用 `http://localhost:3000` 測試)
   - 串流名稱: `Thinker Cafe Website`
   - 點擊「建立串流」

4. **複製 Measurement ID**
   - 格式: `G-XXXXXXXXXX`
   - 這個 ID 會顯示在資料串流詳細資料頁面

### Step 2: 設定環境變數

在 `.env` 檔案中,找到這一行:

```env
NEXT_PUBLIC_GA_MEASUREMENT_ID=
```

將你的 Measurement ID 貼上:

```env
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

### Step 3: 在 Vercel 設定環境變數

如果你的網站部署在 Vercel:

1. 前往 Vercel Dashboard
2. 選擇你的專案
3. Settings → Environment Variables
4. 新增:
   - Key: `NEXT_PUBLIC_GA_MEASUREMENT_ID`
   - Value: `G-XXXXXXXXXX`
   - Environment: Production, Preview, Development (全選)
5. 重新部署

### Step 4: 測試

```bash
# 啟動開發伺服器
pnpm dev

# 打開瀏覽器
# http://localhost:3000
```

**測試步驟**:
1. 開啟瀏覽器開發者工具 (F12)
2. 前往 Network 分頁
3. 過濾 `google-analytics` 或 `gtag`
4. 重新整理頁面
5. 應該會看到追蹤請求

**即時查看**:
1. 前往 Google Analytics
2. 報表 → 即時報表
3. 應該會看到你自己在線上!

---

## 🎯 預設已追蹤的項目

開箱即用,以下項目會自動追蹤:

- ✅ **頁面瀏覽** - 所有頁面自動追蹤
- ✅ **使用者數量** - 即時/每日/每週
- ✅ **跳出率**
- ✅ **停留時間**
- ✅ **流量來源** - 直接、搜尋、社群媒體等

---

## 📊 進階追蹤(選用)

如果想追蹤更詳細的電子商務數據,請參考 `ANALYTICS_IMPLEMENTATION_EXAMPLES.md` 文件,裡面有:

- 🛒 查看課程 (`trackViewCourse`)
- 🛒 開始報名 (`trackBeginCheckout`)
- 🛒 完成購買 (`trackPurchase`)
- 👤 用戶註冊 (`trackSignUp`)
- 👤 用戶登入 (`trackLogin`)
- 📧 聯絡表單 (`trackContactFormSubmit`)

---

## 🔧 常見問題

### Q: 為什麼 GA4 看不到數據?

**A:** 檢查以下項目:
1. Measurement ID 是否正確貼入 `.env`
2. 環境變數名稱是否為 `NEXT_PUBLIC_GA_MEASUREMENT_ID` (必須以 `NEXT_PUBLIC_` 開頭)
3. 是否重啟開發伺服器
4. 瀏覽器是否安裝廣告阻擋器 (會阻擋 GA)
5. GA4 資料可能延遲 10-30 分鐘,先看「即時報表」

### Q: 需要 Cookie 同意橫幅嗎?

**A:**
- 台灣法規目前沒有強制要求,但建議加入
- 歐盟用戶必須加入 (GDPR)
- 如果有歐盟用戶,請參考 `ANALYTICS_IMPLEMENTATION_EXAMPLES.md` 的 Cookie 同意範例

### Q: 如何在 GA4 看到訂單數據?

**A:**
1. 前往 GA4 → 報表 → 營利
2. 如果看不到,需要在程式碼中加入 `trackPurchase` 事件
3. 參考 `ANALYTICS_IMPLEMENTATION_EXAMPLES.md` 第 3c 節

### Q: Vercel Analytics 和 Google Analytics 要選哪個?

**A:**
- 可以兩個都用!互不衝突
- **Google Analytics**: 適合業務分析、行銷、客戶轉換
- **Vercel Analytics**: 適合技術分析、網站效能、Web Vitals

---

## 📚 延伸閱讀

- [Google Analytics 4 官方文件](https://support.google.com/analytics/answer/9304153)
- [Next.js Third Parties 文件](https://nextjs.org/docs/app/building-your-application/optimizing/third-party-libraries)
- [GA4 電子商務事件](https://developers.google.com/analytics/devguides/collection/ga4/ecommerce)

---

**完成這些步驟後,你的網站就已經有完整的統計追蹤了!** 🎉
