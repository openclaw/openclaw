---
summary: "Windows-understøttelse (WSL2) + status for companion-app"
read_when:
  - Installerer OpenClaw på Windows
  - Leder efter status for Windows companion-app
title: "Windows (WSL2)"
---

# Windows (WSL2)

OpenClaw på Windows anbefales \*\* via WSL2\*\* (Ubuntu anbefales).
CLI + Gateway kører inde i Linux, som holder driftstiden konsistent og gør
værktøjer langt mere kompatible (Node/Bun/pnpm, Linux binære, færdigheder). Native
Windows kan være trickier. WSL2 giver dig den fulde Linux-oplevelse — én kommando
til at installere: `wsl --install`.

Native Windows companion-apps er planlagt.

## Installér (WSL2)

- [Kom godt i gang](/start/getting-started) (brug inde i WSL)
- [Installering og opdateringer](/install/updating)
- Officiel WSL2-vejledning (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway-runbook](/gateway)
- [Konfiguration](/gateway/configuration)

## Installation af Gateway-tjeneste (CLI)

Inde i WSL2:

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

Vælg **Gateway service** når du bliver spurgt.

Reparation/migrering:

```
openclaw doctor
```

## Avanceret: eksponér WSL-tjenester over LAN (portproxy)

WSL har sit eget virtuelle netværk. Hvis en anden maskine skal nå en tjeneste
kører **inde WSL** (SSH, en lokal TTS server, eller Gateway), skal du
videresende en Windows-port til den aktuelle WSL IP. WSL IP ændrer sig efter genstart,
, så du kan være nødt til at opdatere den viderestillingsreglen.

Eksempel (PowerShell **som administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Tillad porten gennem Windows Firewall (én gang):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Opdatér portproxy efter WSL-genstarter:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Noter:

- SSH fra en anden maskine peger på **Windows-værtens IP** (eksempel: `ssh user@windows-host -p 2222`).
- Fjernnoder skal pege på en **tilgængelig** Gateway-URL (ikke `127.0.0.1`); brug
  `openclaw status --all` til at bekræfte.
- Brug `listenaddress=0.0.0.0` til LAN-adgang; `127.0.0.1` holder det kun lokalt.
- Hvis du vil have dette automatisk, kan du registrere en Planlagt opgave, der kører
  opdateringstrinnet ved login.

## Trin-for-trin WSL2-installation

### 1. Installér WSL2 + Ubuntu

Åbn PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Genstart, hvis Windows beder om det.

### 2. Aktivér systemd (krævet for Gateway-installation)

I din WSL-terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Derefter fra PowerShell:

```powershell
wsl --shutdown
```

Åbn Ubuntu igen, og verificér:

```bash
systemctl --user status
```

### 3. Installér OpenClaw (inde i WSL)

Følg Linux-flowet Kom godt i gang inde i WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Fuld vejledning: [Kom godt i gang](/start/getting-started)

## Windows companion-app

Vi har ikke en Windows følgesvend app endnu. Bidrag er velkomne, hvis du vil have
bidrag til at få det til at ske.
