---
summary: "Quy trình định dạng Markdown cho các kênh gửi ra"
read_when:
  - Bạn đang thay đổi định dạng Markdown hoặc cơ chế chunking cho các kênh gửi ra
  - Bạn đang thêm một formatter kênh mới hoặc ánh xạ kiểu dáng
  - Bạn đang gỡ lỗi các lỗi hồi quy về định dạng giữa các kênh
title: "Định dạng Markdown"
---

# Định dạng Markdown

10. OpenClaw định dạng Markdown đầu ra bằng cách chuyển đổi nó sang một biểu diễn trung gian dùng chung (IR) trước khi render đầu ra theo từng kênh. The IR keeps the
    source text intact while carrying style/link spans so chunking and rendering can
    stay consistent across channels.

## Mục tiêu

- **Tính nhất quán:** một bước parse, nhiều renderer.
- **Chunking an toàn:** tách văn bản trước khi render để định dạng inline không bao giờ
  bị vỡ giữa các chunk.
- **Phù hợp từng kênh:** ánh xạ cùng một IR sang Slack mrkdwn, Telegram HTML và các dải kiểu
  của Signal mà không cần parse lại Markdown.

## Pipeline

1. **Parse Markdown -> IR**
   - IR là văn bản thuần cộng với các span kiểu dáng (đậm/nghiêng/gạch/xóa/code/spoiler) và span liên kết.
   - Offset dùng đơn vị UTF-16 code unit để các dải kiểu của Signal khớp với API của nó.
   - Bảng chỉ được parse khi một kênh chọn tham gia chuyển đổi bảng.
2. **Chunk IR (ưu tiên định dạng)**
   - Chunking diễn ra trên văn bản IR trước khi render.
   - Định dạng inline không bị tách qua các chunk; các span được cắt theo từng chunk.
3. **Render theo kênh**
   - **Slack:** token mrkdwn (đậm/nghiêng/gạch/xóa/code), liên kết dưới dạng `<url|label>`.
   - **Telegram:** thẻ HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** văn bản thuần + các dải `text-style`; liên kết trở thành `label (url)` khi nhãn khác URL.

## Ví dụ IR

Markdown đầu vào:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (sơ đồ):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Nơi được sử dụng

- Các adapter gửi ra của Slack, Telegram và Signal render từ IR.
- Các kênh khác (WhatsApp, iMessage, MS Teams, Discord) vẫn dùng văn bản thuần hoặc
  quy tắc định dạng riêng của chúng, với việc chuyển đổi bảng Markdown được áp dụng trước
  khi chunking khi được bật.

## Xử lý bảng

Markdown tables are not consistently supported across chat clients. 11. Sử dụng `markdown.tables` để kiểm soát việc chuyển đổi theo từng kênh (và theo từng tài khoản).

- `code`: render bảng thành khối code (mặc định cho hầu hết các kênh).
- `bullets`: chuyển mỗi hàng thành các gạch đầu dòng (mặc định cho Signal + WhatsApp).
- `off`: tắt parse và chuyển đổi bảng; văn bản bảng thô được giữ nguyên.

Khóa cấu hình:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Quy tắc chunking

- Giới hạn chunk đến từ adapter/cấu hình của kênh và được áp dụng lên văn bản IR.
- Khối code fence được giữ như một khối duy nhất với dấu xuống dòng ở cuối để các kênh
  render đúng.
- Tiền tố danh sách và tiền tố blockquote là một phần của văn bản IR, nên chunking
  không tách giữa chừng tiền tố.
- Các kiểu inline (đậm/nghiêng/gạch/xóa/inline-code/spoiler) không bao giờ bị tách
  qua các chunk; renderer sẽ mở lại kiểu trong mỗi chunk.

Nếu bạn cần thêm thông tin về hành vi chunking giữa các kênh, xem
[Streaming + chunking](/concepts/streaming).

## Chính sách liên kết

- 12. **Slack:** `[label](url)` -> `<url|label>`; URL trần vẫn giữ nguyên. Autolink
      is disabled during parse to avoid double-linking.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (chế độ parse HTML).
- **Signal:** `[label](url)` -> `label (url)` trừ khi nhãn trùng với URL.

## Spoiler

13. Dấu đánh dấu spoiler (`||spoiler||`) chỉ được phân tích cho Signal, nơi chúng được ánh xạ thành các vùng kiểu SPOILER. Other channels treat them as plain text.

## Cách thêm hoặc cập nhật một formatter kênh

1. **Parse một lần:** dùng helper dùng chung `markdownToIR(...)` với các tùy chọn
   phù hợp cho kênh (autolink, kiểu heading, tiền tố blockquote).
2. **Render:** triển khai một renderer với `renderMarkdownWithMarkers(...)` và một
   bản đồ marker kiểu (hoặc các dải kiểu của Signal).
3. **Chunk:** gọi `chunkMarkdownIR(...)` trước khi render; render từng chunk.
4. **Kết nối adapter:** cập nhật adapter gửi ra của kênh để dùng chunker
   và renderer mới.
5. **Kiểm thử:** thêm hoặc cập nhật các bài test định dạng và một bài test gửi ra
   nếu kênh có dùng chunking.

## Các lỗi thường gặp

- Các token ngoặc nhọn của Slack (`<@U123>`, `<#C123>`, `<https://...>`) phải được
  giữ nguyên; escape HTML thô một cách an toàn.
- HTML của Telegram yêu cầu escape văn bản ngoài thẻ để tránh hỏng markup.
- Các dải kiểu của Signal phụ thuộc vào offset UTF-16; không dùng offset theo code point.
- Giữ lại dấu xuống dòng ở cuối cho các khối code fence để marker đóng nằm trên dòng riêng của chúng.
