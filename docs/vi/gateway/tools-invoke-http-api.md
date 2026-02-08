---
summary: "Gọi trực tiếp một công cụ thông qua endpoint HTTP của Gateway"
read_when:
  - Gọi công cụ mà không chạy toàn bộ một lượt tác tử
  - Xây dựng các tự động hóa cần thực thi chính sách công cụ
title: "API Gọi Công Cụ"
x-i18n:
  source_path: gateway/tools-invoke-http-api.md
  source_hash: 17ccfbe0b0d9bb61
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:08Z
---

# Gọi Công Cụ (HTTP)

Gateway của OpenClaw cung cấp một endpoint HTTP đơn giản để gọi trực tiếp một công cụ. Endpoint này luôn được bật, nhưng được kiểm soát bởi xác thực của Gateway và chính sách công cụ.

- `POST /tools/invoke`
- Cùng cổng với Gateway (ghép kênh WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

Kích thước payload tối đa mặc định là 2 MB.

## Xác thực

Sử dụng cấu hình xác thực của Gateway. Gửi bearer token:

- `Authorization: Bearer <token>`

Ghi chú:

- Khi `gateway.auth.mode="token"`, sử dụng `gateway.auth.token` (hoặc `OPENCLAW_GATEWAY_TOKEN`).
- Khi `gateway.auth.mode="password"`, sử dụng `gateway.auth.password` (hoặc `OPENCLAW_GATEWAY_PASSWORD`).

## Nội dung yêu cầu

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Các trường:

- `tool` (string, bắt buộc): tên công cụ cần gọi.
- `action` (string, tùy chọn): được ánh xạ vào args nếu schema của công cụ hỗ trợ `action` và payload args không bao gồm trường này.
- `args` (object, tùy chọn): các tham số dành riêng cho công cụ.
- `sessionKey` (string, tùy chọn): khóa phiên đích. Nếu bỏ qua hoặc `"main"`, Gateway sử dụng khóa phiên chính đã cấu hình (tuân theo `session.mainKey` và tác tử mặc định, hoặc `global` ở phạm vi toàn cục).
- `dryRun` (boolean, tùy chọn): dành cho sử dụng trong tương lai; hiện tại bị bỏ qua.

## Hành vi chính sách + định tuyến

Khả dụng của công cụ được lọc thông qua cùng chuỗi chính sách được Gateway agents sử dụng:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- chính sách nhóm (nếu khóa phiên ánh xạ tới một nhóm hoặc kênh)
- chính sách subagent (khi gọi bằng khóa phiên subagent)

Nếu một công cụ không được cho phép theo chính sách, endpoint sẽ trả về **404**.

Để giúp các chính sách nhóm phân giải ngữ cảnh, bạn có thể tùy chọn thiết lập:

- `x-openclaw-message-channel: <channel>` (ví dụ: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (khi tồn tại nhiều tài khoản)

## Phản hồi

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (yêu cầu không hợp lệ hoặc lỗi công cụ)
- `401` → không được ủy quyền
- `404` → công cụ không khả dụng (không tìm thấy hoặc không nằm trong danh sách cho phép)
- `405` → phương thức không được phép

## Ví dụ

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
