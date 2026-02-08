---
summary: "Возможности OpenClaw по каналам, маршрутизации, медиа и пользовательскому опыту."
read_when:
  - Вам нужен полный список поддерживаемых возможностей OpenClaw
title: "Возможности"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:21Z
---

## Основные возможности

<Columns>
  <Card title="Каналы" icon="message-square">
    WhatsApp, Telegram, Discord и iMessage с одним Gateway (шлюзом).
  </Card>
  <Card title="Плагины" icon="plug">
    Добавляйте Mattermost и другие системы с помощью расширений.
  </Card>
  <Card title="Маршрутизация" icon="route">
    Мультиагентная маршрутизация с изолированными сеансами.
  </Card>
  <Card title="Медиа" icon="image">
    Изображения, аудио и документы — на вход и на выход.
  </Card>
  <Card title="Приложения и UI" icon="monitor">
    Веб-интерфейс управления и сопутствующее приложение для macOS.
  </Card>
  <Card title="Мобильные узлы" icon="smartphone">
    Узлы iOS и Android с поддержкой Canvas.
  </Card>
</Columns>

## Полный список

- Интеграция с WhatsApp через WhatsApp Web (Baileys)
- Поддержка бота Telegram (grammY)
- Поддержка бота Discord (channels.discord.js)
- Поддержка бота Mattermost (плагин)
- Интеграция с iMessage через локальный imsg CLI (macOS)
- Агентный мост для Pi в режиме RPC с потоковой передачей инструментов
- Потоковая передача и разбиение на части для длинных ответов
- Мультиагентная маршрутизация для изолированных сеансов на рабочее пространство или отправителя
- Аутентификация по подписке для Anthropic и OpenAI через OAuth
- Сеансы: прямые чаты объединяются в общий `main`; группы изолированы
- Поддержка групповых чатов с активацией по упоминанию
- Поддержка медиа: изображения, аудио и документы
- Необязательный хук для транскрибации голосовых заметок
- WebChat и приложение для macOS в строке меню
- Узел iOS с сопряжением и поверхностью Canvas
- Узел Android с сопряжением, Canvas, чатом и камерой

<Note>
Устаревшие пути Claude, Codex, Gemini и Opencode удалены. Pi — единственный
путь агентa для задач кодирования.
</Note>
