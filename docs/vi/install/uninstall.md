---
summary: "Gỡ cài đặt OpenClaw hoàn toàn (CLI, dịch vụ, trạng thái, workspace)"
read_when:
  - Bạn muốn gỡ OpenClaw khỏi một máy
  - Dịch vụ Gateway vẫn chạy sau khi gỡ cài đặt
title: "Gỡ cài đặt"
---

# Gỡ cài đặt

Có hai cách:

- **Cách dễ** nếu `openclaw` vẫn còn được cài.
- **Gỡ dịch vụ thủ công** nếu CLI đã bị xóa nhưng dịch vụ vẫn đang chạy.

## Cách dễ (CLI vẫn còn)

Khuyến nghị: dùng trình gỡ cài đặt tích hợp sẵn:

```bash
openclaw uninstall
```

Không tương tác (tự động hóa / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Các bước thủ công (kết quả tương đương):

1. Dừng dịch vụ Gateway:

```bash
openclaw gateway stop
```

2. Gỡ dịch vụ Gateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Xóa trạng thái + cấu hình:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Nếu bạn đặt `OPENCLAW_CONFIG_PATH` ở vị trí tùy chỉnh bên ngoài thư mục trạng thái, hãy xóa cả tệp đó.

4. Xóa workspace của bạn (tùy chọn, sẽ xóa các tệp tác tử):

```bash
rm -rf ~/.openclaw/workspace
```

5. Gỡ cài đặt CLI (chọn cách bạn đã dùng):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Nếu bạn đã cài ứng dụng macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

Ghi chú:

- Nếu bạn dùng profile (`--profile` / `OPENCLAW_PROFILE`), hãy lặp lại bước 3 cho từng thư mục trạng thái (mặc định là `~/.openclaw-<profile>`).
- Ở chế độ từ xa, thư mục trạng thái nằm trên **máy chủ gateway**, vì vậy hãy chạy các bước 1–4 ở đó nữa.

## Gỡ dịch vụ thủ công (không cài CLI)

Dùng cách này nếu dịch vụ Gateway vẫn chạy nhưng `openclaw` không còn.

### macOS (launchd)

Default label is `bot.molt.gateway` (or `bot.molt.<profile>Nếu bạn đã dùng profile, hãy thay thế nhãn và tên plist bằng `bot.molt.<profile>
\`.

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

If you used a profile, replace the label and plist name with `bot.molt.<profile>`. Remove any legacy `com.openclaw.*` plists if present.

### Linux (systemd user unit)

Tên unit mặc định là `openclaw-gateway.service` (hoặc `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `OpenClaw Gateway` (or `OpenClaw Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Nếu bạn dùng profile, hãy xóa tên tác vụ tương ứng và `~\.openclaw-<profile>\gateway.cmd`.

## Cài đặt thông thường vs checkout từ nguồn

### Cài đặt thông thường (install.sh / npm / pnpm / bun)

If you used `https://openclaw.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g openclaw@latest`.
Remove it with `npm rm -g openclaw` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Checkout từ nguồn (git clone)

Nếu bạn chạy từ một bản checkout của repo (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Gỡ dịch vụ Gateway **trước khi** xóa repo (dùng cách dễ ở trên hoặc gỡ dịch vụ thủ công).
2. Xóa thư mục repo.
3. Xóa trạng thái + workspace như đã nêu ở trên.
