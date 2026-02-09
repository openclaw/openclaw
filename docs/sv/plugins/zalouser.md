---
summary: "Zalo Personal‑plugin: QR‑inloggning + meddelanden via zca‑cli (plugininstallation + kanalkonfig + CLI + verktyg)"
read_when:
  - Du vill ha stöd för Zalo Personal (inofficiellt) i OpenClaw
  - Du konfigurerar eller utvecklar zalouser‑pluginet
title: "Zalo Personal‑plugin"
---

# Zalo Personal (plugin)

Stöd för Zalo Personal i OpenClaw via ett plugin som använder `zca-cli` för att automatisera ett vanligt Zalo‑användarkonto.

> **Varning:** Inofficiell automatisering kan leda till kontoavstängning/avstängning. Använd på egen risk.

## Namngivning

Kanalid är `zalouser` för att göra det explicit detta automatiserar ett **personligt Zalo användarkonto** (inofficiellt). Vi håller `zalo` reserverad för en potentiell framtida officiell Zalo API-integration.

## Var den körs

Detta plugin körs **inuti Gateway‑processen**.

Om du använder en fjärr‑Gateway, installera/konfigurera det på **maskinen som kör Gateway**, och starta sedan om Gateway.

## Installera

### Alternativ A: installera från npm

```bash
openclaw plugins install @openclaw/zalouser
```

Starta om Gateway efteråt.

### Alternativ B: installera från en lokal mapp (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Starta om Gateway efteråt.

## Förutsättning: zca-cli

Gateway‑maskinen måste ha `zca` på `PATH`:

```bash
zca --version
```

## Konfig

Kanalkonfigen ligger under `channels.zalouser` (inte `plugins.entries.*`):

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

## Agentverktyg

Verktygsnamn: `zalouser`

Åtgärder: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
