---
summary: "Cách OpenClaw xoay vòng hồ sơ xác thực và dự phòng giữa các mô hình"
read_when:
  - Chẩn đoán hành vi xoay vòng hồ sơ xác thực, thời gian cooldown hoặc dự phòng mô hình
  - Cập nhật quy tắc failover cho hồ sơ xác thực hoặc mô hình
title: "Failover mô hình"
x-i18n:
  source_path: concepts/model-failover.md
  source_hash: eab7c0633824d941
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:43Z
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
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` cho một số nhà cung cấp)

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

OpenClaw **gắn cố định hồ sơ xác thực đã chọn theo từng phiên** để giữ cache của nhà cung cấp luôn ấm.
Nó **không** xoay vòng ở mỗi yêu cầu. Hồ sơ được gắn sẽ được tái sử dụng cho đến khi:

- phiên được reset (`/new` / `/reset`)
- một lần compaction hoàn tất (số đếm compaction tăng)
- hồ sơ vào trạng thái cooldown/bị vô hiệu hóa

Việc chọn thủ công qua `/model …@<profileId>` đặt **ghi đè của người dùng** cho phiên đó
và sẽ không tự động xoay vòng cho đến khi bắt đầu phiên mới.

Các hồ sơ được auto‑pin (do bộ định tuyến phiên chọn) được coi là một **ưu tiên**:
chúng được thử trước, nhưng OpenClaw có thể xoay sang hồ sơ khác khi gặp rate limit/timeout.
Các hồ sơ do người dùng pin sẽ bị khóa vào hồ sơ đó; nếu thất bại và có cấu hình
dự phòng mô hình, OpenClaw sẽ chuyển sang mô hình tiếp theo thay vì đổi hồ sơ.

### Vì sao OAuth có thể “trông như bị mất”

Nếu bạn có cả hồ sơ OAuth và hồ sơ khóa API cho cùng một nhà cung cấp, round‑robin có thể chuyển qua lại giữa chúng qua các tin nhắn nếu không được pin. Để buộc dùng một hồ sơ duy nhất:

- Pin bằng `auth.order[provider] = ["provider:profileId"]`, hoặc
- Dùng ghi đè theo phiên qua `/model …` với ghi đè hồ sơ (khi UI/bề mặt chat của bạn hỗ trợ).

## Cooldown

Khi một hồ sơ thất bại do lỗi xác thực/rate‑limit (hoặc timeout trông giống rate limiting), OpenClaw đánh dấu nó vào trạng thái cooldown và chuyển sang hồ sơ tiếp theo.
Các lỗi định dạng/yêu cầu không hợp lệ (ví dụ lỗi xác thực ID lời gọi công cụ Cloud Code Assist) cũng được coi là đủ điều kiện failover và dùng cùng cơ chế cooldown.

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

Các lỗi thanh toán/tín dụng (ví dụ “insufficient credits” / “credit balance too low”) được coi là đủ điều kiện failover, nhưng thường không mang tính tạm thời. Thay vì cooldown ngắn, OpenClaw đánh dấu hồ sơ là **bị vô hiệu hóa** (với backoff dài hơn) và xoay sang hồ sơ/nhà cung cấp tiếp theo.

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

Nếu tất cả hồ sơ của một nhà cung cấp đều thất bại, OpenClaw chuyển sang mô hình tiếp theo trong
`agents.defaults.model.fallbacks`. Điều này áp dụng cho lỗi xác thực, rate limit và
timeout khi đã dùng hết xoay vòng hồ sơ (các lỗi khác không làm tiến tới dự phòng).

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
