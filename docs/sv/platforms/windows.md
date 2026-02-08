---
summary: "Windows-stöd (WSL2) + status för companion-app"
read_when:
  - Installera OpenClaw på Windows
  - Söker status för Windows companion-app
title: "Windows (WSL2)"
x-i18n:
  source_path: platforms/windows.md
  source_hash: d17df1bd5636502e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:06Z
---

# Windows (WSL2)

OpenClaw på Windows rekommenderas **via WSL2** (Ubuntu rekommenderas). CLI + Gateway körs inuti Linux, vilket håller körmiljön konsekvent och gör verktyg betydligt mer kompatibla (Node/Bun/pnpm, Linux-binärer, Skills). Native Windows kan vara knepigare. WSL2 ger dig hela Linux-upplevelsen — ett kommando för att installera: `wsl --install`.

Native Windows companion-appar är planerade.

## Installera (WSL2)

- [Kom igång](/start/getting-started) (använd inuti WSL)
- [Installera & uppdateringar](/install/updating)
- Officiell WSL2-guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway-runbook](/gateway)
- [Konfiguration](/gateway/configuration)

## Installera Gateway-tjänst (CLI)

Inuti WSL2:

```
openclaw onboard --install-daemon
```

Eller:

```
openclaw gateway install
```

Eller:

```
openclaw configure
```

Välj **Gateway service** när du blir tillfrågad.

Reparera/migrera:

```
openclaw doctor
```

## Avancerat: exponera WSL-tjänster över LAN (portproxy)

WSL har sitt eget virtuella nätverk. Om en annan maskin behöver nå en tjänst
som körs **inuti WSL** (SSH, en lokal TTS-server eller Gateway), måste du
vidarebefordra en Windows-port till den aktuella WSL-IP:n. WSL-IP:n ändras efter omstarter,
så du kan behöva uppdatera vidarebefordringsregeln.

Exempel (PowerShell **som administratör**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Tillåt porten genom Windows-brandväggen (engångs):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Uppdatera portproxy efter att WSL startats om:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Noteringar:

- SSH från en annan maskin riktar sig mot **Windows-värdens IP** (exempel: `ssh user@windows-host -p 2222`).
- Fjärrnoder måste peka på en **nåbar** Gateway-URL (inte `127.0.0.1`); använd
  `openclaw status --all` för att bekräfta.
- Använd `listenaddress=0.0.0.0` för LAN-åtkomst; `127.0.0.1` håller det endast lokalt.
- Om du vill ha detta automatiskt, registrera en schemalagd aktivitet som kör
  uppdateringssteget vid inloggning.

## Steg-för-steg WSL2-installation

### 1) Installera WSL2 + Ubuntu

Öppna PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Starta om om Windows ber om det.

### 2) Aktivera systemd (krävs för Gateway-installation)

I din WSL-terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Sedan från PowerShell:

```powershell
wsl --shutdown
```

Öppna Ubuntu igen och verifiera:

```bash
systemctl --user status
```

### 3) Installera OpenClaw (inuti WSL)

Följ Linux-flödet för Kom igång inuti WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Fullständig guide: [Kom igång](/start/getting-started)

## Windows companion-app

Vi har ännu ingen Windows companion-app. Bidrag välkomnas om du vill hjälpa till
att få den på plats.
