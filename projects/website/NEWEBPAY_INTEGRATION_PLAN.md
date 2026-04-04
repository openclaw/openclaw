# 藍新金流整合計畫（7 天準備期）

> **狀態**：等待商家審核中（預計 7 個工作天）
> **目標**：審核通過後 24 小時內完成上線

---

## 📅 時程規劃

### Week 1: 審核期準備（Day 1-7）

#### Day 1-2: 技術架構準備 ✅
- [x] 研究藍新金流 API 文件
- [ ] 建立 API 路由結構
- [ ] 設計資料庫 Schema 更新
- [ ] 撰寫技術文件

#### Day 3-4: 程式碼開發
- [ ] 實作藍新金流 SDK/Helper
- [ ] 建立付款頁面元件
- [ ] 實作 Webhook 處理
- [ ] 更新訂單狀態流程

#### Day 5: 測試環境設定
- [ ] 取得藍新測試商店帳號
- [ ] 設定測試環境變數
- [ ] 建立測試用例

#### Day 6: 整合測試
- [ ] 測試信用卡付款流程
- [ ] 測試 ATM 虛擬帳號
- [ ] 測試超商代碼
- [ ] 測試 Webhook 回調

#### Day 7: 文件與部署準備
- [ ] 撰寫部署文件
- [ ] 準備環境變數清單
- [ ] 建立上線檢查清單

### Week 2: 正式上線（審核通過後）

#### Day 8: 正式環境設定
- [ ] 取得正式 API 金鑰
- [ ] 設定 Vercel 環境變數
- [ ] 部署到 production

#### Day 9: 監控與優化
- [ ] 監控付款成功率
- [ ] 收集用戶反饋
- [ ] 調整 UX

---

## 🏗 技術架構設計

### 1. 資料庫 Schema 更新

#### orders 資料表新增欄位

```sql
-- 新增付款方式欄位
ALTER TABLE orders
ADD COLUMN payment_method VARCHAR(20) DEFAULT 'bank_transfer';
-- 可能值: 'credit_card', 'atm', 'cvs', 'bank_transfer'

-- 新增藍新交易編號
ALTER TABLE orders
ADD COLUMN newebpay_trade_no VARCHAR(50);

-- 新增付款時間
ALTER TABLE orders
ADD COLUMN paid_at TIMESTAMP WITH TIME ZONE;

-- 新增 ATM 虛擬帳號資訊（JSON）
ALTER TABLE orders
ADD COLUMN atm_info JSONB;
-- 格式: {"bank_code": "007", "account": "99912345678901", "expire_at": "2025-11-03T23:59:59Z"}

-- 新增超商代碼資訊（JSON）
ALTER TABLE orders
ADD COLUMN cvs_info JSONB;
-- 格式: {"code": "A12345678", "expire_at": "2025-11-03T23:59:59Z"}
```

#### 訂單狀態流程更新

```
舊流程:
created → payed → messaged → confirmed

新流程:
created (已建立)
  ↓
pending_payment (待付款) ← 選擇付款方式後
  ↓
paid (已付款) ← 藍新回調成功
  ↓
confirmed (已確認)
```

---

## 📁 檔案結構規劃

```
thinker_official_website/
├── lib/
│   └── newebpay/
│       ├── index.ts              # 主要 SDK
│       ├── crypto.ts             # 加密解密工具
│       ├── types.ts              # TypeScript 型別定義
│       └── constants.ts          # 常數定義
│
├── app/
│   └── api/
│       └── payment/
│           ├── newebpay/
│           │   ├── create/route.ts        # 建立付款
│           │   ├── callback/route.ts      # 付款回調 (NotifyURL)
│           │   └── return/route.ts        # 付款返回 (ReturnURL)
│           └── query/
│               └── route.ts               # 查詢交易狀態
│
├── app/
│   └── order/
│       └── [order_id]/
│           ├── PaymentMethodSelector.tsx  # 付款方式選擇器
│           ├── CreditCardPayment.tsx      # 信用卡付款元件
│           ├── ATMPayment.tsx             # ATM 虛擬帳號元件
│           └── CVSPayment.tsx             # 超商代碼元件
│
└── .env
    ├── NEWEBPAY_MERCHANT_ID              # 商店代號
    ├── NEWEBPAY_HASH_KEY                 # HashKey
    ├── NEWEBPAY_HASH_IV                  # HashIV
    └── NEWEBPAY_API_URL                  # API 網址（測試/正式）
```

---

## 🔑 藍新金流 API 重點整理

### 付款方式支援

| 付款方式 | 參數名稱 | 手續費 | 即時性 | 推薦度 |
|---------|---------|-------|--------|--------|
| 信用卡 | CREDIT | 2.8% | ✅ 即時 | ⭐⭐⭐⭐⭐ |
| ATM 轉帳 | VACC | NT$10/筆 | ❌ 非即時 | ⭐⭐⭐⭐ |
| 超商代碼 | CVS | NT$25/筆 | ❌ 非即時 | ⭐⭐⭐⭐ |
| WebATM | WEBATM | NT$10/筆 | ✅ 即時 | ⭐⭐⭐ |

### 必要參數

```typescript
interface NewebPayRequest {
  MerchantID: string;        // 商店代號
  RespondType: 'JSON';       // 回傳格式
  TimeStamp: string;         // Unix timestamp
  Version: '2.0';            // API 版本
  MerchantOrderNo: string;   // 商店訂單編號（order_id）
  Amt: number;               // 訂單金額
  ItemDesc: string;          // 商品描述
  Email: string;             // 付款人 Email
  NotifyURL: string;         // 付款完成通知網址
  ReturnURL: string;         // 付款完成返回網址

  // 付款方式啟用
  CREDIT: 0 | 1;             // 信用卡
  VACC: 0 | 1;               // ATM
  CVS: 0 | 1;                // 超商代碼
}
```

### 加密流程

```typescript
// 1. 組合查詢字串
const queryString = `MerchantID=${data.MerchantID}&RespondType=${data.RespondType}&...`;

// 2. AES 加密
const encrypted = aesEncrypt(queryString, HASH_KEY, HASH_IV);

// 3. 生成 SHA256 檢查碼
const checkValue = sha256(`HashKey=${HASH_KEY}&${encrypted}&HashIV=${HASH_IV}`);

// 4. 送出表單
const formData = {
  MerchantID: MERCHANT_ID,
  TradeInfo: encrypted,
  TradeSha: checkValue,
  Version: '2.0'
};
```

---

## 🧪 測試計畫

### 測試環境資訊

- **測試 API URL**: `https://ccore.newebpay.com/MPG/mpg_gateway`
- **測試商店代號**: （審核通過後取得）
- **測試信用卡號**: `4000-2211-1111-1111`

### 測試案例

#### TC-001: 信用卡付款（即時）
1. 學員選擇課程並填寫資料
2. 選擇「信用卡付款」
3. 跳轉藍新付款頁面
4. 輸入測試卡號完成付款
5. 返回網站，訂單狀態更新為「已付款」

#### TC-002: ATM 虛擬帳號（非即時）
1. 學員選擇「ATM 轉帳」
2. 系統顯示虛擬帳號資訊
3. 模擬轉帳完成
4. Webhook 接收通知
5. 訂單狀態更新為「已付款」

#### TC-003: 超商代碼（非即時）
1. 學員選擇「超商繳費」
2. 系統顯示繳費代碼
3. 模擬超商繳費
4. Webhook 接收通知
5. 訂單狀態更新為「已付款」

#### TC-004: 付款失敗處理
1. 輸入錯誤卡號
2. 系統顯示錯誤訊息
3. 訂單保持「待付款」狀態
4. 學員可重新嘗試

#### TC-005: 付款逾期處理
1. ATM/超商繳費超過期限
2. 系統自動取消訂單
3. 通知學員重新報名

---

## 🔒 安全性檢查清單

- [ ] API 金鑰存放在環境變數，不 commit 到 Git
- [ ] Webhook 驗證簽章
- [ ] 訂單金額二次驗證（前端 + 後端）
- [ ] 防止重複付款
- [ ] Log 所有交易記錄
- [ ] 敏感資料加密儲存

---

## 📊 監控指標

### 上線後追蹤數據

1. **付款成功率**
   - 總訂單數
   - 付款成功數
   - 付款失敗數
   - 放棄付款數

2. **各付款方式使用率**
   - 信用卡: ?%
   - ATM: ?%
   - 超商: ?%
   - 轉帳: ?%

3. **平均完成時間**
   - 從選課到付款完成的時間

4. **金流手續費成本**
   - 每月總手續費
   - 占營收比例

---

## 🚀 上線檢查清單

### 部署前

- [ ] 所有測試案例通過
- [ ] 正式環境變數已設定
- [ ] Webhook URL 可公開存取
- [ ] 資料庫 Migration 已執行
- [ ] GA4 電商追蹤已整合

### 部署後

- [ ] 完成一筆真實交易測試
- [ ] 確認 Webhook 正常運作
- [ ] 確認訂單狀態更新正常
- [ ] 確認 Email 通知正常
- [ ] 監控 Error Log

---

## 📞 藍新金流聯絡資訊

- **客服電話**: 02-2655-8688
- **客服信箱**: service@newebpay.com
- **技術文件**: https://www.newebpay.com/website/Page/content/download_api
- **商家管理後台**: https://cwww.newebpay.com

---

## 💡 常見問題

### Q1: 測試環境和正式環境的差異？
- API URL 不同
- 商店代號不同
- HashKey/HashIV 不同
- 測試環境可用測試卡號

### Q2: Webhook 如何驗證？
```typescript
// 驗證流程
const receivedSha = req.body.TradeSha;
const decrypted = aesDecrypt(req.body.TradeInfo, HASH_KEY, HASH_IV);
const calculatedSha = sha256(`HashKey=${HASH_KEY}&${req.body.TradeInfo}&HashIV=${HASH_IV}`);

if (receivedSha !== calculatedSha) {
  throw new Error('Invalid signature');
}
```

### Q3: 如何處理重複通知？
使用 `newebpay_trade_no` 作為唯一鍵，避免重複處理同一筆交易。

---

**建立日期**: 2025-11-02
**最後更新**: 2025-11-02
**負責人**: Claude
**狀態**: 📝 規劃中
