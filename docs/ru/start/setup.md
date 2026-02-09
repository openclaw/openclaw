---
summary: "Продвинутая настройка и рабочие процессы разработки для OpenClaw"
read_when:
  - Настройка новой машины
  - Вам нужен «самый новый и лучший» вариант без поломки личной настройки
title: "Настройка"
---

# Настройка

<Note>
Если вы настраиваете систему впервые, начните с [Начало работы](/start/getting-started).
Подробности о мастере см. в [Мастер онбординга](/start/wizard).
</Note>

Последнее обновление: 2026-01-01

## TL;DR

- **Кастомизация живёт вне репозитория:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Стабильный рабочий процесс:** установите приложение для macOS; пусть оно запускает Gateway (шлюз) из комплекта.
- **Bleeding edge рабочий процесс:** запускайте Gateway (шлюз) самостоятельно через `pnpm gateway:watch`, затем подключайте приложение для macOS в локальном режиме.

## Предварительные требования (из исходников)

- Node `>=22`
- `pnpm`
- Docker (необязательно; только для контейнеризированной настройки/e2e — см. [Docker](/install/docker))

## Стратегия кастомизации (чтобы обновления не причиняли боль)

Если вы хотите «на 100% под себя» _и_ простые обновления, держите кастомизацию в:

- **Конфиг:** `~/.openclaw/openclaw.json` (JSON/JSON5-подобный)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; сделайте приватным git-репозиторием)

Загрузка:

```bash
openclaw setup
```

Изнутри этого репозитория используйте локальную точку входа CLI:

```bash
openclaw setup
```

Если глобальной установки ещё нет, запустите через `pnpm openclaw setup`.

## Запуск Gateway (шлюза) из этого репозитория

После `pnpm build` вы можете запускать упакованный CLI напрямую:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Стабильный рабочий процесс (сначала приложение для macOS)

1. Установите и запустите **OpenClaw.app** (строка меню).
2. Заполните список чек-листов бортинга/разрешений (TCC prompts).
3. Убедитесь, что Gateway (шлюз) **Local** и запущен (приложение управляет им).
4. Подключите поверхности (пример: WhatsApp):

```bash
openclaw channels login
```

5. Проверка работоспособности:

```bash
openclaw health
```

Если онбординг недоступен в вашей сборке:

- Запустите `openclaw setup`, затем `openclaw channels login`, затем запустите Gateway (шлюз) вручную (`openclaw gateway`).

## Bleeding edge рабочий процесс (Gateway (шлюз) в терминале)

Цель: работать над TypeScript Gateway (шлюзом), получить hot reload и оставить UI приложения для macOS подключённым.

### 0. (Необязательно) Запустить приложение для macOS тоже из исходников

Если вы также хотите приложение для macOS на bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1. Запуск dev Gateway (шлюза)

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` запускает gateway в режиме watch и перезагружает его при изменениях TypeScript.

### 2. Указать приложению для macOS ваш запущенный Gateway (шлюз)

В **OpenClaw.app**:

- Режим подключения: **Local**
  Приложение подключится к запущенному gateway на настроенном порту.

### 3. Проверка

- В приложении статус Gateway (шлюза) должен быть **«Using existing gateway …»**
- Или через CLI:

```bash
openclaw health
```

### Обычные пулеметы

- **Неверный порт:** WS Gateway (шлюза) по умолчанию — `ws://127.0.0.1:18789`; приложение и CLI должны использовать один и тот же порт.
- **Где хранится состояние:**
  - Учётные данные: `~/.openclaw/credentials/`
  - Сеансы: `~/.openclaw/agents/<agentId>/sessions/`
  - Логи: `/tmp/openclaw/`

## Карта хранения учётных данных

Используйте это при отладке аутентификации или выборе того, что бэкапить:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Токен бота Telegram**: config/env или `channels.telegram.tokenFile`
- **Токен бота Discord**: config/env (файл токена пока не поддерживается)
- **Токены Slack**: config/env (`channels.slack.*`)
- **Списки разрешённых для сопряжения**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Профили аутентификации моделей**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Импорт устаревшего OAuth**: `~/.openclaw/credentials/oauth.json`
  Подробнее: [Безопасность](/gateway/security#credential-storage-map).

## Обновление (не разрушая вашу настройку)

- Считайте `~/.openclaw/workspace` и `~/.openclaw/` «вашими данными»; не кладите личные промпты/конфиги в репозиторий `openclaw`.
- Обновление исходников: `git pull` + `pnpm install` (когда изменился lockfile) + продолжайте использовать `pnpm gateway:watch`.

## Linux (пользовательский сервис systemd)

Установки Linux используют **пользовательский** сервис systemd. По умолчанию systemd останавливает пользовательские
сервисы при выходе/простоя, что убивает Gateway (шлюз). Онбординг пытается включить lingering за вас (может запросить sudo). Если он всё ещё выключен, выполните:

```bash
sudo loginctl enable-linger $USER
```

Для всегда или многопользовательских серверов рассмотрите **системный** сервис вместо
пользовательской службы (задерживание не требуется). См. [Gateway runbook](/gateway) для заметок по systemd.

## Связанная документация

- [Gateway runbook](/gateway) (флаги, супервизия, порты)
- [Конфигурация Gateway (шлюза)](/gateway/configuration) (схема конфига + примеры)
- [Discord](/channels/discord) и [Telegram](/channels/telegram) (теги ответов + настройки replyToMode)
- [Настройка ассистента OpenClaw](/start/openclaw)
- [Приложение для macOS](/platforms/macos) (жизненный цикл gateway)
