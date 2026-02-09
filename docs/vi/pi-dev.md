---
title: "Quy trình phát triển Pi"
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

6. Trạng thái nằm dưới thư mục state của OpenClaw. 7. Mặc định là `~/.openclaw`. 8. Nếu đặt `OPENCLAW_STATE_DIR`, hãy dùng thư mục đó thay thế.

Để đặt lại mọi thứ:

- `openclaw.json` cho cấu hình
- `credentials/` cho hồ sơ xác thực và token
- `agents/<agentId>/sessions/` cho lịch sử phiên của tác tử
- `agents/<agentId>/sessions.json` cho chỉ mục phiên
- `sessions/` nếu tồn tại các đường dẫn legacy
- `workspace/` nếu bạn muốn một workspace trống

9. Nếu bạn chỉ muốn reset session, hãy xóa `agents/<agentId>/sessions/` và `agents/<agentId>/sessions.json` cho agent đó. 10. Giữ lại `credentials/` nếu bạn không muốn xác thực lại.

## Tài liệu tham khảo

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
