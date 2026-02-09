---
summary: "Kiểm toán những thứ có thể phát sinh chi phí, khóa nào được dùng và cách xem mức sử dụng"
read_when:
  - Bạn muốn hiểu những tính năng nào có thể gọi các API trả phí
  - Bạn cần kiểm toán khóa, chi phí và khả năng hiển thị mức sử dụng
  - Bạn đang giải thích báo cáo chi phí /status hoặc /usage
title: "Mức sử dụng API và chi phí"
---

# Mức sử dụng API & chi phí

11. Tài liệu này liệt kê **các tính năng có thể gọi API key** và nơi chi phí của chúng hiển thị. Nó tập trung vào
    các tính năng OpenClaw có thể tạo ra mức sử dụng nhà cung cấp hoặc các cuộc gọi API trả phí.

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
- **Skills** (`skills.entries.<name>`Những người bạn đồng hành debug tốt nhất là những người lo lắng về code để con người không phải lo.

## Các tính năng có thể tiêu tốn khóa

### 1. Phản hồi mô hình cốt lõi (chat + công cụ)

8. Mọi phản hồi hoặc lời gọi công cụ đều sử dụng **nhà cung cấp mô hình hiện tại** (OpenAI, Anthropic, v.v.). 17. Media đầu vào có thể được tóm tắt/chuyển biên trước khi phản hồi chạy.

Xem [Models](/providers/models) để cấu hình giá và [Token use & costs](/reference/token-use) để xem hiển thị.

### 2. Hiểu nội dung media (audio/hình ảnh/video)

Media inbound có thể được tóm tắt/ghi âm thành văn bản trước khi chạy phản hồi. 19. Một số lệnh trạng thái gọi **các endpoint sử dụng của nhà cung cấp** để hiển thị cửa sổ hạn mức hoặc tình trạng xác thực.

- Audio: OpenAI / Groq / Deepgram (hiện **tự động bật** khi có khóa).
- Hình ảnh: OpenAI / Anthropic / Google.
- Video: Google.

Xem [Media understanding](/nodes/media-understanding).

### 3. Embedding bộ nhớ + tìm kiếm ngữ nghĩa

Tìm kiếm bộ nhớ ngữ nghĩa dùng **API embedding** khi cấu hình cho nhà cung cấp từ xa:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- Tùy chọn fallback sang nhà cung cấp từ xa nếu embedding cục bộ thất bại

Bạn có thể giữ xử lý cục bộ với `memorySearch.provider = "local"` (không dùng API).

Xem [Memory](/concepts/memory).

### 4. Công cụ tìm kiếm web (Brave / Perplexity qua OpenRouter)

`web_search` dùng API key và có thể phát sinh chi phí:

- **Brave Search API**: `BRAVE_API_KEY` hoặc `tools.web.search.apiKey`
- **Perplexity** (qua OpenRouter): `PERPLEXITY_API_KEY` hoặc `OPENROUTER_API_KEY`

**Gói miễn phí của Brave (hào phóng):**

- **2.000 yêu cầu/tháng**
- **1 yêu cầu/giây**
- **Yêu cầu thẻ tín dụng** để xác minh (không bị tính phí trừ khi nâng cấp)

Xem [Web tools](/tools/web).

### 5. Công cụ tải web (Firecrawl)

`web_fetch` có thể gọi **Firecrawl** khi có API key:

- `FIRECRAWL_API_KEY` hoặc `tools.web.fetch.firecrawl.apiKey`

Nếu Firecrawl chưa được cấu hình, công cụ sẽ fallback sang tải trực tiếp + readability (không dùng API trả phí).

Xem [Web tools](/tools/web).

### 6. Ảnh chụp mức sử dụng nhà cung cấp (trạng thái/sức khỏe)

Một số lệnh trạng thái gọi **các endpoint sử dụng của nhà cung cấp** để hiển thị cửa sổ hạn ngạch hoặc tình trạng xác thực.
Đây thường là các cuộc gọi khối lượng thấp nhưng vẫn chạm vào API của nhà cung cấp:

- `openclaw status --usage`
- `openclaw models status --json`

Xem [Models CLI](/cli/models).

### 7. Tóm tắt bảo vệ compaction

Cơ chế bảo vệ compaction có thể tóm tắt lịch sử phiên bằng **mô hình hiện tại**, vì vậy sẽ
gọi API của nhà cung cấp khi chạy.

Xem [Session management + compaction](/reference/session-management-compaction).

### 8. Quét/thăm dò mô hình

`openclaw models scan` có thể thăm dò các mô hình OpenRouter và dùng `OPENROUTER_API_KEY` khi
bật thăm dò.

Xem [Models CLI](/cli/models).

### 9. Talk (giọng nói)

Chế độ Talk có thể gọi **ElevenLabs** khi được cấu hình:

- `ELEVENLABS_API_KEY` hoặc `talk.apiKey`

Xem [Talk mode](/nodes/talk).

### 10. Skills (API bên thứ ba)

23. Nếu một skill sử dụng khóa đó cho các API bên ngoài,
    APIs, nó có thể phát sinh chi phí theo nhà cung cấp của skill.`.apiKey`. 25. (Một AI, có lẽ đang phê token)

Xem [Skills](/tools/skills).
