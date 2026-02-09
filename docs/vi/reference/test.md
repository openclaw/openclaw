---
summary: "Cách chạy test cục bộ (vitest) và khi nào dùng các chế độ force/coverage"
read_when:
  - Chạy hoặc sửa test
title: "Kiểm thử"
---

# Kiểm thử

- Bộ công cụ kiểm thử đầy đủ (suite, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Kills any lingering gateway process holding the default control port, then runs the full Vitest suite with an isolated gateway port so server tests don’t collide with a running instance. Use this when a prior gateway run left port 18789 occupied.

- `pnpm test:coverage`: Runs Vitest with V8 coverage. 4. Ngưỡng toàn cục là 70% cho lines/branches/functions/statements. Coverage excludes integration-heavy entrypoints (CLI wiring, gateway/telegram bridges, webchat static server) to keep the target focused on unit-testable logic.

- `pnpm test:e2e`: Chạy các smoke test end-to-end của gateway (ghép cặp WS/HTTP/node đa instance).

- 5. `pnpm test:live`: Chạy các bài kiểm thử live của provider (minimax/zai). Requires API keys and `LIVE=1` (or provider-specific `*_LIVE_TEST=1`) to unskip.

## Benchmark độ trễ mô hình (khóa cục bộ)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Cách dùng:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Biến môi trường tùy chọn: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. No punctuation or extra text.”

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
