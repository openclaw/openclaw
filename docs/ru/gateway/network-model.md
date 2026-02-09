---
summary: "Как подключаются Gateway (шлюз), узлы и хост canvas."
read_when:
  - Нужен краткий обзор сетевой модели Gateway (шлюза)
title: "Сетевая модель"
---

Большинство операций проходит через Gateway (шлюз) (`openclaw gateway`), один долгоживущий
процесс, который владеет подключениями каналов и плоскостью управления WebSocket.

## Основные правила

- Рекомендуется один Gateway (шлюз) на хост. Это единственный процесс, которому разрешено владеть сеансом WhatsApp Web. Для rescue-ботов или строгой изоляции запускайте несколько Gateway (шлюзов) с изолированными профилями и портами. См. [Multiple gateways](/gateway/multiple-gateways).
- Сначала loopback: WS Gateway (шлюза) по умолчанию — `ws://127.0.0.1:18789`. Мастер по умолчанию генерирует токен шлюза даже для loopback. Для доступа через tailnet запускайте `openclaw gateway --bind tailnet --token ...`, поскольку для привязок не к loopback требуются токены.
- Узлы подключаются к WS Gateway (шлюза) по LAN, tailnet или SSH по мере необходимости. Устаревший TCP-мост помечен как deprecated.
- Хост canvas — это HTTP‑сервер файлов на `canvasHost.port` (по умолчанию `18793`), обслуживающий `/__openclaw__/canvas/` для WebView узлов. См. См. [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Удалённое использование обычно осуществляется через SSH‑туннель или VPN tailnet. [Remote access](/gateway/remote) и [Discovery](/gateway/discovery).
