---
summary: "Plugin Zalo Personal : connexion par QR + messagerie via zca-cli (installation du plugin + configuration du canal + CLI + outil)"
read_when:
  - Vous voulez la prise en charge de Zalo Personal (non officiel) dans OpenClaw
  - Vous configurez ou developpez le plugin zalouser
title: "Plugin Zalo Personal"
---

# Zalo Personal (plugin)

Prise en charge de Zalo Personal pour OpenClaw via un plugin, utilisant `zca-cli` pour automatiser un compte utilisateur Zalo normal.

> **Avertissement :** L’automatisation non officielle peut entrainer une suspension ou un bannissement du compte. Utilisez a vos risques et perils.

## Nommer

L’identifiant du canal est `zalouser` afin de rendre explicite qu’il automatise un **compte utilisateur Zalo personnel** (non officiel). Nous conservons `zalo` en reserve pour une eventuelle integration future de l’API officielle Zalo.

## Où cela s’exécute

Ce plugin s’execute **dans le processus du Gateway (passerelle)**.

Si vous utilisez un Gateway distant, installez-le et configurez-le sur la **machine executant le Gateway**, puis redemarrez le Gateway.

## Installation

### Option A : installer depuis npm

```bash
openclaw plugins install @openclaw/zalouser
```

Redemarrez ensuite le Gateway.

### Option B : installer depuis un dossier local (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Redemarrez ensuite le Gateway.

## Prerequis : zca-cli

La machine du Gateway doit avoir `zca` sur `PATH` :

```bash
zca --version
```

## Configuration

La configuration du canal se trouve sous `channels.zalouser` (et non `plugins.entries.*`) :

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

## Outil de l’agent

Nom de l’outil : `zalouser`

Actions : `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
