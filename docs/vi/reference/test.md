---
summary: "Cách chạy test cục bộ (vitest) và khi nào dùng các chế độ force/coverage"
read_when:
  - Chạy hoặc sửa test
title: "Kiểm thử"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:09Z
---

# Kiểm thử

- Bộ công cụ kiểm thử đầy đủ (suite, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Dừng mọi tiến trình gateway còn tồn đọng đang giữ cổng điều khiển mặc định, sau đó chạy toàn bộ suite Vitest với cổng gateway được cô lập để các bài test máy chủ không va chạm với một instance đang chạy. Dùng khi lần chạy gateway trước để lại cổng 18789 bị chiếm.
- `pnpm test:coverage`: Chạy Vitest với coverage V8. Ngưỡng toàn cục là 70% cho lines/branches/functions/statements. Coverage loại trừ các entrypoint nặng tích hợp (kết nối CLI, cầu nối gateway/telegram, máy chủ webchat tĩnh) để tập trung mục tiêu vào logic có thể kiểm thử bằng unit test.
- `pnpm test:e2e`: Chạy các smoke test end-to-end của gateway (ghép cặp WS/HTTP/node đa instance).
- `pnpm test:live`: Chạy các bài test live của provider (minimax/zai). Yêu cầu khóa API và `LIVE=1` (hoặc `*_LIVE_TEST=1` theo từng provider) để bỏ qua trạng thái skip.

## Benchmark độ trễ mô hình (khóa cục bộ)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Cách dùng:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Biến môi trường tùy chọn: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Prompt mặc định: “Trả lời bằng một từ duy nhất: ok. Không dấu câu hoặc văn bản bổ sung.”

Lần chạy gần nhất (2025-12-31, 20 lượt):

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Docker là tùy chọn; chỉ cần cho các smoke test onboarding chạy trong container.

Luồng khởi động nguội đầy đủ trong một container Linux sạch:

```bash
scripts/e2e/onboard-docker.sh
```

Script này điều khiển trình hướng dẫn tương tác qua pseudo-tty, xác minh các tệp config/workspace/session, sau đó khởi động gateway và chạy `openclaw health`.

## Smoke test nhập QR (Docker)

Đảm bảo `qrcode-terminal` tải được dưới Node 22+ trong Docker:

```bash
pnpm test:docker:qr
```
