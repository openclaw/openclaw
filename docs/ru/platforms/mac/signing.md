---
summary: "Шаги подписания для отладочных сборок macOS, сгенерированных скриптами упаковки"
read_when:
  - Сборка или подписание отладочных сборок macOS
title: "Подписание macOS"
---

# подписание mac (отладочные сборки)

Это приложение обычно собирается из [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), который теперь:

- задаёт стабильный идентификатор бандла для отладки: `ai.openclaw.mac.debug`
- записывает Info.plist с этим идентификатором бандла (переопределяется через `BUNDLE_ID=...`)
- вызывает [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) для подписания основного бинарника и бандла приложения, чтобы macOS воспринимала каждую пересборку как один и тот же подписанный бандл и сохраняла разрешения TCC (уведомления, специальные возможности, запись экрана, микрофон, речь). Для стабильных разрешений используйте реальную идентификацию подписи; ad-hoc — по явному выбору и ненадёжно (см. [macOS permissions](/platforms/mac/permissions)).
- по умолчанию использует `CODESIGN_TIMESTAMP=auto`; это включает доверенные временные метки для подписей Developer ID. Установите `CODESIGN_TIMESTAMP=off`, чтобы пропустить проставление временных меток (офлайн-отладочные сборки).
- внедряет метаданные сборки в Info.plist: `OpenClawBuildTimestamp` (UTC) и `OpenClawGitCommit` (короткий хеш), чтобы вкладка About могла показать сборку, git и канал debug/release.
- **Упаковка требует Node 22+**: скрипт запускает сборки TS и сборку Control UI.
- читает `SIGN_IDENTITY` из переменных окружения. Добавьте `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (или ваш сертификат Developer ID Application) в rc-файл оболочки, чтобы всегда подписывать своим сертификатом. Ad-hoc‑подписание требует явного включения через `ALLOW_ADHOC_SIGNING=1` или `SIGN_IDENTITY="-"` (не рекомендуется для тестирования разрешений).
- после подписания выполняет аудит Team ID и завершает работу с ошибкой, если какой-либо Mach‑O внутри бандла приложения подписан другим Team ID. Установите `SKIP_TEAM_ID_CHECK=1` для обхода проверки.

## Использование

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Примечание о ad-hoc‑подписании

При подписании с `SIGN_IDENTITY="-"` (ad-hoc) скрипт автоматически отключает **Hardened Runtime** (`--options runtime`). Это необходимо, чтобы предотвратить сбои, когда приложение пытается загрузить встроенные фреймворки (например, Sparkle), которые не разделяют тот же Team ID. Ad-hoc‑подписи также нарушают сохранение разрешений TCC; шаги по восстановлению см. в [macOS permissions](/platforms/mac/permissions).

## Метаданные сборки для About

`package-mac-app.sh` помечает бандл следующими данными:

- `OpenClawBuildTimestamp`: ISO8601 UTC на момент упаковки
- `OpenClawGitCommit`: короткий git‑хеш (или `unknown`, если недоступно)

Вкладка About читает эти ключи, чтобы показать версию, дату сборки, коммит git и признак отладочной сборки (через `#if DEBUG`). Запустите упаковщик, чтобы обновить эти значения после изменений кода.

## Зачем

Разрешения TCC привязаны к идентификатору бандла _и_ подписи кода. Неподписанные отладочные сборки с меняющимися UUID приводили к тому, что macOS забывала выданные разрешения после каждой пересборки. Подписание бинарников (ad‑hoc по умолчанию) и сохранение фиксированного идентификатора бандла/пути (`dist/OpenClaw.app`) сохраняет разрешения между сборками, что соответствует подходу VibeTunnel.
