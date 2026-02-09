---
summary: "Kế hoạch: Thêm endpoint OpenResponses /v1/responses và ngừng Chat Completions một cách gọn gàng"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Kế hoạch Gateway OpenResponses"
---

# Kế hoạch tích hợp Gateway OpenResponses

## Bối cảnh

Gateway OpenClaw hiện đang cung cấp một endpoint Chat Completions tương thích OpenAI ở mức tối thiểu tại
`/v1/chat/completions` (xem [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses là một tiêu chuẩn suy luận mở dựa trên OpenAI Responses API. Đặc tả OpenResponses định nghĩa `/v1/responses`, không phải `/v1/chat/completions`. Tài liệu này ghi lại **các ý tưởng** cho cấu hình model trong tương lai.

## Mục tiêu

- Thêm một endpoint `/v1/responses` tuân thủ ngữ nghĩa OpenResponses.
- Giữ Chat Completions như một lớp tương thích, dễ tắt và có thể loại bỏ dần về sau.
- Chuẩn hóa việc kiểm tra hợp lệ và phân tích với các schema tách biệt, có thể tái sử dụng.

## Không phải mục tiêu

- Đạt đầy đủ tính năng OpenResponses trong lần triển khai đầu tiên (hình ảnh, tệp, công cụ lưu trữ).
- Thay thế logic thực thi tác tử nội bộ hoặc điều phối công cụ.
- Thay đổi hành vi `/v1/chat/completions` hiện có trong giai đoạn đầu.

## Tóm tắt nghiên cứu

Nguồn: OpenResponses OpenAPI, trang đặc tả OpenResponses và bài blog của Hugging Face.

Các điểm chính rút ra:

- `POST /v1/responses` chấp nhận các trường `CreateResponseBody` như `model`, `input` (chuỗi hoặc
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, và
  `max_tool_calls`.
- `ItemParam` là một union phân biệt gồm:
  - các item `message` với vai trò `system`, `developer`, `user`, `assistant`
  - `function_call` và `function_call_output`
  - `reasoning`
  - `item_reference`
- Phản hồi thành công trả về một `ResponseResource` với các item `object: "response"`, `status`, và
  `output`.
- Streaming sử dụng các sự kiện ngữ nghĩa như:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Đặc tả yêu cầu:
  - `Content-Type: text/event-stream`
  - `event:` phải khớp với trường JSON `type`
  - sự kiện kết thúc phải là literal `[DONE]`
- Các item suy luận có thể lộ ra `content`, `encrypted_content`, và `summary`.
- Ví dụ từ HF bao gồm `OpenResponses-Version: latest` trong request (header tùy chọn).

## Kiến trúc đề xuất

- Thêm `src/gateway/open-responses.schema.ts` chỉ chứa các schema Zod (không import gateway).
- Thêm `src/gateway/openresponses-http.ts` (hoặc `open-responses-http.ts`) cho `/v1/responses`.
- Giữ `src/gateway/openai-http.ts` nguyên vẹn như một adapter tương thích cũ.
- Thêm cấu hình `gateway.http.endpoints.responses.enabled` (mặc định `false`).
- Giữ `gateway.http.endpoints.chatCompletions.enabled` độc lập; cho phép bật/tắt từng endpoint riêng biệt.
- Phát cảnh báo khi khởi động nếu Chat Completions được bật để báo hiệu trạng thái legacy.

## Lộ trình ngừng Chat Completions

- Duy trì ranh giới module nghiêm ngặt: không dùng chung loại schema giữa responses và chat completions.
- Đặt Chat Completions ở chế độ opt-in bằng cấu hình để có thể tắt mà không cần thay đổi mã.
- Cập nhật tài liệu để gắn nhãn Chat Completions là legacy khi `/v1/responses` ổn định.
- Bước tùy chọn trong tương lai: ánh xạ request Chat Completions sang handler Responses để đơn giản hóa
  lộ trình loại bỏ.

## Tập con hỗ trợ Giai đoạn 1

- Chấp nhận `input` dưới dạng chuỗi hoặc `ItemParam[]` với vai trò thông điệp và `function_call_output`.
- Trích xuất thông điệp system và developer vào `extraSystemPrompt`.
- Sử dụng `user` hoặc `function_call_output` gần nhất làm thông điệp hiện tại cho các lần chạy tác tử.
- Từ chối các phần nội dung không được hỗ trợ (hình ảnh/tệp) với `invalid_request_error`.
- Trả về một thông điệp assistant duy nhất với nội dung `output_text`.
- Trả về `usage` với các giá trị bằng 0 cho đến khi kết nối xong việc tính token.

## Chiến lược kiểm tra hợp lệ (không dùng SDK)

- Triển khai các schema Zod cho tập con được hỗ trợ của:
  - `CreateResponseBody`
  - `ItemParam` + các union phần nội dung thông điệp
  - `ResponseResource`
  - Các dạng sự kiện streaming được Gateway sử dụng
- Giữ các schema trong một module tách biệt duy nhất để tránh sai lệch và cho phép sinh mã trong tương lai.

## Triển khai streaming (Giai đoạn 1)

- Dòng SSE với cả `event:` và `data:`.
- Trình tự bắt buộc (khả dụng tối thiểu):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (lặp lại khi cần)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Kế hoạch kiểm thử và xác minh

- Thêm phạm vi e2e cho `/v1/responses`:
  - Yêu cầu xác thực
  - Dạng phản hồi không streaming
  - Thứ tự sự kiện streaming và `[DONE]`
  - Định tuyến phiên với header và `user`
- Giữ `src/gateway/openai-http.e2e.test.ts` không thay đổi.
- Thủ công: dùng curl tới `/v1/responses` với `stream: true` và xác minh thứ tự sự kiện và
  `[DONE]` kết thúc.

## Cập nhật tài liệu (theo sau)

- Thêm một trang tài liệu mới cho cách dùng và ví dụ của `/v1/responses`.
- Cập nhật `/gateway/openai-http-api` với ghi chú legacy và liên kết tới `/v1/responses`.
