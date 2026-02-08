---
title: "Quy trình phát triển Pi"
x-i18n:
  source_path: pi-dev.md
  source_hash: b6c44672306d8867
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:31Z
---

# Quy trình phát triển Pi

Hướng dẫn này tóm tắt một quy trình hợp lý để làm việc với tích hợp Pi trong OpenClaw.

## Kiểm tra kiểu và linting

- Kiểm tra kiểu và build: `pnpm build`
- Lint: `pnpm lint`
- Kiểm tra định dạng: `pnpm format`
- Cổng kiểm tra đầy đủ trước khi đẩy mã: `pnpm lint && pnpm build && pnpm test`

## Chạy các bài kiểm tra Pi

Sử dụng script chuyên dụng cho bộ kiểm tra tích hợp Pi:

```bash
scripts/pi/run-tests.sh
```

Để bao gồm bài kiểm tra live mô phỏng hành vi thực của nhà cung cấp:

```bash
scripts/pi/run-tests.sh --live
```

Script sẽ chạy tất cả các bài kiểm tra đơn vị liên quan đến Pi thông qua các glob sau:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Kiểm thử thủ công

Quy trình khuyến nghị:

- Chạy gateway ở chế độ dev:
  - `pnpm gateway:dev`
- Kích hoạt tác tử trực tiếp:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Sử dụng TUI để gỡ lỗi tương tác:
  - `pnpm tui`

Đối với hành vi gọi công cụ, hãy prompt cho một hành động `read` hoặc `exec` để bạn có thể quan sát việc stream công cụ và xử lý payload.

## Đặt lại trạng thái sạch

Trạng thái được lưu dưới thư mục trạng thái của OpenClaw. Mặc định là `~/.openclaw`. Nếu `OPENCLAW_STATE_DIR` được đặt, hãy sử dụng thư mục đó thay thế.

Để đặt lại mọi thứ:

- `openclaw.json` cho cấu hình
- `credentials/` cho hồ sơ xác thực và token
- `agents/<agentId>/sessions/` cho lịch sử phiên của tác tử
- `agents/<agentId>/sessions.json` cho chỉ mục phiên
- `sessions/` nếu tồn tại các đường dẫn legacy
- `workspace/` nếu bạn muốn một workspace trống

Nếu bạn chỉ muốn đặt lại các phiên, hãy xóa `agents/<agentId>/sessions/` và `agents/<agentId>/sessions.json` cho tác tử đó. Giữ `credentials/` nếu bạn không muốn xác thực lại.

## Tài liệu tham khảo

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
