---
summary: "Hỗ trợ Windows (WSL2) + trạng thái ứng dụng đồng hành"
read_when:
  - Cài đặt OpenClaw trên Windows
  - Tìm trạng thái ứng dụng đồng hành trên Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw on Windows is recommended **via WSL2** (Ubuntu recommended). The
CLI + Gateway run inside Linux, which keeps the runtime consistent and makes
tooling far more compatible (Node/Bun/pnpm, Linux binaries, skills). Native
Windows might be trickier. WSL2 gives you the full Linux experience — one command
to install: `wsl --install`.

Ứng dụng đồng hành native cho Windows đang được lên kế hoạch.

## Cài đặt (WSL2)

- [Bắt đầu](/start/getting-started) (dùng bên trong WSL)
- [Cài đặt & cập nhật](/install/updating)
- Hướng dẫn WSL2 chính thức (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Runbook Gateway](/gateway)
- [Cấu hình](/gateway/configuration)

## Cài đặt dịch vụ Gateway (CLI)

Bên trong WSL2:

```
openclaw onboard --install-daemon
```

Hoặc:

```
openclaw gateway install
```

Hoặc:

```
openclaw configure
```

Chọn **Gateway service** khi được hỏi.

Sửa chữa/di chuyển:

```
openclaw doctor
```

## Nâng cao: mở dịch vụ WSL ra LAN (portproxy)

WSL has its own virtual network. If another machine needs to reach a service
running **inside WSL** (SSH, a local TTS server, or the Gateway), you must
forward a Windows port to the current WSL IP. The WSL IP changes after restarts,
so you may need to refresh the forwarding rule.

Ví dụ (PowerShell **chạy với quyền Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Cho phép cổng đi qua Windows Firewall (một lần):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Làm mới portproxy sau khi WSL khởi động lại:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Ghi chú:

- SSH từ máy khác nhắm tới **IP của máy chủ Windows** (ví dụ: `ssh user@windows-host -p 2222`).
- Các node từ xa phải trỏ tới một URL Gateway **có thể truy cập được** (không phải `127.0.0.1`); dùng
  `openclaw status --all` để xác nhận.
- Dùng `listenaddress=0.0.0.0` để truy cập LAN; `127.0.0.1` chỉ giữ truy cập cục bộ.
- Nếu muốn tự động, hãy đăng ký một Scheduled Task để chạy bước làm mới
  khi đăng nhập.

## Cài đặt WSL2 từng bước

### 1. Cài đặt WSL2 + Ubuntu

Mở PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Khởi động lại nếu Windows yêu cầu.

### 2. Bật systemd (bắt buộc cho cài đặt gateway)

Trong terminal WSL của bạn:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Sau đó từ PowerShell:

```powershell
wsl --shutdown
```

Mở lại Ubuntu, rồi kiểm tra:

```bash
systemctl --user status
```

### 3. Cài đặt OpenClaw (bên trong WSL)

Làm theo luồng Bắt đầu cho Linux bên trong WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Hướng dẫn đầy đủ: [Bắt đầu](/start/getting-started)

## Ứng dụng đồng hành trên Windows

We do not have a Windows companion app yet. Contributions are welcome if you want
contributions to make it happen.
