---
summary: "Windows (WSL2)-ondersteuning + status van companion-app"
read_when:
  - OpenClaw installeren op Windows
  - Zoeken naar de status van de Windows companion-app
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw op Windows wordt aanbevolen **via WSL2** (Ubuntu aanbevolen). De
CLI + Gateway draaien binnen Linux, wat de runtime consistent houdt en de
compatibiliteit van tooling aanzienlijk vergroot (Node/Bun/pnpm, Linux-binaries, Skills). Native Windows kan lastiger zijn. WSL2 geeft je de volledige Linux-ervaring — één opdracht
om te installeren: `wsl --install`.

Native Windows companion-apps staan gepland.

## Installeren (WSL2)

- [Aan de slag](/start/getting-started) (gebruik binnen WSL)
- [Installatie & updates](/install/updating)
- Officiële WSL2-handleiding (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway-runbook](/gateway)
- [Configuratie](/gateway/configuration)

## Gateway-service installeren (CLI)

Binnen WSL2:

```
openclaw onboard --install-daemon
```

Of:

```
openclaw gateway install
```

Of:

```
openclaw configure
```

Selecteer **Gateway service** wanneer daarom wordt gevraagd.

Repareren/migreren:

```
openclaw doctor
```

## Geavanceerd: WSL-services via LAN beschikbaar maken (portproxy)

WSL heeft een eigen virtueel netwerk. Als een andere machine een service moet
bereiken die **binnen WSL** draait (SSH, een lokale TTS-server of de Gateway), moet je
een Windows-poort doorsturen naar het huidige WSL-IP. Het WSL-IP verandert na herstarts,
dus mogelijk moet je de doorstuurregel vernieuwen.

Voorbeeld (PowerShell **als Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Sta de poort toe in Windows Firewall (eenmalig):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Vernieuw de portproxy na WSL-herstarts:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Notities:

- SSH vanaf een andere machine richt zich op het **Windows host-IP** (voorbeeld: `ssh user@windows-host -p 2222`).
- Externe nodes moeten wijzen naar een **bereikbare** Gateway-URL (niet `127.0.0.1`); gebruik
  `openclaw status --all` om te bevestigen.
- Gebruik `listenaddress=0.0.0.0` voor LAN-toegang; `127.0.0.1` houdt het alleen lokaal.
- Als je dit automatisch wilt, registreer een Geplande Taak om de verversingsstap
  bij het inloggen uit te voeren.

## Stap-voor-stap WSL2-installatie

### 1. Installeer WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Herstart als Windows daarom vraagt.

### 2. systemd inschakelen (vereist voor Gateway-installatie)

In je WSL-terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Daarna vanuit PowerShell:

```powershell
wsl --shutdown
```

Open Ubuntu opnieuw en controleer vervolgens:

```bash
systemctl --user status
```

### 3. OpenClaw installeren (binnen WSL)

Volg de Linux-flow **Aan de slag** binnen WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Volledige handleiding: [Aan de slag](/start/getting-started)

## Windows companion-app

We hebben nog geen Windows companion-app. Bijdragen zijn welkom als je wilt helpen
om dit mogelijk te maken.
