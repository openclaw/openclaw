---
summary: "Zalo Personal-plugin: QR-login + beskeder via zca-cli (plugin-installation + kanal-konfiguration + CLI + værktøj)"
read_when:
  - Du vil have Zalo Personal (uofficiel) understøttelse i OpenClaw
  - Du konfigurerer eller udvikler zalouser-plugin’et
title: "Zalo Personal-plugin"
---

# Zalo Personal (plugin)

Zalo Personal-understøttelse til OpenClaw via et plugin, der bruger `zca-cli` til at automatisere en almindelig Zalo-brugerkonto.

> **Advarsel:** Uofficiel automatisering kan føre til kontosuspension/udelukkelse. Brug på egen risiko.

## Navngivning

Kanal-id er 'zalouser' for at gøre det eksplicit denne automatiserer en **personlig Zalo brugerkonto** (uofficiel). Vi holder `zalo` forbeholdt en potentiel fremtidig officiel Zalo API integration.

## Hvor det kører

Dette plugin kører **inde i Gateway-processen**.

Hvis du bruger en fjern-Gateway, skal du installere/konfigurere det på **maskinen, der kører Gateway**, og derefter genstarte Gateway.

## Installér

### Mulighed A: installér fra npm

```bash
openclaw plugins install @openclaw/zalouser
```

Genstart Gateway bagefter.

### Mulighed B: installér fra en lokal mappe (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Genstart Gateway bagefter.

## Forudsætning: zca-cli

Gateway-maskinen skal have `zca` på `PATH`:

```bash
zca --version
```

## Konfiguration

Kanal-konfigurationen findes under `channels.zalouser` (ikke `plugins.entries.*`):

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

## Agent-værktøj

Værktøjsnavn: `zalouser`

Handlinger: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
