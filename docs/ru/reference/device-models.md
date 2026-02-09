---
summary: "Как OpenClaw использует идентификаторы моделей устройств Apple для отображения удобочитаемых названий в приложении для macOS."
read_when:
  - Обновление сопоставлений идентификаторов моделей устройств или файлов NOTICE/лицензии
  - Изменение того, как UI Instances отображает названия устройств
title: "База данных моделей устройств"
---

# База данных моделей устройств (удобочитаемые названия)

Сопутствующее приложение для macOS отображает удобочитаемые названия моделей устройств Apple в UI **Instances**, сопоставляя идентификаторы моделей Apple (например, `iPad16,6`, `Mac16,6`) с понятными человеку названиями.

Сопоставление поставляется в виде JSON по пути:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Источник данных

В настоящее время мы используем сопоставление из репозитория с лицензией MIT:

- `kyle-seongwoo-jun/apple-device-identifiers`

Чтобы сборки были детерминированными, JSON‑файлы закреплены за конкретными коммитами upstream (зафиксированы в `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`).

## Обновление базы данных

1. Выберите коммиты upstream, к которым хотите привязаться (один для iOS, один для macOS).
2. Обновите хэши коммитов в `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md`.
3. Повторно загрузите JSON‑файлы, закрепив их за выбранными коммитами:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Убедитесь, что `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` по‑прежнему соответствует upstream (замените его, если лицензия upstream изменилась).
5. Проверьте, что приложение для macOS собирается без предупреждений:

```bash
swift build --package-path apps/macos
```
