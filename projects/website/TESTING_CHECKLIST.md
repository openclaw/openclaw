# GA4 追蹤與禮包頁面測試清單

## 📋 測試日期：2025-11-05

### ✅ 已完成的改動
- [x] 首頁加入 `click_explore_courses` 追蹤
- [x] 課程卡片加入 `view_item` 追蹤
- [x] 報名按鈕加入 `add_to_cart` 追蹤
- [x] 報名表單加入 `begin_checkout` + `purchase` 追蹤
- [x] 禮包頁面更新課程資訊
- [x] 禮包頁面加入 URL 參數功能
- [x] 建立報名人數 API

---

## 🧪 測試項目

### 1. GA4 追蹤事件測試

#### 1.1 首頁「探索課程」按鈕
- [ ] 打開 http://localhost:3000
- [ ] 打開 DevTools → Console
- [ ] 執行：`console.log(typeof gtag)`（應該顯示 "function"）
- [ ] 點擊「探索課程」按鈕
- [ ] Network 分頁看到 `click_explore_courses` 事件
- [ ] 成功導向課程列表頁

**預期事件資料**：
```json
{
  "event": "click_explore_courses",
  "source": "hero_section",
  "location": "homepage_top"
}
```

#### 1.2 課程卡片點擊
- [ ] 在課程列表點擊「AI 自媒體工作流實戰營」
- [ ] Network 分頁看到 `view_item` 事件
- [ ] 事件包含課程 ID、名稱、分類、價格
- [ ] 成功導向課程詳情頁

**預期事件資料**：
```json
{
  "event": "view_item",
  "currency": "TWD",
  "value": 10000,
  "items": [{
    "item_id": "6",
    "item_name": "AI 自媒體工作流實戰營",
    "item_category": "實戰課程",
    "price": 10000
  }]
}
```

#### 1.3 「立即報名」按鈕
- [ ] 在課程詳情頁點擊「立即報名」
- [ ] Network 分頁看到 `add_to_cart` 事件
- [ ] 事件包含課程資訊和方案（預設團班）
- [ ] 成功導向報名表單頁

**預期事件資料**：
```json
{
  "event": "add_to_cart",
  "currency": "TWD",
  "value": 10000,
  "items": [{
    "item_id": "6",
    "item_name": "AI 自媒體工作流實戰營",
    "item_category": "實戰課程",
    "item_variant": "小班制",
    "price": 10000
  }]
}
```

#### 1.4 報名表單提交
- [ ] 在報名表單選擇課程和方案
- [ ] 點擊「確認報名」
- [ ] Network 分頁看到 `begin_checkout` 事件
- [ ] 訂單建立後看到 `purchase` 事件
- [ ] 成功導向訂單頁面

**預期事件資料 1 - begin_checkout**：
```json
{
  "event": "begin_checkout",
  "currency": "TWD",
  "value": 10000,
  "items": [{ ... }]
}
```

**預期事件資料 2 - purchase**：
```json
{
  "event": "purchase",
  "transaction_id": "訂單UUID",
  "currency": "TWD",
  "value": 10000,
  "items": [{ ... }]
}
```

---

### 2. 禮包頁面功能測試

#### 2.1 URL 參數自動導流
- [ ] 打開：`file:///.../gift-fortune.html?gift=efficiency`
- [ ] 應該跳過驗證頁面，直接進入「AI 效率淘金包」
- [ ] 打開：`file:///.../gift-fortune.html?gift=content`
- [ ] 應該進入「AI 內容印鈔機」
- [ ] 打開：`file:///.../gift-fortune.html?gift=decision`
- [ ] 應該進入「AI 決策智囊團」
- [ ] 打開：`file:///.../gift-fortune.html`（無參數）
- [ ] 應該顯示驗證頁面

#### 2.2 GA4 整合
- [ ] 在禮包頁面 Console 執行：`console.log(typeof gtag)`
- [ ] 應該顯示 "function"（表示 GA4 已載入）
- [ ] 執行：`console.log(window.dataLayer.length)`
- [ ] 應該 > 0（表示有事件）

#### 2.3 課程資訊更新
- [ ] 完成禮包流程後點擊「立即報名」
- [ ] 應該導向：`https://www.thinker.cafe/products/28805e9d-e121-807a-a596-f976e32ae474`
- [ ] 課程名稱應該是「AI 自媒體工作流實戰營」
- [ ] 價格應該是「限時優惠 NT$ 10,000」
- [ ] 課程資訊應該顯示「11/29, 12/6, 12/13 (六)」

#### 2.4 即時報名人數
- [ ] 完成禮包流程到「立即報名」CTA
- [ ] 檢查是否有顯示「🔥 已有 X 位學員報名」
- [ ] 如果報名人數 < 5，應該不顯示
- [ ] 在 Console 檢查：`document.getElementById('enrollment-count').classList.contains('hidden')`

---

### 3. 報名人數 API 測試

#### 3.1 數字 ID 格式
```bash
curl "http://localhost:3000/api/enrollment-count?course_id=6"
```
**預期回應**：
```json
{ "count": 0 }
```

#### 3.2 UUID 格式
```bash
curl "http://localhost:3000/api/enrollment-count?course_id=28805e9d-e121-807a-a596-f976e32ae474"
```
**預期回應**：
```json
{ "count": 0 }
```

#### 3.3 錯誤處理
```bash
curl "http://localhost:3000/api/enrollment-count"
```
**預期回應**：
```json
{ "error": "Missing course_id parameter" }
```

---

## 🐛 已知問題

### 問題 1：API 回應超時
- **現象**：報名人數 API 回應時間 > 5 秒
- **影響**：禮包頁面載入時可能看不到即時人數
- **解決方式**：已加入容錯處理，API 失敗不影響頁面顯示

### 問題 2：首頁改為 Client Component
- **現象**：首頁從 Server Component 改為 Client Component
- **影響**：可能影響首次載入速度和 SEO
- **待驗證**：Lighthouse 分數是否下降

---

## 📊 GA4 即時報表驗證

測試完成後，前往 Google Analytics 驗證：

1. 登入 [Google Analytics](https://analytics.google.com/)
2. 選擇資源（G-9WV2YC6165）
3. 前往「報表」→「即時」
4. 應該看到以下事件：
   - ✓ page_view
   - ✓ click_explore_courses
   - ✓ view_item
   - ✓ add_to_cart
   - ✓ begin_checkout
   - ✓ purchase

---

## ✅ 測試完成標準

- [ ] 所有 GA4 事件都能正確發送
- [ ] Network 分頁看到 5+ 個 collect 請求
- [ ] GA4 即時報表看到所有事件
- [ ] 禮包頁面 URL 參數功能正常
- [ ] 報名人數 API 回應正常
- [ ] 無 Console 錯誤
- [ ] 轉換漏斗完整無斷點

---

## 📝 測試結果記錄

**測試人員**：_________________
**測試日期**：_________________
**測試環境**：Local (http://localhost:3000)

**測試結果**：
- GA4 追蹤：[ ] 通過 [ ] 失敗
- 禮包頁面：[ ] 通過 [ ] 失敗
- API 功能：[ ] 通過 [ ] 失敗

**備註**：
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
