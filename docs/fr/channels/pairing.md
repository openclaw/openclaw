---
summary: "Aperçu de l'appairage : approuve qui peut vous DM + quels nœuds peuvent rejoindre"
read_when:
  - Mise en place du contrôle d'accès aux DM
  - Pairing d’un nouveau nœud iOS/Android
  - Examen de la posture de sécurité d’OpenClaw
title: "Pairing"
---

# Pairing

Le « pairing » est l’étape explicite **d’approbation par le propriétaire** d’OpenClaw.
Il est utilisé à deux endroits :

1. **Pairing des messages privés (DM)** (qui est autorisé à parler au bot)
2. **Pairing des nœuds** (quels appareils/nœuds sont autorisés à rejoindre le réseau de la gateway (passerelle))

Contexte de sécurité : [Security](/gateway/security)

## 1. Pairing des messages privés (accès entrant au chat)

Lorsqu’un canal est configuré avec la politique de DM `pairing`, les expéditeurs inconnus reçoivent un code court et leur message n’est **pas traité** tant que vous n’avez pas approuvé.

Les politiques DM par défaut sont documentées dans : [Security](/gateway/security)

Codes de pairing :

- 8 caractères, en majuscules, sans caractères ambigus (`0O1I`).
- **Expirent après 1 heure**. Le bot n’envoie le message de pairing que lorsqu’une nouvelle demande est créée (environ une fois par heure et par expéditeur).
- Les demandes de pairing DM en attente sont limitées par défaut à **3 par canal** ; les demandes supplémentaires sont ignorées jusqu’à ce que l’une expire ou soit approuvée.

### Approuver un expéditeur

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Canaux pris en charge : `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Où l’état est stocké

Stocké sous `~/.openclaw/credentials/` :

- Demandes en attente : `<channel>-pairing.json`
- Stockage de la liste d’autorisation approuvée : `<channel>-allowFrom.json`

Traitez ces éléments comme sensibles (ils conditionnent l’accès à votre assistant).

## 2. Pairing des appareils nœuds (iOS/Android/macOS/nœuds headless)

Les nœuds se connectent à la Gateway (passerelle) en tant qu’**appareils** avec `role: node`. La Gateway
crée une demande de pairing d’appareil qui doit être approuvée.

### Approuver un appareil nœud

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Stockage de l’état de pairing des nœuds

Stocké sous `~/.openclaw/devices/` :

- `pending.json` (de courte durée ; les demandes en attente expirent)
- `paired.json` (appareils appairés + jetons)

### Remarques

- L’API héritée `node.pair.*` (CLI : `openclaw nodes pending/approve`) est un
  stockage de pairing distinct appartenant à la gateway. Les nœuds WS nécessitent toujours le pairing des appareils.

## Documentation associée

- Modèle de sécurité + prompt injection : [Security](/gateway/security)
- Mise à jour en toute sécurité (run doctor) : [Updating](/install/updating)
- Configurations de canaux :
  - Telegram : [Telegram](/channels/telegram)
  - WhatsApp : [WhatsApp](/channels/whatsapp)
  - Signal : [Signal](/channels/signal)
  - BlueBubbles (iMessage) : [BlueBubbles](/channels/bluebubbles)
  - iMessage (hérité) : [iMessage](/channels/imessage)
  - Discord : [Discord](/channels/discord)
  - Slack : [Slack](/channels/slack)
