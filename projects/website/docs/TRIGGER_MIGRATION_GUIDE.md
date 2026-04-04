# 🔧 Database Trigger Migration 指南

**日期**: 2025-11-05
**目的**: 更新 Database Trigger 支援 LINE Login

---

## 📋 背景說明

### 當前狀況

根據調查（`docs/AUTH_FLOW_INVESTIGATION.md`），系統已經有 Database Trigger 會在建立 `auth.users` 時自動建立 `profiles`。

**證據**：
- auth.users 和 profiles 數量完全一致 (9:9)
- created_at 時間差 < 1 毫秒
- user_metadata 資料 100% 映射到 profiles

### 問題

現有的 Trigger 只支援 Email Login，需要擴展支援 LINE Login。

---

## 🎯 Migration 內容

### 新增/修改的 Function

**`public.handle_new_user()`**

功能：
1. 自動遞增 `student_id`
2. 根據 `authProvider` 判斷登入方式
3. LINE Login → 從 LINE metadata 填入資料
4. Email Login → 從 Email metadata 填入資料

### Trigger

**`on_auth_user_created`**
- 事件：`AFTER INSERT ON auth.users`
- 執行：`handle_new_user()`

---

## 🚀 執行步驟

### 方法 1: Supabase Dashboard (推薦)

1. **前往 SQL Editor**
   ```
   https://supabase.com/dashboard/project/fpdcnbpeoasipxjibmuz/sql/new
   ```

2. **複製並執行 Migration**
   - 檔案：`migrations/20251105_update_trigger_for_line_login.sql`
   - 點擊 "Run" 執行

3. **確認結果**
   - Function `handle_new_user` 已建立
   - Trigger `on_auth_user_created` 已建立

### 方法 2: psql CLI

```bash
# 從 Supabase Dashboard 取得連線字串
psql "postgresql://postgres:[PASSWORD]@db.fpdcnbpeoasipxjibmuz.supabase.co:5432/postgres" \
  -f migrations/20251105_update_trigger_for_line_login.sql
```

---

## 🧪 測試 Trigger

### 測試 LINE Login

```sql
-- 手動建立測試用戶 (不要在 production 執行)
INSERT INTO auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
) VALUES (
  gen_random_uuid(),
  'test_line@line.thinker.cafe',
  crypt('random_password', gen_salt('bf')),
  NOW(),
  '{
    "authProvider": "line",
    "lineUserId": "U_TEST_LINE_123",
    "displayName": "測試 LINE 用戶",
    "pictureUrl": "https://example.com/test.jpg"
  }'::jsonb
);

-- 驗證 profile 是否正確建立
SELECT
  user_id,
  student_id,
  full_name,
  line_user_id,
  line_display_name,
  auth_provider
FROM profiles
WHERE line_user_id = 'U_TEST_LINE_123';
```

**預期結果**：
```
user_id              | student_id | full_name      | line_user_id     | auth_provider
---------------------|------------|----------------|------------------|---------------
<uuid>              | 10         | 測試 LINE 用戶 | U_TEST_LINE_123  | line
```

### 測試 Email Login

```sql
-- 手動建立測試用戶
INSERT INTO auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data
) VALUES (
  gen_random_uuid(),
  'test_email@example.com',
  crypt('random_password', gen_salt('bf')),
  NOW(),
  '{
    "authProvider": "email",
    "fullName": "測試 Email 用戶",
    "phoneNumber": "0912345678",
    "agreeTos": true
  }'::jsonb
);

-- 驗證 profile
SELECT
  user_id,
  student_id,
  full_name,
  phone_number,
  auth_provider
FROM profiles
WHERE full_name = '測試 Email 用戶';
```

**預期結果**：
```
user_id    | student_id | full_name       | phone_number | auth_provider
-----------|------------|-----------------|--------------|---------------
<uuid>     | 11         | 測試 Email 用戶 | 0912345678   | email
```

---

## ✅ 驗證清單

執行 Migration 後，請確認：

- [ ] Function `handle_new_user` 已建立
  ```sql
  SELECT routine_name FROM information_schema.routines
  WHERE routine_schema = 'public' AND routine_name = 'handle_new_user';
  ```

- [ ] Trigger `on_auth_user_created` 已建立
  ```sql
  SELECT trigger_name FROM information_schema.triggers
  WHERE trigger_name = 'on_auth_user_created';
  ```

- [ ] 測試 LINE Login 建立 profile ✅
- [ ] 測試 Email Login 建立 profile ✅
- [ ] `student_id` 正確遞增 ✅

---

## 🔄 回滾 (Rollback)

如果需要還原，執行：

```sql
-- 刪除 Trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 刪除 Function
DROP FUNCTION IF EXISTS public.handle_new_user();
```

⚠️ **注意**：回滾後，新註冊的用戶將不會自動建立 profile！

---

## 📊 Migration 後的影響

### 新 LINE 用戶註冊

```
用戶在 LINE App 點擊登入
  ↓
前端：liff.init() + liff.getProfile()
  ↓
後端：POST /api/line/login
  ↓
Supabase: auth.admin.createUser()
  ↓
🔔 Database Trigger 自動觸發
  ↓
Function: handle_new_user()
  - 判斷 authProvider = 'line'
  - 從 raw_user_meta_data 取得 LINE 資料
  - 插入 profiles (line_user_id, line_display_name, etc.)
  ↓
✅ Profile 自動建立完成
```

### 新 Email 用戶註冊

```
用戶在網頁填寫表單
  ↓
前端：supabase.auth.signUp({ email, password, options: { data: {...} } })
  ↓
Supabase: 建立 auth.users
  ↓
🔔 Database Trigger 自動觸發
  ↓
Function: handle_new_user()
  - 判斷 authProvider != 'line'
  - 從 raw_user_meta_data 取得 Email 資料
  - 插入 profiles (full_name, phone_number, etc.)
  ↓
✅ Profile 自動建立完成
```

---

## ⚠️ 重要注意事項

1. **不影響現有用戶**
   - 此 Migration 只影響「新註冊」的用戶
   - 現有的 9 個用戶不受影響

2. **API 中的手動建立仍然存在**
   - `/api/line/login` 中仍有手動 `insert` profile 的程式碼
   - 這是為了防止 Trigger 失敗的 fallback
   - 如果 Trigger 正常運作，會略過手動建立（檢查 profile 是否已存在）

3. **student_id 遞增**
   - Function 會自動計算下一個 student_id
   - 目前最大值是 14，下一個會是 15

---

## 📞 需要協助？

如果遇到問題：
1. 檢查 Supabase Dashboard → Database → Functions
2. 檢查 Supabase Dashboard → Database → Triggers
3. 查看 Supabase Logs 是否有錯誤訊息
4. 執行驗證 SQL 確認 Trigger 狀態

---

**執行完成後請回報結果！**
