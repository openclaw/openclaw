---
summary: "Plugin Zalo Personal : connexion QR + messagerie via zca-cli (installation plugin + config canal + CLI + outil)"
read_when:
  - Vous voulez le support Zalo Personal (non officiel) dans OpenClaw
  - Vous configurez ou développez le plugin zalouser
title: "Plugin Zalo Personal"
---

# Zalo Personal (plugin)

Support Zalo Personal pour OpenClaw via un plugin, utilisant `zca-cli` pour automatiser un compte utilisateur Zalo normal.

> **Attention :** L'automatisation non officielle peut conduire à la suspension/bannissement du compte. Utilisez à vos propres risques.

## Nomenclature

L'id de canal est `zalouser` pour rendre explicite que cela automatise un **compte utilisateur Zalo personnel** (non officiel). Nous gardons `zalo` réservé pour une potentielle future intégration API Zalo officielle.

## Où il s'exécute

Ce plugin s'exécute **à l'intérieur du processus de Passerelle**.

Si vous utilisez une Passerelle distante, installez/configurez-le sur la **machine exécutant la Passerelle**, puis redémarrez la Passerelle.

## Installation

### Option A : installer depuis npm

```bash
openclaw plugins install @openclaw/zalouser
```

Redémarrez la Passerelle ensuite.

### Option B : installer depuis un dossier local (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Redémarrez la Passerelle ensuite.

## Prérequis : zca-cli

La machine de Passerelle doit avoir `zca` sur `PATH` :

```bash
zca --version
```

## Configuration

La config de canal vit sous `channels.zalouser` (pas `plugins.entries.*`) :

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
openclaw message send --channel zalouser --target <threadId> --message "Bonjour depuis OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Outil d'agent

Nom d'outil : `zalouser`

Actions : `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
