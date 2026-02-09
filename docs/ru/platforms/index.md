---
summary: "Обзор поддержки платформ (Gateway + сопутствующие приложения)"
read_when:
  - Ищете поддержку ОС или пути установки
  - Решаете, где запускать Gateway
title: "Платформы"
---

# Платформы

Ядро OpenClaw написано на TypeScript. **Node — рекомендуемая среда выполнения**.
Bun не рекомендуется для Gateway (шлюза) (ошибки WhatsApp/Telegram).

Существуют сопутствующие приложения для macOS (приложение в строке меню) и мобильных узлов (iOS/Android). Сопутствующие приложения для Windows и
Linux запланированы, однако Gateway (шлюз) полностью поддерживается уже сегодня.
Также планируются нативные сопутствующие приложения для Windows; рекомендуется использовать Gateway (шлюз) через WSL2.

## Выберите свою ОС

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS и хостинг

- VPS‑хаб: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS‑прокси): [exe.dev](/install/exe-dev)

## Общие ссылки

- Руководство по установке: [Getting Started](/start/getting-started)
- Runbook Gateway (шлюза): [Gateway](/gateway)
- Конфигурация Gateway (шлюза): [Configuration](/gateway/configuration)
- Статус сервиса: `openclaw gateway status`

## Установка сервиса Gateway (шлюза) (CLI)

Используйте один из вариантов (все поддерживаются):

- Мастер (рекомендуется): `openclaw onboard --install-daemon`
- Напрямую: `openclaw gateway install`
- Поток конфигурации: `openclaw configure` → выберите **сервис Gateway (шлюза)**
- Ремонт/миграция: `openclaw doctor` (предлагает установить или исправить сервис)

Цель сервиса зависит от ОС:

- macOS: LaunchAgent (`bot.molt.gateway` или `bot.molt.<profile>`; устаревший `com.openclaw.*`)
- Linux/WSL2: пользовательский сервис systemd (`openclaw-gateway[-<profile>].service`)
