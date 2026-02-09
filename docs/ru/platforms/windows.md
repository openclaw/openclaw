---
summary: "Поддержка Windows (WSL2) + статус сопутствующего приложения"
read_when:
  - Установка OpenClaw в Windows
  - Поиск статуса сопутствующего приложения для Windows
title: "Windows (WSL2)"
---

# Windows (WSL2)

Использование OpenClaw в Windows рекомендуется **через WSL2** (рекомендуется Ubuntu). CLI + Gateway работают внутри Linux, что обеспечивает единообразие среды выполнения и делает инструменты значительно более совместимыми (Node/Bun/pnpm, бинарники Linux, skills). Нативная Windows-среда может быть более сложной. WSL2 даёт полноценный опыт Linux — установка одной командой: `wsl --install`.

Нативные сопутствующие приложения для Windows планируются.

## Установка (WSL2)

- [Начало работы](/start/getting-started) (используйте внутри WSL)
- [Установка и обновления](/install/updating)
- Официальное руководство по WSL2 (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Руководство по эксплуатации Gateway](/gateway)
- [Конфигурация](/gateway/configuration)

## Установка сервиса Gateway (CLI)

Внутри WSL2:

```
openclaw onboard --install-daemon
```

Или:

```
openclaw gateway install
```

Или:

```
openclaw configure
```

При запросе выберите **Gateway service**.

Восстановление/миграция:

```
openclaw doctor
```

## Дополнительно: публикация сервисов WSL в LAN (portproxy)

WSL имеет собственную виртуальную сеть. Если другой машине нужно получить доступ к сервису,
запущенному **внутри WSL** (SSH, локальный TTS‑сервер или Gateway), необходимо
пробросить порт Windows на текущий IP WSL. IP WSL меняется после перезапусков,
поэтому правило проброса может потребоваться обновлять.

Пример (PowerShell **от имени администратора**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Разрешите порт в брандмауэре Windows (один раз):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Обновляйте portproxy после перезапуска WSL:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

Примечания:

- SSH с другой машины нацелен на **IP хоста Windows** (пример: `ssh user@windows-host -p 2222`).
- Удалённые узлы должны указывать **доступный** URL Gateway (не `127.0.0.1`); используйте
  `openclaw status --all` для проверки.
- Используйте `listenaddress=0.0.0.0` для доступа из LAN; `127.0.0.1` оставляет доступ только локальным.
- Если требуется автоматизация, зарегистрируйте задачу Планировщика для выполнения шага обновления
  при входе в систему.

## Пошаговая установка WSL2

### 1. Установите WSL2 + Ubuntu

Откройте PowerShell (Администратор):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Перезагрузитесь, если Windows запросит.

### 2. Включите systemd (требуется для установки Gateway)

В терминале WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Затем из PowerShell:

```powershell
wsl --shutdown
```

Снова откройте Ubuntu и проверьте:

```bash
systemctl --user status
```

### 3. Установите OpenClaw (внутри WSL)

Следуйте процессу «Начало работы» для Linux внутри WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

Полное руководство: [Начало работы](/start/getting-started)

## Сопутствующее приложение для Windows

В настоящее время сопутствующего приложения для Windows нет. Мы приветствуем вклад сообщества, если вы хотите помочь сделать его реальностью.
