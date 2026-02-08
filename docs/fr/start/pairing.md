---
summary: « Aperçu de l’appairage : approuver qui peut vous envoyer des messages privés + quels nœuds peuvent rejoindre »
read_when:
  - Configuration du contrôle d’accès aux messages privés
  - Appairage d’un nouveau nœud iOS/Android
  - Revue de la posture de sécurité d’OpenClaw
title: « Appairage »
x-i18n:
  source_path: start/pairing.md
  source_hash: 5a0539932f905536
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:50Z
---

# Appairage

L’« appairage » est l’étape explicite **d’approbation par le propriétaire** d’OpenClaw.
Il est utilisé à deux endroits :

1. **Appairage des messages privés (DM)** (qui est autorisé à parler au bot)
2. **Appairage des nœuds** (quels appareils/nœuds sont autorisés à rejoindre le réseau de la Gateway (passerelle))

Contexte de sécurité : [Security](/gateway/security)

## 1) Appairage des messages privés (accès aux discussions entrantes)

Lorsqu’un canal est configuré avec la politique DM `pairing`, les expéditeurs inconnus reçoivent un code court et leur message **n’est pas traité** tant que vous n’avez pas approuvé.

Les politiques DM par défaut sont documentées dans : [Security](/gateway/security)

Codes d’appairage :

- 8 caractères, en majuscules, sans caractères ambigus (`0O1I`).
- **Expirent après 1 heure**. Le bot n’envoie le message d’appairage que lorsqu’une nouvelle demande est créée (environ une fois par heure et par expéditeur).
- Les demandes d’appairage DM en attente sont plafonnées à **3 par canal** par défaut ; les demandes supplémentaires sont ignorées jusqu’à ce que l’une expire ou soit approuvée.

### Approuver un expéditeur

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Canaux pris en charge : `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Où l’état est stocké

Stocké sous `~/.openclaw/credentials/` :

- Demandes en attente : `<channel>-pairing.json`
- Magasin de liste d’autorisation approuvée : `<channel>-allowFrom.json`

Traitez ces éléments comme sensibles (ils contrôlent l’accès à votre assistant).

## 2) Appairage des appareils nœuds (iOS/Android/macOS/nœuds headless)

Les nœuds se connectent à la Gateway (passerelle) en tant qu’**appareils** avec `role: node`. La Gateway (passerelle)
crée une demande d’appairage d’appareil qui doit être approuvée.

### Approuver un appareil nœud

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Où l’état est stocké

Stocké sous `~/.openclaw/devices/` :

- `pending.json` (courte durée ; les demandes en attente expirent)
- `paired.json` (appareils appairés + jetons)

### Notes

- L’API héritée `node.pair.*` (CLI : `openclaw nodes pending/approve`) est un
  magasin d’appairage distinct appartenant à la gateway. Les nœuds WS nécessitent toujours l’appairage des appareils.

## Documentation associée

- Modèle de sécurité + injection d’invites : [Security](/gateway/security)
- Mise à jour en toute sécurité (exécuter doctor) : [Updating](/install/updating)
- Configurations des canaux :
  - Telegram : [Telegram](/channels/telegram)
  - WhatsApp : [WhatsApp](/channels/whatsapp)
  - Signal : [Signal](/channels/signal)
  - BlueBubbles (iMessage) : [BlueBubbles](/channels/bluebubbles)
  - iMessage (hérité) : [iMessage](/channels/imessage)
  - Discord : [Discord](/channels/discord)
  - Slack : [Slack](/channels/slack)
