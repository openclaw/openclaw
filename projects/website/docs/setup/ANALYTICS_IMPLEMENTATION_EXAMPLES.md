# 📊 Google Analytics 實作範例

## 已完成設定

### ✅ 1. 安裝套件
```bash
pnpm add @next/third-parties
```

### ✅ 2. 建立追蹤元件
- `components/analytics/GoogleAnalytics.tsx` - GA4 元件
- `lib/analytics.ts` - 追蹤函式庫

### ✅ 3. 整合到 app/layout.tsx
已加入 `<GoogleAnalytics />` 元件

---

## 🔧 設定步驟

### Step 1: 建立 Google Analytics 4 帳號

1. 前往 https://analytics.google.com/
2. 建立新的 GA4 屬性
3. 取得 **Measurement ID** (格式: `G-XXXXXXXXXX`)

### Step 2: 設定環境變數

在 `.env` 加入:

```env
# Google Analytics
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

### Step 3: 測試

啟動開發伺服器後,開啟瀏覽器的開發者工具 → Network,過濾 `google-analytics` 或 `gtag`,應該會看到追蹤請求。

---

## 📝 使用範例

### 1. 課程列表頁 (products/page.tsx)

```typescript
import { trackEvent } from '@/lib/analytics';

export default function ProductsPage() {
  // 追蹤:進入課程列表頁
  useEffect(() => {
    trackEvent('view_item_list', {
      item_list_id: 'courses',
      item_list_name: '所有課程',
    });
  }, []);

  return (
    // ...
  );
}
```

### 2. 單一課程頁 (products/[id]/page.tsx)

在課程詳細頁加入查看課程追蹤:

```typescript
import { trackViewCourse } from '@/lib/analytics';

export default function CoursePage({ product }) {
  useEffect(() => {
    // 追蹤:查看課程詳情
    trackViewCourse({
      id: product.course_id.toString(),
      name: product.zh_name,
      category: product.zh_category,
      price: product.group_price || product.single_price,
    });
  }, [product]);

  return (
    // ...
  );
}
```

### 3. 課程報名頁 (buy-course/BuyCourseForm.js)

#### 3a. 點擊「探索課程」按鈕時

```typescript
import { trackEvent } from '@/lib/analytics';

<Link href="/products">
  <Button
    onClick={() => {
      trackEvent('click_explore_courses', {
        button_location: 'homepage_hero',
      });
    }}
  >
    探索課程
  </Button>
</Link>
```

#### 3b. 選擇課程和上課方式後,點擊「繼續」

```typescript
import { trackBeginCheckout } from '@/lib/analytics';

function BuyCourseForm({ courses }) {
  const handleContinue = () => {
    const selectedCourse = courses.find(c => c.course_id === courseId);

    // 追蹤:開始結帳流程
    trackBeginCheckout({
      id: selectedCourse.course_id.toString(),
      name: selectedCourse.zh_name,
      category: selectedCourse.zh_category,
      variant: courseVariant, // 'group' or 'single'
      price: total,
    });

    setState('verifying');
  };

  return (
    // ...
  );
}
```

#### 3c. 確認報名並建立訂單成功後

```typescript
import { trackPurchase } from '@/lib/analytics';

async function onSubmit(values) {
  // ... 建立訂單

  if (!error && data) {
    const selectedCourse = courses.find(c => c.course_id === courseId);

    // 追蹤:完成購買
    trackPurchase({
      orderId: data[0].order_id.toString(),
      courseId: selectedCourse.course_id.toString(),
      courseName: selectedCourse.zh_name,
      category: selectedCourse.zh_category,
      variant: courseVariant,
      total: totalEarly || total,
    });

    router.replace(`/order/${data[0].order_id}`);
  }
}
```

### 4. 註冊頁 (signup/SignUpPage.js)

```typescript
import { trackSignUp } from '@/lib/analytics';

async function handleSignUp() {
  const { error } = await supabase.auth.signUp({ email, password });

  if (!error) {
    // 追蹤:用戶註冊成功
    trackSignUp('email');
  }
}
```

### 5. 登入頁 (signin/SignInPage.js)

```typescript
import { trackLogin } from '@/lib/analytics';

async function handleSignIn() {
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (!error) {
    // 追蹤:用戶登入成功
    trackLogin('email');
  }
}
```

### 6. 聯絡表單 (contact/page.tsx)

```typescript
import { trackContactFormSubmit } from '@/lib/analytics';

async function handleSubmit(data) {
  const response = await fetch('/api/contact', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (response.ok) {
    // 追蹤:聯絡表單提交
    trackContactFormSubmit(data.subject);
  }
}
```

---

## 📊 可追蹤的關鍵指標

### 流量分析
- ✅ 頁面瀏覽量
- ✅ 使用者數量
- ✅ 跳出率
- ✅ 平均停留時間

### 電子商務轉換漏斗
1. **view_item_list** - 查看課程列表
2. **view_item** - 查看單一課程
3. **begin_checkout** - 開始報名流程
4. **purchase** - 完成報名

### 用戶行為
- **sign_up** - 註冊
- **login** - 登入
- **contact_form_submit** - 聯絡表單提交

### 自訂事件
- **click_explore_courses** - 點擊探索課程按鈕
- 其他你想追蹤的按鈕點擊或用戶行為

---

## 🎯 在 GA4 中查看數據

### 1. 即時報表
- GA4 Dashboard → 報表 → 即時報表
- 可以立即看到目前有多少人在線、正在瀏覽哪些頁面

### 2. 電子商務報表
- GA4 Dashboard → 報表 → 營利
- 可以看到:
  - 購買次數
  - 總收益
  - 平均訂單價值
  - 轉換率

### 3. 事件報表
- GA4 Dashboard → 報表 → 參與 → 事件
- 可以看到所有自訂事件的觸發次數

### 4. 轉換漏斗分析
- GA4 Dashboard → 探索 → 漏斗分析
- 建立自訂漏斗:
  1. 查看課程列表
  2. 查看課程詳情
  3. 開始報名
  4. 完成報名
- 可以看到每一步的流失率

---

## 🔒 隱私權注意事項

### Cookie 同意橫幅

根據 GDPR/台灣個資法,建議加入 Cookie 同意機制:

**推薦套件**:
- `react-cookie-consent`
- `@cookiehub/react-cookie-consent`

**簡易實作**:

```tsx
import CookieConsent from 'react-cookie-consent';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <CookieConsent
          location="bottom"
          buttonText="我同意"
          declineButtonText="拒絕"
          enableDeclineButton
          onAccept={() => {
            // 啟用 GA
          }}
          onDecline={() => {
            // 停用 GA
          }}
        >
          本網站使用 Cookie 以提供更好的使用體驗。
        </CookieConsent>
      </body>
    </html>
  );
}
```

---

## ✅ 檢查清單

部署前請確認:

- [ ] 已在 Google Analytics 建立 GA4 屬性
- [ ] 已將 Measurement ID 加入 `.env`
- [ ] 已在 Vercel 設定環境變數 `NEXT_PUBLIC_GA_MEASUREMENT_ID`
- [ ] 已在關鍵頁面加入事件追蹤
- [ ] 已測試追蹤功能正常運作
- [ ] 已加入隱私權政策頁面
- [ ] (選用) 已加入 Cookie 同意橫幅

---

## 🚀 其他推薦追蹤方案

### Vercel Analytics (如果使用 Vercel 部署)

```bash
pnpm add @vercel/analytics
```

在 `app/layout.tsx` 加入:

```tsx
import { Analytics } from '@vercel/analytics/react';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

**優點**:
- 零設定
- 自動追蹤 Web Vitals
- 不需要 Cookie 同意
- 與 Vercel 整合完美

### Meta Pixel (Facebook/Instagram 廣告)

如果未來要投放 Facebook/Instagram 廣告:

```bash
pnpm add react-facebook-pixel
```

---

**文件版本**: v1.0
**最後更新**: 2025-11-02
