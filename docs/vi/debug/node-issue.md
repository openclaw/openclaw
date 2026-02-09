---
summary: Ghi chú sự cố và các cách khắc phục cho lỗi crash Node + tsx "__name is not a function"
read_when:
  - Gỡ lỗi các script dev chỉ dùng Node hoặc lỗi ở chế độ watch
  - Điều tra các sự cố crash của loader tsx/esbuild trong OpenClaw
title: "Sự cố Node + tsx"
---

# Sự cố Node + tsx "\_\_name is not a function"

## Summary

Chạy OpenClaw qua Node với `tsx` bị lỗi ngay khi khởi động với:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Điều này bắt đầu sau khi chuyển các script dev từ Bun sang `tsx` (commit `2871657e`, 2026-01-06). Cùng một đường dẫn runtime đã hoạt động với Bun.

## Environment

- Node: v25.x (quan sát trên v25.3.0)
- tsx: 4.21.0
- OS: macOS (khả năng tái hiện cũng cao trên các nền tảng khác chạy Node 25)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node version check

- Node 25.3.0: lỗi
- Node 22.22.0 (Homebrew `node@22`): lỗi
- Node 24: chưa cài ở đây; cần xác minh

## Notes / hypothesis

- `tsx` dùng esbuild để biến đổi TS/ESM. Tùy chọn `keepNames` của esbuild phát ra helper `__name` và bao bọc các định nghĩa hàm bằng `__name(...)`.
- Lỗi cho thấy `__name` tồn tại nhưng không phải là một hàm tại runtime, điều này ngụ ý helper bị thiếu hoặc bị ghi đè đối với module này trong đường loader của Node 25.
- Các vấn đề helper `__name` tương tự đã được báo cáo ở các consumer khác của esbuild khi helper bị thiếu hoặc bị ghi lại.

## Regression history

- `2871657e` (2026-01-06): script được chuyển từ Bun sang tsx để Bun trở thành tùy chọn.
- Trước đó (đường Bun), `openclaw status` và `gateway:watch` hoạt động.

## Workarounds

- Dùng Bun cho các script dev (tạm thời quay lại cách này).

- Dùng Node + tsc watch, sau đó chạy đầu ra đã biên dịch:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Đã xác nhận cục bộ: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` hoạt động trên Node 25.

- Tắt keepNames của esbuild trong TS loader nếu có thể (ngăn chèn helper `__name`); hiện tsx chưa cung cấp tùy chọn này.

- Thử Node LTS (22/24) với `tsx` để xem sự cố có đặc thù Node 25 hay không.

## References

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Next steps

- Tái hiện trên Node 22/24 để xác nhận hồi quy ở Node 25.
- Thử `tsx` nightly hoặc ghim về phiên bản sớm hơn nếu có hồi quy đã biết.
- Nếu tái hiện trên Node LTS, tạo một repro tối giản upstream kèm theo stack trace `__name`.
