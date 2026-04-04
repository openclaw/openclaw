# Email 通知系統設定指南

> **使用方案**: Resend
> **為什麼選 Resend**: 免費額度 3,000 封/月、設定簡單、支援 React Email、專為開發者設計

---

## 📦 安裝步驟

### 1. 安裝 Resend 套件

```bash
pnpm add resend react-email @react-email/components
```

### 2. 取得 Resend API Key

1. 前往 https://resend.com/signup
2. 註冊帳號（可用 GitHub 快速登入）
3. 前往 API Keys 頁面
4. 建立新的 API Key
5. 複製 API Key（格式: `re_xxxxx`）

### 3. 設定環境變數

在 `.env` 新增：

```bash
# Resend Email Service
RESEND_API_KEY=re_xxxxx
RESEND_FROM_EMAIL=noreply@thinker.cafe
```

⚠️ **重要**：
- `RESEND_FROM_EMAIL` 需要驗證網域
- 開發階段可以使用 `onboarding@resend.dev`（測試用）
- 正式環境必須驗證自己的網域

### 4. 驗證網域（選填，正式環境必做）

1. 在 Resend 後台點選 "Domains"
2. 新增網域 `thinker.cafe`
3. 依照指示設定 DNS 記錄（SPF, DKIM, DMARC）
4. 等待驗證完成（通常 5-30 分鐘）

---

## 📁 檔案結構

```
thinker_official_website/
├── lib/
│   └── email/
│       ├── resend.ts              # Resend client 初始化
│       └── templates/
│           ├── PaymentReminder.tsx  # 繳費提醒 Email
│           ├── PaymentConfirmed.tsx # 付款確認 Email
│           └── CourseReminder.tsx   # 開課提醒 Email
│
├── app/
│   └── api/
│       └── email/
│           └── send-payment-reminder/
│               └── route.ts         # 發送繳費提醒 API
│
└── .env
    ├── RESEND_API_KEY
    └── RESEND_FROM_EMAIL
```

---

## 🔧 實作細節

### lib/email/resend.ts

```typescript
import { Resend } from 'resend';

if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY is not set');
}

export const resend = new Resend(process.env.RESEND_API_KEY);

export const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
```

---

## 📧 Email 模板設計

### 1. 繳費提醒信（PaymentReminder.tsx）

**發送時機**: 訂單建立後立即發送

**內容包含**:
- 訂單編號
- 課程名稱
- 應繳金額
- 銀行帳號資訊
- 繳費期限倒數
- 回到繳費頁面連結

### 2. 付款確認信（PaymentConfirmed.tsx）

**發送時機**: 後台確認付款後

**內容包含**:
- 報名成功確認
- 課程資訊
- 上課時間地點
- 課前準備事項
- 客服聯絡方式

### 3. 開課提醒信（CourseReminder.tsx）

**發送時機**: 開課前 3 天 & 前 1 天

**內容包含**:
- 課程名稱
- 上課時間
- 上課地點/連結
- 需要攜帶的物品
- 講師聯絡方式

---

## 🚀 使用方式

### 方法 1: 直接在 Server Component 呼叫

```typescript
import { resend, FROM_EMAIL } from '@/lib/email/resend';
import PaymentReminderEmail from '@/lib/email/templates/PaymentReminder';

await resend.emails.send({
  from: FROM_EMAIL,
  to: profile.email,
  subject: `【思考者咖啡】您的報名序號 #${order.order_id}，請完成繳費`,
  react: PaymentReminderEmail({
    studentName: profile.name,
    orderID: order.order_id,
    courseName: course.name,
    amount: order.total,
    expiresAt: new Date(order.created_at).getTime() + 24 * 60 * 60 * 1000,
    paymentURL: `https://thinker.cafe/order/${order.order_id}`,
  }),
});
```

### 方法 2: 透過 API Route 呼叫

```typescript
// 前端呼叫
await fetch('/api/email/send-payment-reminder', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    orderId: order.order_id,
  }),
});

// API Route 處理
// app/api/email/send-payment-reminder/route.ts
export async function POST(request: Request) {
  const { orderId } = await request.json();

  // 查詢訂單資料
  const supabase = createClient();
  const { data: order } = await supabase
    .from('orders')
    .select('*, profiles(*), courses(*)')
    .eq('order_id', orderId)
    .single();

  // 發送 Email
  await resend.emails.send({
    from: FROM_EMAIL,
    to: order.profiles.email,
    subject: `【思考者咖啡】您的報名序號 #${orderId}，請完成繳費`,
    react: PaymentReminderEmail({ ... }),
  });

  return Response.json({ success: true });
}
```

---

## 🧪 測試

### 本地測試

```bash
# 開發模式下，Email 會發送到你設定的測試信箱
pnpm dev

# 建立測試訂單，檢查是否收到 Email
```

### 驗證 Email 內容

1. Resend 後台有 Email 預覽功能
2. 可以查看發送歷史和開信率
3. 建議先寄給自己測試

---

## 💰 費用

### Resend 免費額度

- **3,000 封 Email/月** - 免費
- **100,000 封 Email/月** - USD $20
- **無限制** - 聯繫客服

### 估算

假設每月 50 位學員報名：
- 繳費提醒: 50 封
- 付款確認: 50 封
- 開課提醒: 100 封（前 3 天 + 前 1 天）
- **總計**: 200 封/月

→ **完全在免費額度內**

---

## ⚠️ 注意事項

### 1. 網域驗證

- 測試階段可用 `onboarding@resend.dev`
- **正式環境務必驗證自己的網域**，否則容易被判定為垃圾郵件

### 2. Email 設計

- 使用 React Email 元件設計
- 支援深色模式
- 確保在手機上也能正常顯示

### 3. 發送頻率

- 避免短時間內大量發送（可能觸發限流）
- 建議加入發送佇列機制

### 4. 追蹤

- Resend 提供開信率追蹤
- 可以追蹤哪些 Email 被開啟、點擊

---

## 📊 監控指標

### 重要數據

1. **發送成功率**: 應 > 99%
2. **開信率**: 一般 20-30%
3. **點擊率**: 一般 5-10%
4. **退信率**: 應 < 1%

### 如何改善開信率

- 主旨明確、有急迫感
- 寄件者名稱清楚（思考者咖啡）
- 避免被判定為垃圾郵件（驗證網域、避免敏感詞）

---

## 🔗 相關連結

- **Resend 官網**: https://resend.com
- **React Email 文件**: https://react.email
- **Email 模板範例**: https://react.email/examples

---

**建立日期**: 2025-11-02
**負責人**: Claude
**狀態**: 📝 待審核
