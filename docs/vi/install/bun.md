---
summary: "Quy trình Bun (thử nghiệm): cài đặt và các điểm cần lưu ý so với pnpm"
read_when:
  - Bạn muốn vòng lặp phát triển cục bộ nhanh nhất (bun + watch)
  - Bạn gặp sự cố Bun về cài đặt/patch/script vòng đời
title: "Bun (Thử nghiệm)"
x-i18n:
  source_path: install/bun.md
  source_hash: eb3f4c222b6bae49
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:17Z
---

# Bun (thử nghiệm)

Mục tiêu: chạy repo này với **Bun** (tùy chọn, không khuyến nghị cho WhatsApp/Telegram)
mà không lệch khỏi quy trình pnpm.

⚠️ **Không khuyến nghị cho runtime của Gateway** (lỗi WhatsApp/Telegram). Dùng Node cho production.

## Trạng thái

- Bun là runtime cục bộ tùy chọn để chạy TypeScript trực tiếp (`bun run …`, `bun --watch …`).
- `pnpm` là mặc định cho build và vẫn được hỗ trợ đầy đủ (và được dùng bởi một số công cụ tài liệu).
- Bun không thể dùng `pnpm-lock.yaml` và sẽ bỏ qua nó.

## Cài đặt

Mặc định:

```sh
bun install
```

Lưu ý: `bun.lock`/`bun.lockb` đã được gitignore, nên không gây thay đổi repo theo cách nào. Nếu bạn muốn _không ghi lockfile_:

```sh
bun install --no-save
```

## Build / Kiểm thử (Bun)

```sh
bun run build
bun run vitest run
```

## Script vòng đời của Bun (bị chặn theo mặc định)

Bun có thể chặn các script vòng đời của dependency trừ khi được tin cậy rõ ràng (`bun pm untrusted` / `bun pm trust`).
Với repo này, các script thường bị chặn là không cần thiết:

- `@whiskeysockets/baileys` `preinstall`: kiểm tra Node major >= 20 (chúng tôi chạy Node 22+).
- `protobufjs` `postinstall`: phát cảnh báo về sơ đồ phiên bản không tương thích (không tạo artifact build).

Nếu bạn gặp sự cố runtime thực sự cần các script này, hãy tin cậy chúng một cách rõ ràng:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Lưu ý

- Một số script vẫn hardcode pnpm (ví dụ: `docs:build`, `ui:*`, `protocol:check`). Tạm thời hãy chạy các script đó bằng pnpm.
