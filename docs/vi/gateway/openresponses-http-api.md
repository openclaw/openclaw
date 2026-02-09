---
summary: "Mở một endpoint HTTP /v1/responses tương thích OpenResponses từ Gateway"
read_when:
  - Tích hợp các client sử dụng API OpenResponses
  - Bạn muốn đầu vào dạng item, client tool calls hoặc sự kiện SSE
title: "API OpenResponses"
---

# API OpenResponses (HTTP)

Gateway của OpenClaw có thể cung cấp một endpoint `POST /v1/responses` tương thích OpenResponses.

Endpoint này **bị tắt theo mặc định**. Hãy bật nó trong cấu hình trước.

- `POST /v1/responses`
- Cùng cổng với Gateway (ghép kênh WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

Bên trong, các request được thực thi như một lần chạy tác tử Gateway thông thường (cùng codepath với
`openclaw agent`), vì vậy việc định tuyến/quyền/cấu hình sẽ khớp với Gateway của bạn.

## Xác thực

Sử dụng cấu hình xác thực của Gateway. Gửi bearer token:

- `Authorization: Bearer <token>`

Ghi chú:

- Khi `gateway.auth.mode="token"`, dùng `gateway.auth.token` (hoặc `OPENCLAW_GATEWAY_TOKEN`).
- Khi `gateway.auth.mode="password"`, dùng `gateway.auth.password` (hoặc `OPENCLAW_GATEWAY_PASSWORD`).

## Chọn tác tử

Không cần header tùy chỉnh: mã hóa agent id trong trường OpenResponses `model`:

- `model: "openclaw:<agentId>"` (ví dụ: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (bí danh)

Hoặc nhắm tới một tác tử OpenClaw cụ thể bằng header:

- `x-openclaw-agent-id: <agentId>` (mặc định: `main`)

Nâng cao:

- `x-openclaw-session-key: <sessionKey>` để kiểm soát hoàn toàn việc định tuyến phiên.

## Bật endpoint

Đặt `gateway.http.endpoints.responses.enabled` thành `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Tắt endpoint

Đặt `gateway.http.endpoints.responses.enabled` thành `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Hành vi phiên

Theo mặc định, endpoint **không lưu trạng thái theo từng request** (mỗi lần gọi sẽ tạo một khóa phiên mới).

Nếu request bao gồm chuỗi OpenResponses `user`, Gateway sẽ suy ra một khóa phiên ổn định
từ đó, để các lần gọi lặp lại có thể dùng chung một phiên tác tử.

## Hình dạng request (được hỗ trợ)

Yêu cầu tuân theo OpenResponses API với đầu vào dựa trên item. Hỗ trợ hiện tại:

- `input`: chuỗi hoặc mảng các đối tượng item.
- `instructions`: được gộp vào system prompt.
- `tools`: định nghĩa client tool (function tools).
- `tool_choice`: lọc hoặc yêu cầu client tools.
- `stream`: bật streaming SSE.
- `max_output_tokens`: giới hạn đầu ra theo kiểu best-effort (phụ thuộc nhà cung cấp).
- `user`: định tuyến phiên ổn định.

Được chấp nhận nhưng **hiện tại bị bỏ qua**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (đầu vào)

### `message`

Vai trò: `system`, `developer`, `user`, `assistant`.

- `system` và `developer` được thêm vào system prompt.
- Item `user` hoặc `function_call_output` gần nhất trở thành “thông điệp hiện tại”.
- Các thông điệp user/assistant trước đó được đưa vào làm lịch sử để lấy ngữ cảnh.

### `function_call_output` (công cụ theo lượt)

Gửi kết quả công cụ trở lại mô hình:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` và `item_reference`

Được chấp nhận để tương thích schema nhưng bị bỏ qua khi xây dựng prompt.

## Tools (function tools phía client)

Cung cấp công cụ với `tools: [{ type: "function", function: { name, description?, parameters?` } }]\`.

Nếu agent quyết định gọi một công cụ, phản hồi sẽ trả về một item đầu ra `function_call`.
Sau đó bạn gửi một yêu cầu tiếp theo với `function_call_output` để tiếp tục lượt.

## Hình ảnh (`input_image`)

Hỗ trợ nguồn base64 hoặc URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Các loại MIME được phép (hiện tại): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Kích thước tối đa (hiện tại): 10MB.

## Tệp (`input_file`)

Hỗ trợ nguồn base64 hoặc URL:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Các MIME type được phép (hiện tại): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Kích thước tối đa (hiện tại): 5MB.

Hành vi hiện tại:

- Nội dung tệp được giải mã và thêm vào **system prompt**, không phải thông điệp user,
  vì vậy nó mang tính tạm thời (không được lưu trong lịch sử phiên).
- PDF được phân tích để trích xuất văn bản. Nếu tìm thấy ít văn bản, các trang đầu tiên sẽ được raster hóa
  thành hình ảnh và chuyển cho mô hình.

Việc phân tích PDF sử dụng bản build legacy `pdfjs-dist` thân thiện với Node (không có worker). Bản build PDF.js hiện đại
mong đợi worker/DOM globals của trình duyệt, vì vậy không được dùng trong Gateway.

Mặc định khi fetch URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Các request được bảo vệ (phân giải DNS, chặn IP riêng, giới hạn chuyển hướng, timeout).

## Giới hạn tệp + hình ảnh (cấu hình)

Các giá trị mặc định có thể điều chỉnh dưới `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Mặc định khi bỏ qua:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Streaming (SSE)

Đặt `stream: true` để nhận Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Mỗi dòng sự kiện là `event: <type>` và `data: <json>`
- Luồng kết thúc bằng `data: [DONE]`

Các loại sự kiện hiện được phát:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (khi lỗi)

## Cách dùng

`usage` được điền khi nhà cung cấp bên dưới báo cáo số lượng token.

## Lỗi

Lỗi sử dụng một đối tượng JSON như sau:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Các trường hợp phổ biến:

- `401` thiếu/không hợp lệ xác thực
- `400` body request không hợp lệ
- `405` sai phương thức

## Ví dụ

Không streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
