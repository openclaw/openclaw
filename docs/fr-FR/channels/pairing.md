---
summary: "Aperçu de l'appairage : approuver qui peut vous envoyer des DM + quels nœuds peuvent rejoindre"
read_when:
  - Configuration du contrôle d'accès DM
  - Appairage d'un nouveau nœud iOS/Android
  - Examen de la posture de sécurité OpenClaw
title: "Appairage"
---

# Appairage

"L'appairage" est l'étape d'**approbation explicite du propriétaire** d'OpenClaw.
Elle est utilisée dans deux endroits :

1. **Appairage DM** (qui est autorisé à parler au bot)
2. **Appairage de nœud** (quels appareils/nœuds sont autorisés à rejoindre le réseau de passerelle)

Contexte de sécurité : [Sécurité](/fr-FR/gateway/security)

## 1) Appairage DM (accès discussion entrant)

Quand un canal est configuré avec la politique DM `pairing`, les expéditeurs inconnus reçoivent un code court et leur message **n'est pas traité** jusqu'à ce que vous approuviez.

Les politiques DM par défaut sont documentées dans : [Sécurité](/fr-FR/gateway/security)

Codes d'appairage :

- 8 caractères, majuscules, pas de caractères ambigus (`0O1I`).
- **Expirent après 1 heure**. Le bot n'envoie le message d'appairage que quand une nouvelle demande est créée (environ une fois par heure par expéditeur).
- Les demandes d'appairage DM en attente sont plafonnées à **3 par canal** par défaut ; les demandes supplémentaires sont ignorées jusqu'à ce qu'une expire ou soit approuvée.

### Approuver un expéditeur

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Canaux supportés : `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### Où vit l'état

Stocké sous `~/.openclaw/credentials/` :

- Demandes en attente : `<channel>-pairing.json`
- Magasin de liste blanche approuvée : `<channel>-allowFrom.json`

Traitez-les comme sensibles (ils contrôlent l'accès à votre assistant).

## 2) Appairage de nœud d'appareil (nœuds iOS/Android/macOS/sans tête)

Les nœuds se connectent à la Passerelle comme **appareils** avec `role: node`. La Passerelle crée une demande d'appairage d'appareil qui doit être approuvée.

### Appairer via Telegram (recommandé pour iOS)

Si vous utilisez le plugin `device-pair`, vous pouvez faire l'appairage d'appareil initial entièrement depuis Telegram :

1. Dans Telegram, envoyez un message à votre bot : `/pair`
2. Le bot répond avec deux messages : un message d'instruction et un message de **code de configuration** séparé (facile à copier/coller dans Telegram).
3. Sur votre téléphone, ouvrez l'app OpenClaw iOS → Paramètres → Passerelle.
4. Collez le code de configuration et connectez-vous.
5. De retour dans Telegram : `/pair approve`

Le code de configuration est une charge utile JSON encodée en base64 qui contient :

- `url` : l'URL WebSocket de Passerelle (`ws://...` ou `wss://...`)
- `token` : un token d'appairage à courte durée de vie

Traitez le code de configuration comme un mot de passe tant qu'il est valide.

### Approuver un appareil nœud

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Stockage de l'état d'appairage de nœud

Stocké sous `~/.openclaw/devices/` :

- `pending.json` (à courte durée de vie ; les demandes en attente expirent)
- `paired.json` (appareils appairés + tokens)

### Notes

- L'ancienne API `node.pair.*` (CLI : `openclaw nodes pending/approve`) est un magasin d'appairage détenu par la passerelle séparé. Les nœuds WS nécessitent toujours l'appairage d'appareil.

## Docs connexes

- Modèle de sécurité + injection de prompt : [Sécurité](/fr-FR/gateway/security)
- Mise à jour en toute sécurité (exécuter doctor) : [Mise à jour](/fr-FR/install/updating)
- Configs de canal :
  - Telegram : [Telegram](/fr-FR/channels/telegram)
  - WhatsApp : [WhatsApp](/fr-FR/channels/whatsapp)
  - Signal : [Signal](/fr-FR/channels/signal)
  - BlueBubbles (iMessage) : [BlueBubbles](/fr-FR/channels/bluebubbles)
  - iMessage (ancien) : [iMessage](/fr-FR/channels/imessage)
  - Discord : [Discord](/fr-FR/channels/discord)
  - Slack : [Slack](/fr-FR/channels/slack)
