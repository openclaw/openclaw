---
summary: "Gọi trực tiếp một công cụ thông qua endpoint HTTP của Gateway"
read_when:
  - Gọi công cụ mà không chạy toàn bộ một lượt tác tử
  - Xây dựng các tự động hóa cần thực thi chính sách công cụ
title: "API Gọi Công Cụ"
---

# Gọi Công Cụ (HTTP)

OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled, but gated by Gateway auth and tool policy.

- `POST /tools/invoke`
- Cùng cổng với Gateway (ghép kênh WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

Kích thước payload tối đa mặc định là 2 MB.

## Xác thực

Uses the Gateway auth configuration. Send a bearer token:

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
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and default agent, or `global` in global scope).
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
