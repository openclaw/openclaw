---
summary: "Устранение неполадок при сопряжении узлов, требованиях к активному приложению, разрешениях и сбоях инструментов"
read_when:
  - Узел подключён, но инструменты camera/canvas/screen/exec не работают
  - Вам нужна ментальная модель различий между сопряжением узла и подтверждениями выполнения
title: "Устранение неполадок узлов"
---

# Устранение неполадок узлов

Используйте эту страницу, когда узел виден в статусе, но инструменты узла не работают.

## Командная лестница

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Затем выполните проверки, специфичные для узла:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Здоровые сигналы:

- Узел подключён и сопряжён для роли `node`.
- `nodes describe` включает вызываемую вами возможность.
- Подтверждения выполнения команд (exec approvals) показывают ожидаемый режим/список разрешённых.

## Требования переднего плана

`canvas.*`, `camera.*` и `screen.*` доступны только при активном приложении на узлах iOS/Android.

Быстрая проверка и исправление:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Если вы видите `NODE_BACKGROUND_UNAVAILABLE`, выведите приложение узла на передний план и повторите попытку.

## Матрица разрешений

| Возможность                  | iOS                                                                     | Android                                                                     | приложение узла macOS                                  | Типичный код ошибки            |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| `camera.snap`, `camera.clip` | Камера (+ микрофон для аудио клипа)                  | Камера (+ микрофон для аудио клипа)                      | Камера (+ микрофон для аудио клипа) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Запись экрана (+ микрофон необязательно)             | Запрос захвата экрана (+ микрофон необязательно)         | Запись экрана                                          | `*_PERMISSION_REQUIRED`        |
| `location.get`               | «При использовании» или «Всегда» (зависит от режима) | Разрешение геолокации для переднего/фонового режима в зависимости от режима | Разрешение на геолокацию                               | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | н/д (путь хоста узла)                                | н/д (путь хоста узла)                                    | Требуются подтверждения exec                           | `SYSTEM_RUN_DENIED`            |

## Сопряжение и подтверждения выполнения

Это разные «шлюзы» доступа:

1. **Сопряжение устройства**: может ли этот узел подключиться к Gateway (шлюзу)?
2. **Подтверждения exec**: может ли этот узел выполнить конкретную команду оболочки?

Быстрые проверки:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Если сопряжение отсутствует, сначала подтвердите устройство узла.
Если с сопряжением всё в порядке, но `system.run` не проходит, исправьте подтверждения exec/список разрешённых.

## Распространённые коды ошибок узлов

- `NODE_BACKGROUND_UNAVAILABLE` → приложение в фоне; выведите его на передний план.
- `CAMERA_DISABLED` → тумблер камеры отключён в настройках узла.
- `*_PERMISSION_REQUIRED` → отсутствует/отклонено разрешение ОС.
- `LOCATION_DISABLED` → режим геолокации выключен.
- `LOCATION_PERMISSION_REQUIRED` → запрошенный режим геолокации не предоставлен.
- `LOCATION_BACKGROUND_UNAVAILABLE` → приложение в фоне, но есть разрешение только «При использовании».
- `SYSTEM_RUN_DENIED: approval required` → запрос exec требует явного подтверждения.
- `SYSTEM_RUN_DENIED: allowlist miss` → команда заблокирована режимом списка разрешённых.

## Быстрый цикл восстановления

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Если всё ещё не удаётся:

- Повторно подтвердите сопряжение устройства.
- Снова откройте приложение узла (передний план).
- Повторно выдайте разрешения ОС.
- Пересоздайте/настройте политику подтверждений exec.

Связанное:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
