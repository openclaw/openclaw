---
summary: "Kiểm toán những thứ có thể phát sinh chi phí, khóa nào được dùng và cách xem mức sử dụng"
read_when:
  - Bạn muốn hiểu những tính năng nào có thể gọi các API trả phí
  - Bạn cần kiểm toán khóa, chi phí và khả năng hiển thị mức sử dụng
  - Bạn đang giải thích báo cáo chi phí /status hoặc /usage
title: "Mức sử dụng API và chi phí"
x-i18n:
  source_path: reference/api-usage-costs.md
  source_hash: 908bfc17811b8f4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:07Z
---

# Mức sử dụng API & chi phí

Tài liệu này liệt kê **các tính năng có thể gọi API key** và nơi hiển thị chi phí của chúng. Tài liệu tập trung vào
các tính năng của OpenClaw có thể tạo ra mức sử dụng nhà cung cấp hoặc các lệnh gọi API trả phí.

## Chi phí hiển thị ở đâu (chat + CLI)

**Ảnh chụp chi phí theo phiên**

- `/status` hiển thị mô hình của phiên hiện tại, mức sử dụng ngữ cảnh và số token của phản hồi gần nhất.
- Nếu mô hình dùng **xác thực bằng API key**, `/status` cũng hiển thị **chi phí ước tính** cho phản hồi cuối.

**Chân trang chi phí theo từng tin nhắn**

- `/usage full` thêm chân trang mức sử dụng vào mọi phản hồi, bao gồm **chi phí ước tính** (chỉ API key).
- `/usage tokens` chỉ hiển thị token; các luồng OAuth ẩn chi phí tiền tệ.

**Cửa sổ mức sử dụng CLI (hạn mức nhà cung cấp)**

- `openclaw status --usage` và `openclaw channels list` hiển thị **cửa sổ mức sử dụng** của nhà cung cấp
  (ảnh chụp hạn mức, không phải chi phí theo từng tin nhắn).

Xem [Token use & costs](/reference/token-use) để biết chi tiết và ví dụ.

## Cách phát hiện khóa

OpenClaw có thể nhận thông tin xác thực từ:

- **Hồ sơ xác thực** (theo từng tác tử, lưu trong `auth-profiles.json`).
- **Biến môi trường** (ví dụ `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Cấu hình** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) có thể xuất khóa vào env của tiến trình skill.

## Các tính năng có thể tiêu tốn khóa

### 1) Phản hồi mô hình cốt lõi (chat + công cụ)

Mọi phản hồi hoặc lệnh gọi công cụ đều dùng **nhà cung cấp mô hình hiện tại** (OpenAI, Anthropic, v.v.). Đây là
nguồn sử dụng và chi phí chính.

Xem [Models](/providers/models) để cấu hình giá và [Token use & costs](/reference/token-use) để xem hiển thị.

### 2) Hiểu nội dung media (audio/hình ảnh/video)

Media đầu vào có thể được tóm tắt/chuyển biên trước khi chạy phản hồi. Việc này dùng API của mô hình/nhà cung cấp.

- Audio: OpenAI / Groq / Deepgram (hiện **tự động bật** khi có khóa).
- Hình ảnh: OpenAI / Anthropic / Google.
- Video: Google.

Xem [Media understanding](/nodes/media-understanding).

### 3) Embedding bộ nhớ + tìm kiếm ngữ nghĩa

Tìm kiếm bộ nhớ ngữ nghĩa dùng **API embedding** khi cấu hình cho nhà cung cấp từ xa:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- Tùy chọn fallback sang nhà cung cấp từ xa nếu embedding cục bộ thất bại

Bạn có thể giữ xử lý cục bộ với `memorySearch.provider = "local"` (không dùng API).

Xem [Memory](/concepts/memory).

### 4) Công cụ tìm kiếm web (Brave / Perplexity qua OpenRouter)

`web_search` dùng API key và có thể phát sinh chi phí:

- **Brave Search API**: `BRAVE_API_KEY` hoặc `tools.web.search.apiKey`
- **Perplexity** (qua OpenRouter): `PERPLEXITY_API_KEY` hoặc `OPENROUTER_API_KEY`

**Gói miễn phí của Brave (hào phóng):**

- **2.000 yêu cầu/tháng**
- **1 yêu cầu/giây**
- **Yêu cầu thẻ tín dụng** để xác minh (không bị tính phí trừ khi nâng cấp)

Xem [Web tools](/tools/web).

### 5) Công cụ tải web (Firecrawl)

`web_fetch` có thể gọi **Firecrawl** khi có API key:

- `FIRECRAWL_API_KEY` hoặc `tools.web.fetch.firecrawl.apiKey`

Nếu Firecrawl chưa được cấu hình, công cụ sẽ fallback sang tải trực tiếp + readability (không dùng API trả phí).

Xem [Web tools](/tools/web).

### 6) Ảnh chụp mức sử dụng nhà cung cấp (trạng thái/sức khỏe)

Một số lệnh trạng thái gọi **endpoint mức sử dụng của nhà cung cấp** để hiển thị cửa sổ hạn mức hoặc tình trạng xác thực.
Những lệnh này thường có lưu lượng thấp nhưng vẫn gọi API của nhà cung cấp:

- `openclaw status --usage`
- `openclaw models status --json`

Xem [Models CLI](/cli/models).

### 7) Tóm tắt bảo vệ compaction

Cơ chế bảo vệ compaction có thể tóm tắt lịch sử phiên bằng **mô hình hiện tại**, vì vậy sẽ
gọi API của nhà cung cấp khi chạy.

Xem [Session management + compaction](/reference/session-management-compaction).

### 8) Quét/thăm dò mô hình

`openclaw models scan` có thể thăm dò các mô hình OpenRouter và dùng `OPENROUTER_API_KEY` khi
bật thăm dò.

Xem [Models CLI](/cli/models).

### 9) Talk (giọng nói)

Chế độ Talk có thể gọi **ElevenLabs** khi được cấu hình:

- `ELEVENLABS_API_KEY` hoặc `talk.apiKey`

Xem [Talk mode](/nodes/talk).

### 10) Skills (API bên thứ ba)

Skills có thể lưu `apiKey` trong `skills.entries.<name>.apiKey`. Nếu một skill dùng khóa đó cho
API bên ngoài, nó có thể phát sinh chi phí theo nhà cung cấp của skill.

Xem [Skills](/tools/skills).
