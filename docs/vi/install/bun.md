---
summary: "Quy trình Bun (thử nghiệm): cài đặt và các điểm cần lưu ý so với pnpm"
read_when:
  - Bạn muốn vòng lặp phát triển cục bộ nhanh nhất (bun + watch)
  - Bạn gặp sự cố Bun về cài đặt/patch/script vòng đời
title: "Bun (Thử nghiệm)"
---

# Bun (thử nghiệm)

Mục tiêu: chạy repo này với **Bun** (tùy chọn, không khuyến nghị cho WhatsApp/Telegram)
mà không lệch khỏi quy trình pnpm.

⚠️ **Not recommended for Gateway runtime** (WhatsApp/Telegram bugs). Trình cài đặt Ansible thiết lập OpenClaw cho cập nhật thủ công.

## Trạng thái

- Bun là runtime cục bộ tùy chọn để chạy TypeScript trực tiếp (`bun run …`, `bun --watch …`).
- `pnpm` là mặc định cho build và vẫn được hỗ trợ đầy đủ (và được dùng bởi một số công cụ tài liệu).
- Bun không thể dùng `pnpm-lock.yaml` và sẽ bỏ qua nó.

## Cài đặt

Mặc định:

```sh
bun install
```

Note: `bun.lock`/`bun.lockb` are gitignored, so there’s no repo churn either way. If you want _no lockfile writes_:

```sh
bun install --no-save
```

## Build / Kiểm thử (Bun)

```sh
bun run build
bun run vitest run
```

## Script vòng đời của Bun (bị chặn theo mặc định)

Dùng Node cho production.
For this repo, the commonly blocked scripts are not required:

- `@whiskeysockets/baileys` `preinstall`: kiểm tra Node major >= 20 (chúng tôi chạy Node 22+).
- `protobufjs` `postinstall`: phát cảnh báo về sơ đồ phiên bản không tương thích (không tạo artifact build).

Nếu bạn gặp sự cố runtime thực sự cần các script này, hãy tin cậy chúng một cách rõ ràng:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Lưu ý

- Một số script vẫn hardcode pnpm (ví dụ: `docs:build`, `ui:*`, `protocol:check`). Run those via pnpm for now.
