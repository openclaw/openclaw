---
summary: "Полное удаление OpenClaw (CLI, сервис, состояние, рабочее пространство)"
read_when:
  - Вы хотите удалить OpenClaw с машины
  - Сервис Gateway (шлюз) продолжает работать после удаления
title: "Удаление"
---

# Удаление

Два пути:

- **Простой путь**, если `openclaw` всё ещё установлен.
- **Ручное удаление сервиса**, если CLI отсутствует, но сервис продолжает работать.

## Простой путь (CLI всё ещё установлен)

Рекомендуется: используйте встроенный деинсталлятор:

```bash
openclaw uninstall
```

Неинтерактивно (автоматизация / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Ручные шаги (тот же результат):

1. Остановите сервис Gateway (шлюз):

```bash
openclaw gateway stop
```

2. Удалите сервис Gateway (шлюз) (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Удалите состояние + конфигурацию:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Если вы устанавливали `OPENCLAW_CONFIG_PATH` в пользовательское расположение вне каталога состояния, удалите и этот файл.

4. Удалите рабочее пространство (необязательно, удаляет файлы агентов):

```bash
rm -rf ~/.openclaw/workspace
```

5. Удалите установку CLI (выберите тот способ, который вы использовали):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Если вы устанавливали приложение для macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

Примечания:

- Если вы использовали профили (`--profile` / `OPENCLAW_PROFILE`), повторите шаг 3 для каждого каталога состояния (значения по умолчанию — `~/.openclaw-<profile>`).
- В удалённом режиме каталог состояния находится на **хосте шлюза Gateway**, поэтому выполните шаги 1–4 и там.

## Ручное удаление сервиса (CLI не установлен)

Используйте этот вариант, если сервис Gateway (шлюз) продолжает работать, но `openclaw` отсутствует.

### macOS (launchd)

Метка по умолчанию — `bot.molt.gateway` (или `bot.molt.<profile>`; устаревшая `com.openclaw.*` может всё ещё существовать):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Если вы использовали профиль, замените метку и имя plist на `bot.molt.<profile>`. При наличии удалите все устаревшие plist `com.openclaw.*`.

### Linux (пользовательский unit systemd)

Имя unit по умолчанию — `openclaw-gateway.service` (или `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Запланированная задача)

Имя задачи по умолчанию — `OpenClaw Gateway` (или `OpenClaw Gateway (<profile>)`).
Скрипт задачи находится в вашем каталоге состояния.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Если вы использовали профиль, удалите соответствующее имя задачи и `~\.openclaw-<profile>\gateway.cmd`.

## Обычная установка vs установка из исходников

### Обычная установка (install.sh / npm / pnpm / bun)

Если вы использовали `https://openclaw.ai/install.sh` или `install.ps1`, CLI был установлен с помощью `npm install -g openclaw@latest`.
Удалите его с помощью `npm rm -g openclaw` (или `pnpm remove -g` / `bun remove -g`, если вы устанавливали таким способом).

### Установка из исходников (git clone)

Если вы запускали из клона репозитория (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Удалите сервис Gateway (шлюз) **перед** удалением репозитория (используйте простой путь выше или ручное удаление сервиса).
2. Удалите каталог репозитория.
3. Удалите состояние + рабочее пространство, как показано выше.
