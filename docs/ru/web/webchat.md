---
summary: "Статический хост WebChat с loopback и использование WS Gateway для UI чата"
read_when:
  - Отладка или настройка доступа WebChat
title: "WebChat"
---

# WebChat (WebSocket UI Gateway)

Статус: чат‑интерфейс SwiftUI для macOS/iOS напрямую общается с WebSocket Gateway.

## Что это такое

- Нативный UI чата для Gateway (шлюз) (без встроенного браузера и без локального статического сервера).
- Использует те же сеансы и правила маршрутизации, что и другие каналы.
- Детерминированная маршрутизация: ответы всегда возвращаются в WebChat.

## Быстрый старт

1. Запустите Gateway (шлюз).
2. Откройте UI WebChat (приложение для macOS/iOS) или вкладку чата Control UI.
3. Убедитесь, что аутентификация Gateway (шлюз) настроена (по умолчанию обязательна, даже на local loopback).

## Как это работает (поведение)

- UI подключается к WebSocket Gateway (шлюз) и использует `chat.history`, `chat.send` и `chat.inject`.
- `chat.inject` добавляет примечание ассистента напрямую в транскрипт и рассылает его в UI (без запуска агента).
- История всегда загружается из Gateway (шлюз) (без наблюдения за локальными файлами).
- Если Gateway (шлюз) недоступен, WebChat работает в режиме «только чтение».

## Удаленное использование

- В удалённом режиме WebSocket Gateway (шлюз) прокладывается через SSH/Tailscale.
- Вам не нужно запускать отдельный сервер WebChat.

## Справочник конфигурации (WebChat)

Полная конфигурация: [Конфигурация](/gateway/configuration)

Параметры канала:

- Нет отдельного блока `webchat.*`. WebChat использует endpoint Gateway (шлюз) и параметры аутентификации ниже.

Связанные глобальные параметры:

- `gateway.port`, `gateway.bind`: хост/порт WebSocket.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: аутентификация WebSocket.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: цель удалённого Gateway (шлюз).
- `session.*`: хранилище сеансов и значения по умолчанию для основного ключа.
