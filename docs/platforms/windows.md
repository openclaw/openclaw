---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Windows (WSL2) support + companion app status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Installing OpenClaw on Windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Looking for Windows companion app status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Windows (WSL2)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Windows (WSL2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw on Windows is recommended **via WSL2** (Ubuntu recommended). The（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI + Gateway run inside Linux, which keeps the runtime consistent and makes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tooling far more compatible (Node/Bun/pnpm, Linux binaries, skills). Native（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Windows might be trickier. WSL2 gives you the full Linux experience — one command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to install: `wsl --install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Native Windows companion apps are planned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install (WSL2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Getting Started](/start/getting-started) (use inside WSL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Install & updates](/install/updating)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Official WSL2 guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway runbook](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway service install (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inside WSL2:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Select **Gateway service** when prompted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Repair/migrate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced: expose WSL services over LAN (portproxy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WSL has its own virtual network. If another machine needs to reach a service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
running **inside WSL** (SSH, a local TTS server, or the Gateway), you must（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
forward a Windows port to the current WSL IP. The WSL IP changes after restarts,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
so you may need to refresh the forwarding rule.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (PowerShell **as Administrator**):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$Distro = "Ubuntu-24.04"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$ListenPort = 2222（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$TargetPort = 22（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if (-not $WslIp) { throw "WSL IP not found." }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  connectaddress=$WslIp connectport=$TargetPort（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allow the port through Windows Firewall (one-time):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -Protocol TCP -LocalPort $ListenPort -Action Allow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Refresh the portproxy after WSL restarts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  connectaddress=$WslIp connectport=$TargetPort | Out-Null（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH from another machine targets the **Windows host IP** (example: `ssh user@windows-host -p 2222`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote nodes must point at a **reachable** Gateway URL (not `127.0.0.1`); use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw status --all` to confirm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `listenaddress=0.0.0.0` for LAN access; `127.0.0.1` keeps it local only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you want this automatic, register a Scheduled Task to run the refresh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  step at login.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Step-by-step WSL2 install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Install WSL2 + Ubuntu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open PowerShell (Admin):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wsl --install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or pick a distro explicitly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wsl --list --online（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wsl --install -d Ubuntu-24.04（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reboot if Windows asks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Enable systemd (required for gateway install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In your WSL terminal:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tee /etc/wsl.conf >/dev/null <<'EOF'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[boot]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemd=true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then from PowerShell:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wsl --shutdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Re-open Ubuntu, then verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Install OpenClaw (inside WSL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Follow the Linux Getting Started flow inside WSL:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build # auto-installs UI deps on first run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full guide: [Getting Started](/start/getting-started)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Windows companion app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We do not have a Windows companion app yet. Contributions are welcome if you want（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
contributions to make it happen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
