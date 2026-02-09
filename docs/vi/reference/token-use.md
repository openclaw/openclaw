---
summary: "Cách OpenClaw xây dựng ngữ cảnh prompt và báo cáo mức sử dụng token + chi phí"
read_when:
  - Giải thích về mức sử dụng token, chi phí hoặc cửa sổ ngữ cảnh
  - Gỡ lỗi sự tăng trưởng ngữ cảnh hoặc hành vi nén gọn
title: "Sử dụng Token và Chi phí"
---

# Sử dụng token & chi phí

OpenClaw tracks **tokens**, not characters. Tokens are model-specific, but most
OpenAI-style models average ~4 characters per token for English text.

## Cách system prompt được xây dựng

OpenClaw assembles its own system prompt on every run. It includes:

- Danh sách công cụ + mô tả ngắn
- Danh sách Skills (chỉ metadata; hướng dẫn được tải theo yêu cầu với `read`)
- Hướng dẫn tự cập nhật
- Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` when new). 6. Các tệp lớn bị cắt bớt bởi `agents.defaults.bootstrapMaxChars` (mặc định: 20000).
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

7. Để xem phân tích thực tế (theo từng tệp được chèn, công cụ, kỹ năng và kích thước system prompt), hãy dùng `/context list` hoặc `/context detail`. 8. Xem [Context](/concepts/context).

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

9. Đây là **USD trên mỗi 1M token** cho `input`, `output`, `cacheRead` và
   `cacheWrite`. 10. Nếu thiếu thông tin giá, OpenClaw chỉ hiển thị số token. OAuth tokens
   never show dollar cost.

## Ảnh hưởng của cache TTL và cắt tỉa

11. Bộ nhớ đệm prompt của provider chỉ áp dụng trong phạm vi TTL của cache. OpenClaw can
    optionally run **cache-ttl pruning**: it prunes the session once the cache TTL
    has expired, then resets the cache window so subsequent requests can re-use the
    freshly cached context instead of re-caching the full history. This keeps cache
    write costs lower when a session goes idle past the TTL.

Cấu hình tại [Gateway configuration](/gateway/configuration) và xem chi tiết hành vi tại [Session pruning](/concepts/session-pruning).

Heartbeat can keep the cache **warm** across idle gaps. If your model cache TTL
is `1h`, setting the heartbeat interval just under that (e.g., `55m`) can avoid
re-caching the full prompt, reducing cache write costs.

For Anthropic API pricing, cache reads are significantly cheaper than input
tokens, while cache writes are billed at a higher multiplier. 12. Xem bảng giá prompt caching của Anthropic để biết mức giá và hệ số TTL mới nhất:
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
