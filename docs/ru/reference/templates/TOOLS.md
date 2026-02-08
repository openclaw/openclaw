---
summary: "Шаблон рабочего пространства для TOOLS.md"
read_when:
  - Ручная инициализация рабочего пространства
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:54Z
---

# TOOLS.md — локальные заметки

Skills определяют, _как_ работают инструменты. Этот файл предназначен для _ваших_ особенностей — того, что уникально для вашей настройки.

## Что сюда добавлять

Например:

- Названия и расположение камер
- SSH-хосты и алиасы
- Предпочтительные голоса для TTS
- Названия динамиков/комнат
- Псевдонимы устройств
- Всё, что зависит от окружения

## Примеры

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Зачем разделять?

Skills являются общими. Ваша настройка — только ваша. Разделение позволяет обновлять skills, не теряя заметок, и делиться skills, не раскрывая вашу инфраструктуру.

---

Добавляйте всё, что помогает вам в работе. Это ваша шпаргалка.
