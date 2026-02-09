---
summary: "Tham chiếu: các quy tắc làm sạch và sửa chữa bản ghi theo từng nhà cung cấp"
read_when:
  - Bạn đang gỡ lỗi các trường hợp nhà cung cấp từ chối request liên quan đến hình dạng bản ghi
  - Bạn đang thay đổi logic làm sạch bản ghi hoặc sửa chữa tool-call
  - Bạn đang điều tra sự không khớp id tool-call giữa các nhà cung cấp
title: "Vệ sinh bản ghi"
---

# Vệ sinh bản ghi (Sửa lỗi theo nhà cung cấp)

Tài liệu này mô tả các **bản sửa lỗi theo từng nhà cung cấp** được áp dụng cho transcript trước khi chạy (xây dựng ngữ cảnh mô hình). 13. Đây là các điều chỉnh **trong bộ nhớ** được dùng để đáp ứng các yêu cầu nghiêm ngặt của provider. Các bước vệ sinh này **không** ghi đè transcript JSONL đã lưu trên đĩa; tuy nhiên, một bước sửa chữa tệp phiên riêng biệt có thể ghi lại các tệp JSONL bị lỗi bằng cách loại bỏ các dòng không hợp lệ trước khi phiên được tải. When a repair occurs, the original
file is backed up alongside the session file.

Phạm vi bao gồm:

- Làm sạch id tool-call
- Xác thực đầu vào tool-call
- Sửa chữa ghép cặp kết quả tool
- Xác thực / sắp xếp lượt
- Dọn dẹp chữ ký suy nghĩ
- Làm sạch payload hình ảnh

Nếu bạn cần chi tiết về lưu trữ bản ghi, xem:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Nơi quy trình này chạy

Toàn bộ vệ sinh bản ghi được tập trung trong embedded runner:

- Chọn chính sách: `src/agents/transcript-policy.ts`
- Áp dụng làm sạch/sửa chữa: `sanitizeSessionHistory` trong `src/agents/pi-embedded-runner/google.ts`

Chính sách sử dụng `provider`, `modelApi` và `modelId` để quyết định áp dụng những gì.

Tách biệt với vệ sinh bản ghi, các tệp phiên sẽ được sửa chữa (nếu cần) trước khi tải:

- `repairSessionFileIfNeeded` trong `src/agents/session-file-repair.ts`
- Được gọi từ `run/attempt.ts` và `compact.ts` (embedded runner)

---

## Quy tắc toàn cục: làm sạch hình ảnh

Payload hình ảnh luôn được làm sạch để ngăn việc nhà cung cấp từ chối do giới hạn kích thước
(giảm kích thước/nén lại các ảnh base64 quá lớn).

Triển khai:

- `sanitizeSessionMessagesImages` trong `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` trong `src/agents/tool-images.ts`

---

## Quy tắc toàn cục: tool call bị lỗi

Các khối tool-call của trợ lý bị thiếu cả `input` và `arguments` sẽ bị loại bỏ trước khi ngữ cảnh mô hình được xây dựng. Điều này ngăn việc nhà cung cấp từ chối do các tool call được lưu một phần (ví dụ sau khi gặp lỗi giới hạn tốc độ).

Triển khai:

- `sanitizeToolCallInputs` trong `src/agents/session-transcript-repair.ts`
- Áp dụng trong `sanitizeSessionHistory` tại `src/agents/pi-embedded-runner/google.ts`

---

## Ma trận theo nhà cung cấp (hành vi hiện tại)

**OpenAI / OpenAI Codex**

- Chỉ làm sạch hình ảnh.
- Khi chuyển mô hình sang OpenAI Responses/Codex, loại bỏ các chữ ký suy luận mồ côi (các mục suy luận độc lập không có khối nội dung theo sau).
- Không làm sạch id tool-call.
- Không sửa chữa ghép cặp kết quả tool.
- Không xác thực hay sắp xếp lại lượt.
- Không tạo kết quả tool tổng hợp.
- Không loại bỏ chữ ký suy nghĩ.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Làm sạch id tool-call: chỉ cho phép chữ và số nghiêm ngặt.
- Sửa chữa ghép cặp kết quả tool và tạo kết quả tool tổng hợp.
- Xác thực lượt (luân phiên lượt theo kiểu Gemini).
- Sửa thứ tự lượt của Google (chèn một bootstrap user rất nhỏ nếu lịch sử bắt đầu bằng assistant).
- Antigravity Claude: chuẩn hóa chữ ký suy nghĩ; loại bỏ các khối suy nghĩ không có chữ ký.

**Anthropic / Minimax (tương thích Anthropic)**

- Sửa chữa ghép cặp kết quả tool và tạo kết quả tool tổng hợp.
- Xác thực lượt (gộp các lượt user liên tiếp để đáp ứng luân phiên nghiêm ngặt).

**Mistral (bao gồm phát hiện dựa trên model-id)**

- Làm sạch id tool-call: strict9 (chữ và số, độ dài 9).

**OpenRouter Gemini**

- Dọn dẹp chữ ký suy nghĩ: loại bỏ các giá trị `thought_signature` không phải base64 (giữ lại base64).

**Các trường hợp còn lại**

- Chỉ làm sạch hình ảnh.

---

## Hành vi lịch sử (trước 2026.1.22)

Trước bản phát hành 2026.1.22, OpenClaw áp dụng nhiều lớp vệ sinh bản ghi:

- Một **transcript-sanitize extension** chạy ở mỗi lần xây dựng ngữ cảnh và có thể:
  - Sửa chữa ghép cặp sử dụng/kết quả tool.
  - Làm sạch id tool-call (bao gồm chế độ không nghiêm ngặt, giữ lại `_`/`-`).
- Runner cũng thực hiện làm sạch theo nhà cung cấp, gây trùng lặp công việc.
- Các đột biến bổ sung xảy ra ngoài chính sách nhà cung cấp, bao gồm:
  - Loại bỏ các thẻ `<final>` khỏi văn bản assistant trước khi lưu.
  - Loại bỏ các lượt lỗi trống của assistant.
  - Cắt bớt nội dung assistant sau các tool call.

This complexity caused cross-provider regressions (notably `openai-responses`
`call_id|fc_id` pairing). Đợt dọn dẹp ngày 2026.1.22 đã loại bỏ extension, tập trung logic vào runner và khiến OpenAI **không cần can thiệp** ngoài việc làm sạch hình ảnh.
