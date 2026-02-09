---
summary: "Obsługa Windows (WSL2) + status aplikacji towarzyszącej"
read_when:
  - Instalowanie OpenClaw na Windows
  - Szukanie informacji o statusie aplikacji towarzyszącej na Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

Uruchamianie OpenClaw na Windows jest zalecane **przez WSL2** (rekomendowane Ubuntu). CLI + Gateway działają wewnątrz Linuksa, co utrzymuje spójne środowisko uruchomieniowe i znacząco poprawia kompatybilność narzędzi (Node/Bun/pnpm, binaria Linuksa, Skills). Natywny Windows może być trudniejszy. WSL2 zapewnia pełne doświadczenie Linuksa — jedna komenda do instalacji: `wsl --install`.

Natywne aplikacje towarzyszące na Windows są planowane.

## Install (WSL2)

- [Getting Started](/start/getting-started) (użyj wewnątrz WSL)
- [Install & updates](/install/updating)
- Oficjalny przewodnik WSL2 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Instalacja usługi Gateway (CLI)

Wewnątrz WSL2:

```
openclaw onboard --install-daemon
```

Lub:

```
openclaw gateway install
```

Lub:

```
openclaw configure
```

Po wyświetleniu monitu wybierz **Gateway service**.

Naprawa/migracja:

```
openclaw doctor
```

## Zaawansowane: udostępnianie usług WSL w LAN (portproxy)

WSL ma własną sieć wirtualną. Jeśli inna maszyna ma łączyć się z usługą
uruchomioną **wewnątrz WSL** (SSH, lokalny serwer TTS lub Gateway), musisz
przekierować port Windows na bieżący adres IP WSL. Adres IP WSL zmienia się po
restartach, więc może być konieczne odświeżenie reguły przekierowania.

Przykład (PowerShell **jako Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Zezwól na port w Zaporze Windows (jednorazowo):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Odśwież portproxy po restartach WSL:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Uwagi:

- SSH z innej maszyny kieruj na **adres IP hosta Windows** (przykład: `ssh user@windows-host -p 2222`).
- Zdalne węzły muszą wskazywać **osiągalny** adres URL Gateway (nie `127.0.0.1`); użyj
  `openclaw status --all`, aby potwierdzić.
- Do dostępu z LAN użyj `listenaddress=0.0.0.0`; `127.0.0.1` ogranicza dostęp wyłącznie lokalnie.
- Jeśli chcesz automatyzacji, zarejestruj Zaplanowane Zadanie uruchamiające krok
  odświeżania przy logowaniu.

## Instalacja WSL2 krok po kroku

### 1. Zainstaluj WSL2 + Ubuntu

Otwórz PowerShell (Administrator):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Uruchom ponownie system, jeśli Windows o to poprosi.

### 2. Włącz systemd (wymagane do instalacji Gateway)

W terminalu WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Następnie w PowerShell:

```powershell
wsl --shutdown
```

Ponownie otwórz Ubuntu, a następnie zweryfikuj:

```bash
systemctl --user status
```

### 3. Zainstaluj OpenClaw (wewnątrz WSL)

Postępuj zgodnie z przepływem Pierwsze kroki dla Linuksa wewnątrz WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Pełny przewodnik: [Getting Started](/start/getting-started)

## Aplikacja towarzysząca na Windows

Obecnie nie mamy aplikacji towarzyszącej na Windows. Wkład społeczności jest mile widziany, jeśli chcesz pomóc w jej powstaniu.
