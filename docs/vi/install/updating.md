---
summary: "Cập nhật OpenClaw an toàn (cài đặt toàn cục hoặc từ mã nguồn), kèm chiến lược khôi phục"
read_when:
  - Cập nhật OpenClaw
  - Có sự cố sau khi cập nhật
title: "Cập nhật"
---

# Cập nhật

OpenClaw is moving fast (pre “1.0”). Treat updates like shipping infra: update → run checks → restart (or use `openclaw update`, which restarts) → verify.

## Khuyến nghị: chạy lại trình cài đặt từ website (nâng cấp tại chỗ)

The **preferred** update path is to re-run the installer from the website. It
detects existing installs, upgrades in place, and runs `openclaw doctor` when
needed.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Ghi chú:

- Thêm `--no-onboard` nếu bạn không muốn trình hướng dẫn ban đầu chạy lại.

- Với **cài đặt từ mã nguồn**, dùng:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Trình cài đặt sẽ `git pull --rebase` **chỉ** khi repo sạch.

- Với **cài đặt toàn cục**, script sử dụng `npm install -g openclaw@latest` ở bên dưới.

- Ghi chú kế thừa: `clawdbot` vẫn khả dụng như một lớp tương thích.

## Trước khi cập nhật

- Biết cách bạn đã cài đặt: **toàn cục** (npm/pnpm) hay **từ mã nguồn** (git clone).
- Biết Gateway của bạn đang chạy thế nào: **terminal foreground** hay **dịch vụ được giám sát** (launchd/systemd).
- Chụp snapshot các tùy chỉnh của bạn:
  - Cấu hình: `~/.openclaw/openclaw.json`
  - Thông tin xác thực: `~/.openclaw/credentials/`
  - Workspace: `~/.openclaw/workspace`

## Cập nhật (cài đặt toàn cục)

Cài đặt toàn cục (chọn một):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Chúng tôi **không** khuyến nghị Bun cho runtime của Gateway (lỗi WhatsApp/Telegram).

Để chuyển kênh cập nhật (cài đặt git + npm):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Dùng `--tag <dist-tag|version>` cho việc cài đặt một lần theo tag/phiên bản.

Xem [Development channels](/install/development-channels) để biết ngữ nghĩa kênh và ghi chú phát hành.

Note: on npm installs, the gateway logs an update hint on startup (checks the current channel tag). Disable via `update.checkOnStart: false`.

Sau đó:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Ghi chú:

- Nếu Gateway của bạn chạy như một dịch vụ, `openclaw gateway restart` được ưu tiên hơn việc kill PID.
- Nếu bạn đang ghim vào một phiên bản cụ thể, xem “Khôi phục / ghim phiên bản” bên dưới.

## Cập nhật (`openclaw update`)

Với **cài đặt từ mã nguồn** (git checkout), ưu tiên:

```bash
openclaw update
```

Lệnh này chạy một quy trình cập nhật tương đối an toàn:

- Yêu cầu worktree sạch.
- Chuyển sang kênh đã chọn (tag hoặc branch).
- Fetch + rebase với upstream đã cấu hình (kênh dev).
- Cài deps, build, build Control UI, và chạy `openclaw doctor`.
- Khởi động lại gateway theo mặc định (dùng `--no-restart` để bỏ qua).

If you installed via **npm/pnpm** (no git metadata), `openclaw update` will try to update via your package manager. If it can’t detect the install, use “Update (global install)” instead.

## Cập nhật (Control UI / RPC)

The Control UI has **Update & Restart** (RPC: `update.run`). It:

1. Chạy cùng quy trình cập nhật từ mã nguồn như `openclaw update` (chỉ git checkout).
2. Ghi một sentinel khởi động lại kèm báo cáo có cấu trúc (đuôi stdout/stderr).
3. Khởi động lại gateway và ping phiên đang hoạt động gần nhất với báo cáo.

Nếu rebase thất bại, gateway sẽ hủy và khởi động lại mà không áp dụng cập nhật.

## Cập nhật (từ mã nguồn)

Từ repo checkout:

Ưu tiên:

```bash
openclaw update
```

Thủ công (tương đương):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Ghi chú:

- `pnpm build` quan trọng khi bạn chạy binary `openclaw` đã đóng gói ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) hoặc dùng Node để chạy `dist/`.
- Nếu bạn chạy từ repo checkout mà không có cài đặt toàn cục, dùng `pnpm openclaw ...` cho các lệnh CLI.
- Nếu bạn chạy trực tiếp từ TypeScript (`pnpm openclaw ...`), thường không cần rebuild, nhưng **các migration cấu hình vẫn áp dụng** → chạy doctor.
- Việc chuyển giữa cài đặt toàn cục và git rất dễ: cài kiểu còn lại, rồi chạy `openclaw doctor` để entrypoint dịch vụ gateway được ghi lại theo bản cài đặt hiện tại.

## Luôn chạy: `openclaw doctor`

Doctor is the “safe update” command. It’s intentionally boring: repair + migrate + warn.

Lưu ý: nếu bạn đang dùng **cài đặt từ mã nguồn** (git checkout), `openclaw doctor` sẽ đề nghị chạy `openclaw update` trước.

Những việc điển hình nó làm:

- Migrate các khóa cấu hình đã bị loại bỏ / vị trí file cấu hình kế thừa.
- Kiểm tra chính sách DM và cảnh báo các thiết lập “mở” rủi ro.
- Kiểm tra tình trạng Gateway và có thể đề nghị khởi động lại.
- Phát hiện và migrate các dịch vụ gateway cũ (launchd/systemd; schtasks kế thừa) sang dịch vụ OpenClaw hiện tại.
- Trên Linux, đảm bảo systemd user lingering (để Gateway tồn tại sau khi đăng xuất).

Chi tiết: [Doctor](/gateway/doctor)

## Bắt đầu / dừng / khởi động lại Gateway

CLI (hoạt động независимо hệ điều hành):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Nếu bạn dùng giám sát:

- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (use `bot.molt.<profile>`; legacy `com.openclaw.*` still works)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` chỉ hoạt động nếu dịch vụ đã được cài; nếu không, chạy `openclaw gateway install`.

Runbook + nhãn dịch vụ chính xác: [Gateway runbook](/gateway)

## Khôi phục / ghim phiên bản (khi có sự cố)

### Ghim (cài đặt toàn cục)

Cài một phiên bản đã biết là ổn (thay `<version>` bằng phiên bản hoạt động tốt gần nhất):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Mẹo: để xem phiên bản đang được phát hành, chạy `npm view openclaw version`.

Sau đó khởi động lại + chạy lại doctor:

```bash
openclaw doctor
openclaw gateway restart
```

### Ghim (từ mã nguồn) theo ngày

Chọn một commit theo ngày (ví dụ: “trạng thái của main tại 2026-01-01”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Sau đó cài lại deps + khởi động lại:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Nếu sau này bạn muốn quay lại bản mới nhất:

```bash
git checkout main
git pull
```

## Nếu bạn bị kẹt

- Chạy lại `openclaw doctor` và đọc kỹ đầu ra (thường nó sẽ chỉ ra cách khắc phục).
- Xem: [Xử lý sự cố](/gateway/troubleshooting)
- Hỏi trên Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
