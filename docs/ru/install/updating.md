---
summary: "Безопасное обновление OpenClaw (глобальная установка или из исходников), а также стратегия отката"
read_when:
  - Обновление OpenClaw
  - Что-то сломалось после обновления
title: "Обновление"
---

# Обновление

OpenClaw быстро развивается (до версии «1.0»). Относитесь к обновлениям как к обновлению инфраструктуры: обновить → запустить проверки → перезапустить (или использовать `openclaw update`, который выполняет перезапуск) → проверить.

## Рекомендуется: повторно запустить установщик с сайта (обновление на месте)

**Предпочтительный** путь обновления — повторно запустить установщик с сайта. Он
обнаруживает существующие установки, обновляет их на месте и при необходимости запускает `openclaw doctor`.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Примечания:

- Добавьте `--no-onboard`, если не хотите, чтобы мастер первичной настройки запускался снова.

- Для **установок из исходников** используйте:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Установщик выполнит `git pull --rebase` **только** если репозиторий чистый.

- Для **глобальных установок** скрипт под капотом использует `npm install -g openclaw@latest`.

- Примечание о наследии: `clawdbot` остаётся доступным как shim для совместимости.

## Перед обновлением

- Знайте, как вы устанавливали: **глобально** (npm/pnpm) или **из исходников** (git clone).
- Знайте, как запущен ваш Gateway (шлюз): **в терминале на переднем плане** или как **управляемый сервис** (launchd/systemd).
- Снимите свой индивидуальный рисунок:
  - Конфиг: `~/.openclaw/openclaw.json`
  - Учётные данные: `~/.openclaw/credentials/`
  - Рабочее пространство: `~/.openclaw/workspace`

## Обновление (глобальная установка)

Глобальная установка (выберите один вариант):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Мы **не** рекомендуем Bun для runtime Gateway (шлюза) (ошибки WhatsApp/Telegram).

Чтобы переключить каналы обновлений (git + npm установки):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Используйте `--tag <dist-tag|version>` для разовой установки конкретного тега/версии.

См. [Каналы разработки](/install/development-channels) для семантики каналов и примечаний к релизам.

Примечание: при установке через npm Gateway при запуске пишет подсказку об обновлении (проверяет текущий тег канала). Отключается через `update.checkOnStart: false`.

Затем:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Примечания:

- Если ваш Gateway (шлюз) работает как сервис, `openclaw gateway restart` предпочтительнее, чем «убивать» PID’ы.
- Если вы закреплены на конкретной версии, см. «Откат / закрепление» ниже.

## Обновление (`openclaw update`)

Для **установок из исходников** (git checkout) предпочтительно:

```bash
openclaw update
```

Он выполняет относительно безопасный поток обновления:

- Требует чистое рабочее дерево.
- Переключается на выбранный канал (тег или ветку).
- Выполняет fetch + rebase относительно настроенного upstream (канал dev).
- Устанавливает зависимости, собирает проект, собирает Control UI и запускает `openclaw doctor`.
- По умолчанию перезапускает Gateway (шлюз) (используйте `--no-restart`, чтобы пропустить).

Если вы устанавливали через **npm/pnpm** (без git-метаданных), `openclaw update` попытается обновиться через ваш менеджер пакетов. Если он не может определить установку, используйте «Обновление (глобальная установка)».

## Обновление (Control UI / RPC)

В Control UI есть кнопка **Update & Restart** (RPC: `update.run`). Она:

1. Запускает тот же поток обновления из исходников, что и `openclaw update` (только git checkout).
2. Записывает sentinel перезапуска со структурированным отчётом (хвост stdout/stderr).
3. Перезапускает Gateway (шлюз) и пингует последнюю активную сессию с отчётом.

Если rebase завершается неудачей, Gateway (шлюз) прерывает операцию и перезапускается без применения обновления.

## Обновление (из исходников)

Из checkout репозитория:

Предпочтительно:

```bash
openclaw update
```

Вручную (примерно эквивалентно):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Примечания:

- `pnpm build` важно, когда вы запускаете упакованный бинарь `openclaw` ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) или используете Node для запуска `dist/`.
- Если вы запускаете из checkout репозитория без глобальной установки, используйте `pnpm openclaw ...` для CLI-команд.
- Если вы запускаете напрямую из TypeScript (`pnpm openclaw ...`), пересборка обычно не требуется, но **миграции конфига всё равно применяются** → запустите doctor.
- Переключение между глобальной установкой и git-установкой простое: установите другой вариант, затем запустите `openclaw doctor`, чтобы точка входа сервиса Gateway (шлюза) была переписана на текущую установку.

## Всегда запускайте: `openclaw doctor`

Doctor — это команда «безопасного обновления». Она намеренно скучная: починить + мигрировать + предупредить.

Примечание: если у вас **установка из исходников** (git checkout), `openclaw doctor` предложит сначала запустить `openclaw update`.

Типичные действия:

- Миграция устаревших ключей конфига / расположений legacy-конфигов.
- Аудит политик личных сообщений (DM) и предупреждения о рискованных «открытых» настройках.
- Проверка состояния Gateway (шлюза) с предложением перезапуска.
- Обнаружение и миграция старых сервисов Gateway (шлюза) (launchd/systemd; legacy schtasks) к текущим сервисам OpenClaw.
- В Linux — обеспечение user lingering в systemd (чтобы Gateway переживал выход из сессии).

Подробности: [Doctor](/gateway/doctor)

## Запуск / остановка / перезапуск Gateway (шлюза)

CLI (работает независимо от ОС):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Если используется надзор сервиса:

- macOS launchd (LaunchAgent, поставляемый с приложением): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (используйте `bot.molt.<profile>`; legacy `com.openclaw.*` всё ещё работает)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` работают только если сервис установлен; иначе запустите `openclaw gateway install`.

Runbook и точные имена сервисов: [Gateway runbook](/gateway)

## Откат / закрепление (когда что-то ломается)

### Закрепление (глобальная установка)

Установите заведомо рабочую версию (замените `<version>` на последнюю рабочую):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Совет: чтобы увидеть текущую опубликованную версию, выполните `npm view openclaw version`.

Затем перезапустите и снова запустите doctor:

```bash
openclaw doctor
openclaw gateway restart
```

### Закрепление (из исходников) по дате

Выберите коммит по дате (пример: «состояние main на 2026-01-01»):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Затем переустановите зависимости и перезапустите:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Если позже вы хотите вернуться к последней версии:

```bash
git checkout main
git pull
```

## Если вы застряли

- Снова запустите `openclaw doctor` и внимательно прочитайте вывод (часто там прямо указано решение).
- Проверьте: [Устранение неполадок](/gateway/troubleshooting)
- Спросите в Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
