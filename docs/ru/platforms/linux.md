---
summary: "Поддержка Linux + статус сопутствующего приложения"
read_when:
  - Ищете статус сопутствующего приложения для Linux
  - Планируете покрытие платформ или вклад в разработку
title: "Приложение для Linux"
---

# Приложение для Linux

Gateway (шлюз) полностью поддерживается на Linux. **Node — рекомендуемая среда выполнения**.
Bun не рекомендуется для Gateway (шлюза) (ошибки WhatsApp/Telegram).

Нативные сопутствующие приложения для Linux запланированы. Вклад приветствуется, если вы хотите помочь в их создании.

## Быстрый путь для начинающих (VPS)

1. Установите Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. С вашего ноутбука: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Откройте `http://127.0.0.1:18789/` и вставьте ваш токен

Пошаговое руководство для VPS: [exe.dev](/install/exe-dev)

## Установка

- [Начало работы](/start/getting-started)
- [Установка и обновления](/install/updating)
- Необязательные варианты: [Bun (экспериментально)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway (шлюз)

- [Руководство по эксплуатации Gateway (шлюза)](/gateway)
- [Конфигурация](/gateway/configuration)

## Установка сервиса Gateway (шлюза) (CLI)

Используйте один из следующих вариантов:

```
openclaw onboard --install-daemon
```

Или:

```
openclaw gateway install
```

Или:

```
openclaw configure
```

При появлении запроса выберите **Gateway service**.

Восстановление/миграция:

```
openclaw doctor
```

## Управление системой (systemd user unit)

OpenClaw по умолчанию устанавливает сервис systemd уровня **user**. Используйте
сервис уровня **system** для общих или постоянно включённых серверов. Полный пример юнита и рекомендации
приведены в [руководстве по эксплуатации Gateway (шлюза)](/gateway).

Минимальная настройка:

Создайте `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Включите его:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
