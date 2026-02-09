---
summary: "Хаб VPS‑хостинга для OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Вы хотите запустить Gateway (шлюз) в облаке
  - Вам нужна быстрая навигация по руководствам по VPS/хостингу
title: "VPS‑хостинг"
---

# VPS‑хостинг

Этот хаб содержит ссылки на поддерживаемые руководства по VPS/хостингу и на высоком уровне объясняет, как работают облачные развертывания.

## Выбор провайдера

- **Railway** (установка в один клик + настройка в браузере): [Railway](/install/railway)
- **Northflank** (установка в один клик + настройка в браузере): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/месяц (Always Free, ARM; доступность и регистрация могут быть капризными)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS‑прокси): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: также хорошо подходит. Видео‑руководство:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Как работают облачные настройки

- **Gateway (шлюз) работает на VPS** и владеет состоянием и рабочим пространством.
- Вы подключаетесь с ноутбука/телефона через **Control UI** или **Tailscale/SSH**.
- Рассматривайте VPS как источник истины и **делайте резервные копии** состояния и рабочего пространства.
- Безопасная конфигурация по умолчанию: держите Gateway (шлюз) на loopback и подключайтесь к нему через SSH‑туннель или Tailscale Serve.
  Если вы привязываетесь к `lan`/`tailnet`, требуйте `gateway.auth.token` или `gateway.auth.password`.

Удалённый доступ: [Gateway remote](/gateway/remote)  
Хаб платформ: [Platforms](/platforms)

## Использование узлов с VPS

Вы можете оставить Gateway (шлюз) в облаке и выполнить сопряжение **узлов** на локальных устройствах
(Mac/iOS/Android/headless). Узлы предоставляют локальные экран/камеру/холст и возможности `system.run`,
пока Gateway (шлюз) остаётся в облаке.

Документация: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
