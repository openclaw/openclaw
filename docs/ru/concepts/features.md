---
summary: "Возможности OpenClaw по каналам, маршрутизации, медиа и пользовательскому опыту."
read_when:
  - Вам нужен полный список поддерживаемых возможностей OpenClaw
title: "Возможности"
---

## Отметины

<Columns>
  <Card title="Channels" icon="message-square">
    WhatsApp, Telegram, Discord и iMessage с одним Gateway (шлюзом).
  </Card>
  <Card title="Plugins" icon="plug">
    Добавляйте Mattermost и другие системы с помощью расширений.
  </Card>
  <Card title="Routing" icon="route">
    Мультиагентная маршрутизация с изолированными сеансами.
  </Card>
  <Card title="Media" icon="image">
    Изображения, аудио и документы — на вход и на выход.
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Веб-интерфейс управления и сопутствующее приложение для macOS.
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
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
