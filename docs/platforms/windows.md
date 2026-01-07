---
summary: "Windows (WSL2) setup + companion app status"
read_when:
  - Installing Clawdbot on Windows
  - Looking for Windows companion app status
  - Planning platform coverage or contributions
---
# Windows (WSL2)

Clawdbot runs on Windows **via WSL2** (Ubuntu recommended). WSL2 is **strongly
recommended**; native Windows installs are untested and more problematic. Use
WSL2 and follow the Linux flow inside it.

## How to install this correctly

Start here (official WSL2 guide): https://learn.microsoft.com/windows/wsl/install

### 1) Install WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reboot if Windows asks.

### 2) Enable systemd (required for daemon install)

In your WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Re-open Ubuntu, then verify:

```bash
systemctl --user status
```

### 3) Install Clawdbot (inside WSL)

Follow the Linux Getting Started flow inside WSL:

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
pnpm ui:install
pnpm ui:build
pnpm build
pnpm clawdbot onboard
```

Full guide: [Getting Started](/getting-started)

## Windows companion app

We do not have a Windows companion app yet. It is planned, and we would love
contributions to make it happen.
