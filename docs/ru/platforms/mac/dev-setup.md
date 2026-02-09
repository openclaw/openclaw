---
summary: "Руководство по настройке для разработчиков, работающих над приложением OpenClaw для macOS"
read_when:
  - Настройка среды разработки macOS
title: "Настройка разработки для macOS"
---

# Настройка разработки для macOS

Это руководство описывает необходимые шаги для сборки и запуска приложения OpenClaw для macOS из исходного кода.

## Предварительные требования

Перед сборкой приложения убедитесь, что у вас установлено следующее:

1. **Xcode 26.2+**: требуется для разработки на Swift.
2. **Node.js 22+ и pnpm**: требуются для Gateway (шлюза), CLI и скриптов упаковки.

## 1) Установка зависимостей

Установите зависимости, общие для всего проекта:

```bash
pnpm install
```

## 2. Сборка и упаковка приложения

Чтобы собрать приложение для macOS и упаковать его в `dist/OpenClaw.app`, выполните:

```bash
./scripts/package-mac-app.sh
```

Если у вас нет сертификата Apple Developer ID, скрипт автоматически использует **ad-hoc signing** (`-`).

Сведения о режимах запуска для разработки, флагах подписи и устранении проблем с Team ID см. в README приложения для macOS:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Примечание**: Приложения с ad-hoc подписью могут вызывать запросы безопасности. Если приложение сразу аварийно завершается с сообщением «Abort trap 6», см. раздел [Устранение неполадок](#troubleshooting).

## 3. Установка CLI

Приложение для macOS ожидает глобальную установку CLI `openclaw` для управления фоновыми задачами.

**Чтобы установить его (рекомендуется):**

1. Откройте приложение OpenClaw.
2. Перейдите на вкладку настроек **General**.
3. Нажмите **«Install CLI»**.

Либо установите его вручную:

```bash
npm install -g openclaw@<version>
```

## Устранение неполадок

### Сбой сборки: несоответствие toolchain или SDK

Сборка приложения для macOS ожидает наличие последнего SDK macOS и toolchain Swift 6.2.

**Системные зависимости (обязательно):**

- **Последняя версия macOS, доступная в Software Update** (требуется SDK Xcode 26.2)
- **Xcode 26.2** (toolchain Swift 6.2)

**Проверки:**

```bash
xcodebuild -version
xcrun swift --version
```

Если версии не совпадают, обновите macOS/Xcode и повторно запустите сборку.

### Приложение аварийно завершается при предоставлении разрешений

Если приложение падает при попытке разрешить доступ к **Speech Recognition** или **Microphone**, причиной может быть повреждённый кэш TCC или несоответствие подписи.

**Исправление:**

1. Сбросьте разрешения TCC:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Если это не помогло, временно измените `BUNDLE_ID` в [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), чтобы принудительно создать для macOS «чистый лист».

### Gateway (шлюз) бесконечно находится в состоянии «Starting...»

Если статус Gateway (шлюза) остаётся «Starting...», проверьте, не удерживает ли порт зомби-процесс:

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Если порт удерживается при ручном запуске, остановите этот процесс (Ctrl+C). В крайнем случае завершите PID, найденный выше.
