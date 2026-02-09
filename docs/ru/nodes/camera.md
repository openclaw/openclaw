---
summary: "Захват камеры (iOS-узел + приложение для macOS) для использования агентом: фотографии (jpg) и короткие видеоклипы (mp4)"
read_when:
  - Добавление или изменение захвата камеры на iOS-узлах или macOS
  - Расширение рабочих процессов временных файлов MEDIA, доступных агенту
title: "Захват камеры"
---

# Захват камеры (агент)

OpenClaw поддерживает **захват камеры** для агентских рабочих процессов:

- **iOS-узел** (сопряжён через Gateway (шлюз)): захват **фото** (`jpg`) или **короткого видеоклипа** (`mp4`, с необязательным аудио) через `node.invoke`.
- **Android-узел** (сопряжён через Gateway (шлюз)): захват **фото** (`jpg`) или **короткого видеоклипа** (`mp4`, с необязательным аудио) через `node.invoke`.
- **Приложение для macOS** (узел через Gateway (шлюз)): захват **фото** (`jpg`) или **короткого видеоклипа** (`mp4`, с необязательным аудио) через `node.invoke`.

Весь доступ к камере ограничен **настройками, контролируемыми пользователем**.

## iOS-узел

### Пользовательская настройка (по умолчанию включено)

- Вкладка «Настройки» iOS → **Камера** → **Разрешить камеру** (`camera.enabled`)
  - По умолчанию: **включено** (отсутствующий ключ считается включённым).
  - При выключении: команды `camera.*` возвращают `CAMERA_DISABLED`.

### Команды (через Gateway `node.invoke`)

- `camera.list`
  - Полезная нагрузка ответа:
    - `devices`: массив `{ id, name, position, deviceType }`

- `camera.snap`
  - Params:
    - `facing`: `front|back` (по умолчанию: `front`)
    - `maxWidth`: number (необязательно; по умолчанию `1600` на iOS-узле)
    - `quality`: `0..1` (необязательно; по умолчанию `0.9`)
    - `format`: в настоящее время `jpg`
    - `delayMs`: number (необязательно; по умолчанию `0`)
    - `deviceId`: string (необязательно; из `camera.list`)
  - Полезная нагрузка ответа:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Ограничение полезной нагрузки: фотографии перекодируются, чтобы удерживать полезную нагрузку base64 ниже 5 МБ.

- `camera.clip`
  - Params:
    - `facing`: `front|back` (по умолчанию: `front`)
    - `durationMs`: number (по умолчанию `3000`, с ограничением до максимума `60000`)
    - `includeAudio`: boolean (по умолчанию `true`)
    - `format`: в настоящее время `mp4`
    - `deviceId`: string (необязательно; из `camera.list`)
  - Полезная нагрузка ответа:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Требование переднего плана

Как и `canvas.*`, iOS-узел разрешает команды `camera.*` только в **переднем плане**. Вызовы в фоне возвращают `NODE_BACKGROUND_UNAVAILABLE`.

### Помощник CLI (временные файлы + MEDIA)

Самый простой способ получить вложения — использовать помощник CLI, который записывает декодированное медиа во временный файл и выводит `MEDIA:<path>`.

Примеры:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Примечания:

- `nodes camera snap` по умолчанию использует **обе** камеры, чтобы предоставить агенту оба вида.
- Выходные файлы являются временными (в каталоге временных файлов ОС), если вы не создадите собственную обёртку.

## Android-узел

### Пользовательская настройка Android (по умолчанию включено)

- Лист настроек Android → **Камера** → **Разрешить камеру** (`camera.enabled`)
  - По умолчанию: **включено** (отсутствующий ключ считается включённым).
  - При выключении: команды `camera.*` возвращают `CAMERA_DISABLED`.

### Разрешения

- Android требует разрешений во время выполнения:
  - `CAMERA` для `camera.snap` и `camera.clip`.
  - `RECORD_AUDIO` для `camera.clip`, когда `includeAudio=true`.

Если разрешения отсутствуют, приложение по возможности запросит их; при отказе запросы `camera.*` завершаются с ошибкой
`*_PERMISSION_REQUIRED`.

### Требование переднего плана Android

Как и `canvas.*`, Android-узел разрешает команды `camera.*` только в **переднем плане**. Вызовы в фоне возвращают `NODE_BACKGROUND_UNAVAILABLE`.

### Защита от нагрузки

Фотографии перекодируются, чтобы удерживать полезную нагрузку base64 ниже 5 МБ.

## Приложение для macOS

### Пользовательская настройка (по умолчанию выключено)

Сопутствующее приложение macOS предоставляет флажок:

- **Настройки → Общие → Разрешить камеру** (`openclaw.cameraEnabled`)
  - По умолчанию: **выключено**
  - При выключении: запросы к камере возвращают «Camera disabled by user».

### Помощник CLI (вызов узла)

Используйте основной CLI `openclaw` для вызова команд камеры на узле macOS.

Примеры:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Примечания:

- `openclaw nodes camera snap` по умолчанию установлен в `maxWidth=1600`, если не переопределён.
- В macOS `camera.snap` ожидает `delayMs` (по умолчанию 2000 мс) после прогрева/стабилизации экспозиции перед захватом.
- Полезные нагрузки фото перекодируются, чтобы удерживать base64 ниже 5 МБ.

## Безопасность и практические ограничения

- Доступ к камере и микрофону вызывает стандартные запросы разрешений ОС (и требует строк использования в Info.plist).
- Видеоклипы ограничены по длительности (в настоящее время `<= 60s`), чтобы избежать чрезмерно больших полезных нагрузок узла (накладные расходы base64 + ограничения сообщений).

## Видео экрана macOS (на уровне ОС)

Для видео _экрана_ (не камеры) используйте сопутствующее приложение macOS:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Примечания:

- Требуется разрешение macOS **Screen Recording** (TCC).
