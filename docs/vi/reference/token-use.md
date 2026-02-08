---
summary: "Cách OpenClaw xây dựng ngữ cảnh prompt và báo cáo mức sử dụng token + chi phí"
read_when:
  - Giải thích về mức sử dụng token, chi phí hoặc cửa sổ ngữ cảnh
  - Gỡ lỗi sự tăng trưởng ngữ cảnh hoặc hành vi nén gọn
title: "Sử dụng Token và Chi phí"
x-i18n:
  source_path: reference/token-use.md
  source_hash: f8bfadb36b51830c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:21Z
---

# Sử dụng token & chi phí

OpenClaw theo dõi **token**, không phải ký tự. Token phụ thuộc vào từng mô hình, nhưng
hầu hết các mô hình kiểu OpenAI trung bình khoảng ~4 ký tự cho mỗi token đối với văn bản tiếng Anh.

## Cách system prompt được xây dựng

OpenClaw tự lắp ráp system prompt của riêng mình ở mỗi lần chạy. Nó bao gồm:

- Danh sách công cụ + mô tả ngắn
- Danh sách Skills (chỉ metadata; hướng dẫn được tải theo yêu cầu với `read`)
- Hướng dẫn tự cập nhật
- Workspace + các tệp bootstrap (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` khi có tệp mới). Các tệp lớn được cắt bớt bởi `agents.defaults.bootstrapMaxChars` (mặc định: 20000).
- Thời gian (UTC + múi giờ người dùng)
- Thẻ trả lời + hành vi heartbeat
- Metadata runtime (máy chủ/OS/mô hình/tư duy)

Xem phân tích chi tiết đầy đủ tại [System Prompt](/concepts/system-prompt).

## Những gì được tính trong cửa sổ ngữ cảnh

Mọi thứ mà mô hình nhận được đều được tính vào giới hạn ngữ cảnh:

- System prompt (tất cả các phần được liệt kê ở trên)
- Lịch sử hội thoại (tin nhắn của người dùng + trợ lý)
- Lệnh gọi công cụ và kết quả công cụ
- Đính kèm/bản ghi (hình ảnh, âm thanh, tệp)
- Các bản tóm tắt nén gọn và tạo tác cắt tỉa
- Lớp bao của nhà cung cấp hoặc tiêu đề an toàn (không hiển thị, nhưng vẫn được tính)

Để xem phân tích thực tế (theo từng tệp được chèn, công cụ, Skills và kích thước system prompt), hãy dùng `/context list` hoặc `/context detail`. Xem thêm tại [Context](/concepts/context).

## Cách xem mức sử dụng token hiện tại

Sử dụng các lệnh sau trong chat:

- `/status` → **thẻ trạng thái nhiều emoji** hiển thị mô hình của phiên, mức sử dụng ngữ cảnh,
  token đầu vào/đầu ra của phản hồi gần nhất và **chi phí ước tính** (chỉ với khóa API).
- `/usage off|tokens|full` → thêm **chân trang mức sử dụng theo từng phản hồi** vào mọi câu trả lời.
  - Duy trì theo từng phiên (được lưu dưới dạng `responseUsage`).
  - Xác thực OAuth **ẩn chi phí** (chỉ hiển thị token).
- `/usage cost` → hiển thị bản tổng hợp chi phí cục bộ từ log phiên OpenClaw.

Các bề mặt khác:

- **TUI/Web TUI:** hỗ trợ `/status` + `/usage`.
- **CLI:** `openclaw status --usage` và `openclaw channels list` hiển thị
  cửa sổ hạn mức của nhà cung cấp (không phải chi phí theo từng phản hồi).

## Ước tính chi phí (khi được hiển thị)

Chi phí được ước tính dựa trên cấu hình giá mô hình của bạn:

```
models.providers.<provider>.models[].cost
```

Đây là **USD cho mỗi 1M token** đối với `input`, `output`, `cacheRead` và
`cacheWrite`. Nếu thiếu thông tin giá, OpenClaw chỉ hiển thị token. Token OAuth
không bao giờ hiển thị chi phí bằng đô la.

## Ảnh hưởng của cache TTL và cắt tỉa

Cơ chế cache prompt của nhà cung cấp chỉ áp dụng trong phạm vi thời gian TTL của cache. OpenClaw có thể
tùy chọn chạy **cắt tỉa cache-ttl**: nó cắt tỉa phiên khi TTL của cache
đã hết hạn, sau đó đặt lại cửa sổ cache để các yêu cầu tiếp theo có thể tái sử dụng
ngữ cảnh vừa được cache thay vì phải cache lại toàn bộ lịch sử. Điều này giúp
giảm chi phí ghi cache khi một phiên bị nhàn rỗi vượt quá TTL.

Cấu hình tại [Gateway configuration](/gateway/configuration) và xem chi tiết hành vi tại [Session pruning](/concepts/session-pruning).

Heartbeat có thể giữ cache ở trạng thái **warm** trong các khoảng trống nhàn rỗi. Nếu TTL cache của mô hình của bạn
là `1h`, việc đặt khoảng heartbeat thấp hơn một chút (ví dụ: `55m`) có thể tránh
việc phải cache lại toàn bộ prompt, từ đó giảm chi phí ghi cache.

Đối với giá API của Anthropic, việc đọc cache rẻ hơn đáng kể so với token đầu vào,
trong khi ghi cache được tính phí với hệ số cao hơn. Xem bảng giá cache prompt mới nhất
và các hệ số TTL của Anthropic tại:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Ví dụ: giữ cache 1h ở trạng thái warm với heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Mẹo giảm áp lực token

- Dùng `/compact` để tóm tắt các phiên dài.
- Cắt bớt đầu ra lớn của công cụ trong quy trình làm việc.
- Giữ mô tả skill ngắn gọn (danh sách skill được chèn vào prompt).
- Ưu tiên các mô hình nhỏ hơn cho công việc khám phá, nhiều lời.

Xem [Skills](/tools/skills) để biết công thức chính xác cho chi phí overhead của danh sách skill.
