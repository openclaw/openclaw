---
summary: "Suporta sa Windows (WSL2) + status ng companion app"
read_when:
  - Nag-i-install ng OpenClaw sa Windows
  - Naghahanap ng status ng Windows companion app
title: "Windows (WSL2)"
x-i18n:
  source_path: platforms/windows.md
  source_hash: d17df1bd5636502e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:44Z
---

# Windows (WSL2)

Inirerekomenda ang OpenClaw sa Windows **sa pamamagitan ng WSL2** (inirerekomenda ang Ubuntu). Ang
CLI + Gateway ay tumatakbo sa loob ng Linux, na nagpapanatiling consistent ang runtime at ginagawang
mas compatible ang tooling (Node/Bun/pnpm, Linux binaries, Skills). Maaaring mas tricky ang native
Windows. Binibigay ng WSL2 ang buong Linux experience — isang command lang para mag-install:
`wsl --install`.

Pinaplano ang mga native Windows companion app.

## Install (WSL2)

- [Pagsisimula](/start/getting-started) (gamitin sa loob ng WSL)
- [Install at mga update](/install/updating)
- Opisyal na WSL2 guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Konpigurasyon](/gateway/configuration)

## Gateway service install (CLI)

Sa loob ng WSL2:

```
openclaw onboard --install-daemon
```

O kaya:

```
openclaw gateway install
```

O kaya:

```
openclaw configure
```

Piliin ang **Gateway service** kapag na-prompt.

Ayusin/migrate:

```
openclaw doctor
```

## Advanced: i-expose ang mga WSL service sa LAN (portproxy)

May sarili itong virtual network ang WSL. Kung kailangan ng ibang machine na maabot ang isang service
na tumatakbo **sa loob ng WSL** (SSH, isang local TTS server, o ang Gateway), kailangan mong
i-forward ang isang Windows port papunta sa kasalukuyang WSL IP. Nagbabago ang WSL IP pagkatapos ng
mga restart, kaya maaaring kailangan mong i-refresh ang forwarding rule.

Halimbawa (PowerShell **bilang Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Payagan ang port sa Windows Firewall (isang beses lang):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

I-refresh ang portproxy pagkatapos mag-restart ang WSL:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Mga tala:

- Ang SSH mula sa ibang machine ay tumatarget sa **Windows host IP** (halimbawa: `ssh user@windows-host -p 2222`).
- Dapat ituro ng mga remote node ang isang **naaabot** na Gateway URL (hindi `127.0.0.1`); gamitin ang
  `openclaw status --all` para mag-confirm.
- Gamitin ang `listenaddress=0.0.0.0` para sa LAN access; pinapanatiling lokal lang ng `127.0.0.1`.
- Kung gusto mo itong awtomatiko, mag-register ng Scheduled Task para patakbuhin ang refresh
  step sa login.

## Step-by-step na WSL2 install

### 1) I-install ang WSL2 + Ubuntu

Buksan ang PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Mag-reboot kung hihingin ng Windows.

### 2) I-enable ang systemd (kinakailangan para sa Gateway install)

Sa iyong WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Pagkatapos, mula sa PowerShell:

```powershell
wsl --shutdown
```

Buksan muli ang Ubuntu, saka i-verify:

```bash
systemctl --user status
```

### 3) I-install ang OpenClaw (sa loob ng WSL)

Sundin ang Linux Getting Started flow sa loob ng WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Buong gabay: [Pagsisimula](/start/getting-started)

## Windows companion app

Wala pa kaming Windows companion app sa ngayon. Bukas ang kontribusyon kung gusto mong
tumulong para magawa ito.
