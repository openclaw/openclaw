---
summary: "Cách OpenClaw xoay vòng hồ sơ xác thực và dự phòng giữa các mô hình"
read_when:
  - Chẩn đoán hành vi xoay vòng hồ sơ xác thực, thời gian cooldown hoặc dự phòng mô hình
  - Cập nhật quy tắc failover cho hồ sơ xác thực hoặc mô hình
title: "Failover mô hình"
---

# Failover mô hình

OpenClaw xử lý lỗi theo hai giai đoạn:

1. **Xoay vòng hồ sơ xác thực** trong cùng một nhà cung cấp.
2. **Dự phòng mô hình** sang mô hình tiếp theo trong `agents.defaults.model.fallbacks`.

Tài liệu này giải thích các quy tắc khi chạy và dữ liệu đứng sau chúng.

## Lưu trữ xác thực (khóa + OAuth)

OpenClaw sử dụng **hồ sơ xác thực** cho cả khóa API và token OAuth.

- Bí mật được lưu trong `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Cấu hình `auth.profiles` / `auth.order` chỉ là **siêu dữ liệu + định tuyến** (không chứa bí mật).
- Tệp OAuth legacy chỉ để import: `~/.openclaw/credentials/oauth.json` (được import vào `auth-profiles.json` khi dùng lần đầu).

Xem thêm chi tiết: [/concepts/oauth](/concepts/oauth)

Các loại thông tin xác thực:

- `type: "api_key"` → `{ provider, key }`
- Nó **không** xoay vòng sau mỗi yêu cầu. }`(+`projectId`/`enterpriseUrl\` cho một số nhà cung cấp)

## ID hồ sơ

Đăng nhập OAuth tạo ra các hồ sơ riêng biệt để nhiều tài khoản có thể cùng tồn tại.

- Mặc định: `provider:default` khi không có email.
- OAuth có email: `provider:<email>` (ví dụ `google-antigravity:user@gmail.com`).

Các hồ sơ nằm trong `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` dưới `profiles`.

## Thứ tự xoay vòng

Khi một nhà cung cấp có nhiều hồ sơ, OpenClaw chọn thứ tự như sau:

1. **Cấu hình tường minh**: `auth.order[provider]` (nếu được đặt).
2. **Hồ sơ đã cấu hình**: `auth.profiles` được lọc theo nhà cung cấp.
3. **Hồ sơ đã lưu trữ**: các mục trong `auth-profiles.json` cho nhà cung cấp đó.

Nếu không cấu hình thứ tự tường minh, OpenClaw dùng thứ tự round‑robin:

- **Khóa chính:** loại hồ sơ (**OAuth trước khóa API**).
- **Khóa phụ:** `usageStats.lastUsed` (cũ nhất trước, trong từng loại).
- **Hồ sơ đang cooldown/bị vô hiệu hóa** được đẩy xuống cuối, sắp theo thời điểm hết hạn sớm nhất.

### Gắn chặt theo phiên (thân thiện với cache)

OpenClaw **ghim hồ sơ xác thực đã chọn theo từng phiên** để giữ bộ nhớ đệm của nhà cung cấp luôn ấm.
Điều này hữu ích cho: Hồ sơ được ghim sẽ được tái sử dụng cho đến khi:

- phiên được reset (`/new` / `/reset`)
- một lần compaction hoàn tất (số đếm compaction tăng)
- hồ sơ vào trạng thái cooldown/bị vô hiệu hóa

Việc chọn thủ công qua `/model …@<profileId>` đặt **ghi đè của người dùng** cho phiên đó
và sẽ không tự động xoay vòng cho đến khi bắt đầu phiên mới.

Auto‑pinned profiles (selected by the session router) are treated as a **preference**:
they are tried first, but OpenClaw may rotate to another profile on rate limits/timeouts.
Các hồ sơ do người dùng ghim sẽ bị khóa vào hồ sơ đó; nếu hồ sơ thất bại và đã cấu hình fallback cho model, OpenClaw sẽ chuyển sang model tiếp theo thay vì đổi hồ sơ.

### Vì sao OAuth có thể “trông như bị mất”

Nếu bạn có cả hồ sơ OAuth và hồ sơ API key cho cùng một nhà cung cấp, round‑robin có thể chuyển giữa chúng qua các tin nhắn trừ khi được ghim. To force a single profile:

- Pin bằng `auth.order[provider] = ["provider:profileId"]`, hoặc
- Dùng ghi đè theo phiên qua `/model …` với ghi đè hồ sơ (khi UI/bề mặt chat của bạn hỗ trợ).

## Cooldown

When a profile fails due to auth/rate‑limit errors (or a timeout that looks
like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.
Các lỗi định dạng/yêu cầu không hợp lệ (ví dụ lỗi xác thực ID của tool call Cloud Code Assist) được coi là đủ điều kiện failover và dùng cùng thời gian cooldown.

Cooldown dùng backoff theo cấp số nhân:

- 1 phút
- 5 phút
- 25 phút
- 1 giờ (giới hạn)

Trạng thái được lưu trong `auth-profiles.json` dưới `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Vô hiệu hóa do thanh toán

Billing/credit failures (for example “insufficient credits” / “credit balance too low”) are treated as failover‑worthy, but they’re usually not transient. Thay vì cooldown ngắn, OpenClaw đánh dấu hồ sơ là **disabled** (với thời gian backoff dài hơn) và xoay sang hồ sơ/nhà cung cấp tiếp theo.

Trạng thái được lưu trong `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Mặc định:

- Backoff thanh toán bắt đầu ở **5 giờ**, tăng gấp đôi mỗi lần lỗi thanh toán, và giới hạn ở **24 giờ**.
- Bộ đếm backoff được reset nếu hồ sơ không thất bại trong **24 giờ** (có thể cấu hình).

## Dự phòng mô hình

Nếu tất cả hồ sơ của một nhà cung cấp đều thất bại, OpenClaw chuyển sang model tiếp theo trong `agents.defaults.model.fallbacks`. Điều này áp dụng cho lỗi xác thực, giới hạn tốc độ, và timeout đã làm cạn kiệt việc xoay vòng hồ sơ (các lỗi khác không làm tiến fallback).

Khi một lần chạy bắt đầu với ghi đè mô hình (hooks hoặc CLI), các dự phòng vẫn kết thúc tại
`agents.defaults.model.primary` sau khi thử mọi dự phòng đã cấu hình.

## Cấu hình liên quan

Xem [Gateway configuration](/gateway/configuration) để biết:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- Định tuyến `agents.defaults.imageModel`

Xem [Models](/concepts/models) để có cái nhìn tổng quan rộng hơn về việc chọn mô hình và dự phòng.
