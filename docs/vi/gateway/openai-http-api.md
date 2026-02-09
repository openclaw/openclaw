---
summary: "Mở một endpoint HTTP /v1/chat/completions tương thích OpenAI từ Gateway"
read_when:
  - Tích hợp các công cụ mong đợi OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Gateway của OpenClaw có thể phục vụ một endpoint Chat Completions nhỏ, tương thích OpenAI.

Endpoint này **bị tắt theo mặc định**. Hãy bật nó trong cấu hình trước.

- `POST /v1/chat/completions`
- Cùng cổng với Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Bên dưới, các yêu cầu được thực thi như một lần chạy tác tử Gateway thông thường (cùng codepath với `openclaw agent`), vì vậy định tuyến/quyền/cấu hình khớp với Gateway của bạn.

## Authentication

Sử dụng cấu hình xác thực của Gateway. Gửi bearer token:

- `Authorization: Bearer <token>`

Ghi chú:

- Khi `gateway.auth.mode="token"`, dùng `gateway.auth.token` (hoặc `OPENCLAW_GATEWAY_TOKEN`).
- Khi `gateway.auth.mode="password"`, dùng `gateway.auth.password` (hoặc `OPENCLAW_GATEWAY_PASSWORD`).

## Chọn tác tử

Không cần header tùy chỉnh: mã hóa id tác tử trong trường OpenAI `model`:

- `model: "openclaw:<agentId>"` (ví dụ: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (bí danh)

Hoặc nhắm tới một tác tử OpenClaw cụ thể bằng header:

- `x-openclaw-agent-id: <agentId>` (mặc định: `main`)

Nâng cao:

- `x-openclaw-session-key: <sessionKey>` để kiểm soát đầy đủ việc định tuyến phiên.

## Bật endpoint

Đặt `gateway.http.endpoints.chatCompletions.enabled` thành `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Tắt endpoint

Đặt `gateway.http.endpoints.chatCompletions.enabled` thành `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Hành vi phiên

Theo mặc định, endpoint là **không trạng thái theo từng yêu cầu** (mỗi lần gọi sẽ tạo một khóa phiên mới).

Nếu yêu cầu bao gồm một chuỗi OpenAI `user`, Gateway sẽ suy ra một khóa phiên ổn định từ đó, để các lần gọi lặp lại có thể dùng chung một phiên tác tử.

## Streaming (SSE)

Đặt `stream: true` để nhận Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Mỗi dòng sự kiện là `data: <json>`
- Luồng kết thúc bằng `data: [DONE]`

## Ví dụ

Không streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
