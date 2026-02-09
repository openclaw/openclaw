---
summary: "Zalo Personal-plugin: QR-inloggen + berichten via zca-cli (plugin-installatie + kanaalconfiguratie + CLI + tool)"
read_when:
  - Je wilt Zalo Personal (onofficieel) ondersteuning in OpenClaw
  - Je configureert of ontwikkelt de zalouser-plugin
title: "Zalo Personal-plugin"
---

# Zalo Personal (plugin)

Zalo Personal-ondersteuning voor OpenClaw via een plugin, met gebruik van `zca-cli` om een normaal Zalo-gebruikersaccount te automatiseren.

> **Waarschuwing:** Onofficiële automatisering kan leiden tot schorsing/blokkering van het account. Gebruik op eigen risico.

## Naamgeving

De kanaal-id is `zalouser` om expliciet te maken dat dit een **persoonlijk Zalo-gebruikersaccount** (onofficieel) automatiseert. We houden `zalo` gereserveerd voor een mogelijke toekomstige officiële Zalo API-integratie.

## Waar het draait

Deze plugin draait **binnen het Gateway-proces**.

Als je een externe Gateway gebruikt, installeer/configureer deze dan op de **machine waarop de Gateway draait**, en start de Gateway daarna opnieuw.

## Installeren

### Optie A: installeren vanaf npm

```bash
openclaw plugins install @openclaw/zalouser
```

Start de Gateway daarna opnieuw.

### Optie B: installeren vanuit een lokale map (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Start de Gateway daarna opnieuw.

## Vereiste: zca-cli

De Gateway-machine moet `zca` hebben op `PATH`:

```bash
zca --version
```

## Configuratie

Kanaalconfiguratie staat onder `channels.zalouser` (niet `plugins.entries.*`):

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

## Agent-tool

Toolnaam: `zalouser`

Acties: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
