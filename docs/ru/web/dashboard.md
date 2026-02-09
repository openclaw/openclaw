---
summary: "Доступ и аутентификация к панели Gateway (Control UI)"
read_when:
  - Изменение аутентификации панели или режимов её публикации
title: "Панель"
---

# Панель (Control UI)

Панель Gateway — это браузерный Control UI, по умолчанию доступный по адресу `/`
(переопределяется через `gateway.controlUi.basePath`).

Быстрое открытие (локальный Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (или [http://localhost:18789/](http://localhost:18789/))

Ключевые ссылки:

- [Control UI](/web/control-ui) — использование и возможности интерфейса.
- [Tailscale](/gateway/tailscale) — автоматизация Serve/Funnel.
- [Web surfaces](/web) — режимы привязки и примечания по безопасности.

Аутентификация выполняется при рукопожатии WebSocket через `connect.params.auth`
(токен или пароль). См. `gateway.auth` в [Конфигурации Gateway](/gateway/configuration).

Примечание по безопасности: Control UI — это **административная поверхность** (чат, конфигурация, подтверждения выполнения команд).
Не публикуйте её в открытом доступе. Интерфейс сохраняет токен в `localStorage` после первой загрузки.
Предпочитайте localhost, Tailscale Serve или SSH-туннель.

## Быстрый путь (рекомендуется)

- После онбординга CLI автоматически открывает панель и выводит «чистую» (без токена) ссылку.
- Повторное открытие в любое время: `openclaw dashboard` (копирует ссылку, открывает браузер при возможности, показывает подсказку по SSH при headless-режиме).
- Если UI запрашивает аутентификацию, вставьте токен из `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`) в настройках Control UI.

## Основы токенов (локально vs удалённо)

- **Localhost**: откройте `http://127.0.0.1:18789/`.
- **Источник токена**: `gateway.auth.token` (или `OPENCLAW_GATEWAY_TOKEN`); UI сохраняет копию в localStorage после подключения.
- **Не localhost**: используйте Tailscale Serve (без токена, если `gateway.auth.allowTailscale: true`), привязку tailnet с токеном или SSH-туннель. См. [Web surfaces](/web).

## Если вы видите «unauthorized» / 1008

- Убедитесь, что шлюз доступен (локально: `openclaw status`; удалённо: SSH-туннель `ssh -N -L 18789:127.0.0.1:18789 user@host`, затем откройте `http://127.0.0.1:18789/`).
- Получите токен на хосте шлюза Gateway: `openclaw config get gateway.auth.token` (или сгенерируйте новый: `openclaw doctor --generate-gateway-token`).
- В настройках панели вставьте токен в поле аутентификации и подключитесь.
