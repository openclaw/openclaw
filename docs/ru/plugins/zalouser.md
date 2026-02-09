---
summary: "Плагин Zalo Personal: вход по QR + обмен сообщениями через zca-cli (установка плагина + конфигурация канала + CLI + инструмент)"
read_when:
  - Вам нужна поддержка Zalo Personal (неофициальная) в OpenClaw
  - Вы настраиваете или разрабатываете плагин zalouser
title: "Плагин Zalo Personal"
---

# Zalo Personal (плагин)

Поддержка Zalo Personal для OpenClaw через плагин с использованием `zca-cli` для автоматизации обычного пользовательского аккаунта Zalo.

> **Предупреждение:** Неофициальная автоматизация может привести к приостановке или блокировке аккаунта. Используйте на свой риск.

## Naming

Идентификатор канала — `zalouser`, чтобы явно указать, что это автоматизация **личного пользовательского аккаунта Zalo** (неофициальная). Мы оставляем `zalo` зарезервированным для возможной будущей официальной интеграции с API Zalo.

## Where it runs

Этот плагин работает **внутри процесса Gateway (шлюза)**.

Если вы используете удалённый Gateway (шлюз), установите и настройте плагин на **машине, на которой запущен Gateway (шлюз)**, затем перезапустите Gateway (шлюз).

## Install

### Option A: install from npm

```bash
openclaw plugins install @openclaw/zalouser
```

После этого перезапустите Gateway (шлюз).

### Option B: install from a local folder (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

После этого перезапустите Gateway (шлюз).

## Prerequisite: zca-cli

На машине Gateway (шлюза) должен быть установлен `zca` на `PATH`:

```bash
zca --version
```

## Config

Конфигурация канала находится в `channels.zalouser` (а не в `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Agent tool

Имя инструмента: `zalouser`

Действия: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
