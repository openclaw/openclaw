---
summary: "iMessage via le serveur macOS BlueBubbles (envoi/réception REST, saisie, réactions, appairage, actions avancées)."
read_when:
  - Configuration du canal BlueBubbles
  - Dépannage de l’appairage des webhooks
  - Configuration d’iMessage sur macOS
title: "BlueBubbles"
---

# BlueBubbles (REST macOS)

Statut : plugin intégré qui communique avec le serveur macOS BlueBubbles via HTTP. **Recommandé pour l’intégration iMessage** grâce à son API plus riche et à une configuration plus simple que le canal imsg historique.

## Présentation

- Fonctionne sur macOS via l’application d’assistance BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Recommandé/testé : macOS Sequoia (15). macOS Tahoe (26) fonctionne ; l’édition est actuellement défaillante sur Tahoe, et les mises à jour d’icône de groupe peuvent signaler un succès sans se synchroniser.
- OpenClaw communique avec lui via son API REST (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Les messages entrants arrivent via des webhooks ; les réponses sortantes, indicateurs de saisie, accusés de lecture et tapbacks sont des appels REST.
- Les pièces jointes et autocollants sont ingérés comme médias entrants (et exposés à l’agent lorsque possible).
- L’appairage/la liste d’autorisation fonctionne comme pour les autres canaux (`/start/pairing` etc.) avec `channels.bluebubbles.allowFrom` + codes d’appairage.
- Les réactions sont exposées comme des événements système, comme sur Slack/Telegram, afin que les agents puissent les « mentionner » avant de répondre.
- Fonctionnalités avancées : édition, annulation d’envoi, réponses en fil, effets de message, gestion des groupes.

## Demarrage rapide

1. Installez le serveur BlueBubbles sur votre Mac (suivez les instructions sur [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Dans la configuration BlueBubbles, activez l’API web et définissez un mot de passe.

3. Exécutez `openclaw onboard` et sélectionnez BlueBubbles, ou configurez manuellement :

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Pointez les webhooks BlueBubbles vers votre gateway (passerelle) (exemple : `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Démarrez la gateway ; elle enregistrera le gestionnaire de webhook et lancera l’appairage.

## Maintenir Messages.app actif (VM / configurations sans interface)

Certaines configurations macOS en VM / toujours actives peuvent voir Messages.app passer en mode « idle » (les événements entrants cessent jusqu’à ce que l’application soit ouverte/au premier plan). Une solution simple consiste à **stimuler Messages toutes les 5 minutes** à l’aide d’un AppleScript + LaunchAgent.

### 1. Enregistrer l’AppleScript

Enregistrez ceci sous :

- `~/Scripts/poke-messages.scpt`

Script d’exemple (non interactif ; ne vole pas le focus) :

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Installer un LaunchAgent

Enregistrez ceci sous :

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Notes :

- Cela s’exécute **toutes les 300 secondes** et **à la connexion**.
- La première exécution peut déclencher des invites macOS **Automation** (`osascript` → Messages). Approuvez-les dans la même session utilisateur que celle qui exécute le LaunchAgent.

Chargez-le :

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Dépannage

BlueBubbles est disponible dans l’assistant de configuration interactif :

```
openclaw onboard
```

L'assistant demande :

- **URL du serveur** (obligatoire) : adresse du serveur BlueBubbles (p. ex., `http://192.168.1.100:1234`)
- **Mot de passe** (obligatoire) : mot de passe de l’API depuis les paramètres du serveur BlueBubbles
- **Chemin du webhook** (facultatif) : par défaut `/bluebubbles-webhook`
- **Politique de DM** : appairage, liste d’autorisation, ouvert ou désactivé
- **Liste d’autorisation** : numéros de téléphone, e-mails ou cibles de chat

Vous pouvez également ajouter BlueBubbles via la CLI :

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Contrôle d’accès (Messages prives + groupes)

DMs:

- Par défaut : `channels.bluebubbles.dmPolicy = "pairing"`.
- Les expéditeurs inconnus reçoivent un code d’appairage ; les messages sont ignorés jusqu’à approbation (les codes expirent après 1 heure).
- Approuver via :
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- L’appairage est l’échange de jetons par défaut. Détails : [Pairing](/start/pairing)

Groupes :

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (par défaut : `allowlist`).
- `channels.bluebubbles.groupAllowFrom` contrôle qui peut déclencher dans les groupes lorsque `allowlist` est défini.

### Filtrage par mention (groupes)

BlueBubbles prend en charge le filtrage par mention pour les discussions de groupe, conforme au comportement iMessage/WhatsApp :

- Utilise `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`) pour détecter les mentions.
- Lorsque `requireMention` est activé pour un groupe, l’agent répond uniquement lorsqu’il est mentionné.
- Les commandes de contrôle provenant d’expéditeurs autorisés contournent le filtrage par mention.

Configuration par groupe :

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Porte de commandement

- Les commandes de contrôle (p. ex., `/config`, `/model`) nécessitent une autorisation.
- Utilise `allowFrom` et `groupAllowFrom` pour déterminer l’autorisation des commandes.
- Les expéditeurs autorisés peuvent exécuter des commandes de contrôle même sans mentionner dans les groupes.

## Indicateurs de saisie + accusés de lecture

- **Indicateurs de saisie** : envoyés automatiquement avant et pendant la génération de la réponse.
- **Accusés de lecture** : contrôlés par `channels.bluebubbles.sendReadReceipts` (par défaut : `true`).
- **Indicateurs de saisie** : OpenClaw envoie des événements de début de saisie ; BlueBubbles efface automatiquement l’état de saisie à l’envoi ou à l’expiration (l’arrêt manuel via DELETE n’est pas fiable).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Actions avancées

BlueBubbles prend en charge des actions de message avancées lorsqu’elles sont activées dans la configuration :

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Actions disponibles :

- **react** : ajouter/supprimer des réactions tapback (`messageId`, `emoji`, `remove`)
- **edit** : modifier un message envoyé (`messageId`, `text`)
- **unsend** : annuler l’envoi d’un message (`messageId`)
- **reply** : répondre à un message spécifique (`messageId`, `text`, `to`)
- **sendWithEffect** : envoyer avec un effet iMessage (`text`, `to`, `effectId`)
- **renameGroup** : renommer une discussion de groupe (`chatGuid`, `displayName`)
- **setGroupIcon** : définir l’icône/photo d’un groupe (`chatGuid`, `media`) — instable sur macOS 26 Tahoe (l’API peut renvoyer un succès sans synchronisation de l’icône).
- **addParticipant** : ajouter quelqu’un à un groupe (`chatGuid`, `address`)
- **removeParticipant** : retirer quelqu’un d’un groupe (`chatGuid`, `address`)
- **leaveGroup** : quitter un groupe (`chatGuid`)
- **sendAttachment** : envoyer des médias/fichiers (`to`, `buffer`, `filename`, `asVoice`)
  - Mémos vocaux : définir `asVoice: true` avec de l’audio **MP3** ou **CAF** pour envoyer un message vocal iMessage. BlueBubbles convertit MP3 → CAF lors de l’envoi des mémos vocaux.

### ID de message (court vs complet)

OpenClaw peut exposer des ID de message _courts_ (p. ex., `1`, `2`) pour économiser des jetons.

- `MessageSid` / `ReplyToId` peuvent être des ID courts.
- `MessageSidFull` / `ReplyToIdFull` contiennent les ID complets du fournisseur.
- Les ID courts sont en mémoire ; ils peuvent expirer au redémarrage ou lors de l’éviction du cache.
- Les actions acceptent des `messageId` courts ou complets, mais les ID courts généreront une erreur s’ils ne sont plus disponibles.

Utilisez des ID complets pour des automatisations et un stockage durables :

- Modèles : `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Contexte : `MessageSidFull` / `ReplyToIdFull` dans les charges utiles entrantes

Voir [Configuration](/gateway/configuration) pour les variables de modèle.

## Blocage du streaming

Contrôlez si les réponses sont envoyées en un seul message ou diffusées par blocs :

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Médias + limites

- Les pièces jointes entrantes sont téléchargées et stockées dans le cache média.
- Plafond média via `channels.bluebubbles.mediaMaxMb` (par défaut : 8 Mo).
- Le texte sortant est segmenté selon `channels.bluebubbles.textChunkLimit` (par défaut : 4000 caractères).

## Référence de configuration

Configuration complète : [Configuration](/gateway/configuration)

Options du fournisseur :

- `channels.bluebubbles.enabled` : activer/désactiver le canal.
- `channels.bluebubbles.serverUrl` : URL de base de l’API REST BlueBubbles.
- `channels.bluebubbles.password` : mot de passe de l’API.
- `channels.bluebubbles.webhookPath` : chemin du point de terminaison webhook (par défaut : `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy` : `pairing | allowlist | open | disabled` (par défaut : `pairing`).
- `channels.bluebubbles.allowFrom` : liste d’autorisation des DM (identifiants, e-mails, numéros E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy` : `open | allowlist | disabled` (par défaut : `allowlist`).
- `channels.bluebubbles.groupAllowFrom` : liste d’autorisation des expéditeurs de groupe.
- `channels.bluebubbles.groups` : configuration par groupe (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts` : envoyer les accusés de lecture (par défaut : `true`).
- `channels.bluebubbles.blockStreaming` : activer le streaming par blocs (par défaut : `false` ; requis pour les réponses en streaming).
- `channels.bluebubbles.textChunkLimit` : taille des segments sortants en caractères (par défaut : 4000).
- `channels.bluebubbles.chunkMode` : `length` (par défaut) segmente uniquement au-delà de `textChunkLimit` ; `newline` segmente sur les lignes vides (limites de paragraphe) avant le découpage par longueur.
- `channels.bluebubbles.mediaMaxMb` : plafond des médias entrants en Mo (par défaut : 8).
- `channels.bluebubbles.historyLimit` : nombre maximal de messages de groupe pour le contexte (0 désactive).
- `channels.bluebubbles.dmHistoryLimit` : limite d’historique des DM.
- `channels.bluebubbles.actions` : activer/désactiver des actions spécifiques.
- `channels.bluebubbles.accounts` : configuration multi-comptes.

Options globales associées :

- `agents.list[].groupChat.mentionPatterns` (ou `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adressage / cibles de livraison

Préférez `chat_guid` pour un routage stable :

- `chat_guid:iMessage;-;+15555550123` (préféré pour les groupes)
- `chat_id:123`
- `chat_identifier:...`
- Identifiants directs : `+15555550123`, `user@example.com`
  - Si un identifiant direct n’a pas de discussion DM existante, OpenClaw en créera une via `POST /api/v1/chat/new`. Cela nécessite l’activation de l’API privée BlueBubbles.

## Sécurité

- Les requêtes webhook sont authentifiées en comparant les paramètres de requête ou en-têtes `guid`/`password` avec `channels.bluebubbles.password`. Les requêtes provenant de `localhost` sont également acceptées.
- Conservez le mot de passe de l’API et le point de terminaison webhook secrets (traitez-les comme des identifiants).
- La confiance localhost signifie qu’un proxy inverse sur le même hôte peut contourner involontairement le mot de passe. Si vous proxifiez la gateway (passerelle), exigez une authentification au niveau du proxy et configurez `gateway.trustedProxies`. Voir [Sécurité de la gateway](/gateway/security#reverse-proxy-configuration).
- Activez HTTPS + des règles de pare-feu sur le serveur BlueBubbles si vous l’exposez en dehors de votre LAN.

## Problemes courants

- Si les événements de saisie/lecture cessent de fonctionner, vérifiez les journaux de webhook BlueBubbles et assurez-vous que le chemin de la gateway correspond à `channels.bluebubbles.webhookPath`.
- Les codes d’appairage expirent après une heure ; utilisez `openclaw pairing list bluebubbles` et `openclaw pairing approve bluebubbles <code>`.
- Les réactions nécessitent l’API privée BlueBubbles (`POST /api/v1/message/react`) ; assurez-vous que la version du serveur l’expose.
- L’édition/l’annulation d’envoi nécessitent macOS 13+ et une version compatible du serveur BlueBubbles. Sur macOS 26 (Tahoe), l’édition est actuellement défaillante en raison de changements de l’API privée.
- Les mises à jour d’icône de groupe peuvent être instables sur macOS 26 (Tahoe) : l’API peut renvoyer un succès sans synchroniser la nouvelle icône.
- OpenClaw masque automatiquement les actions connues comme défaillantes en fonction de la version macOS du serveur BlueBubbles. Si l’édition apparaît encore sur macOS 26 (Tahoe), désactivez-la manuellement avec `channels.bluebubbles.actions.edit=false`.
- Pour les informations d’état/de santé : `openclaw status --all` ou `openclaw status --deep`.

Pour une référence générale sur le flux de travail des canaux, consultez [Channels](/channels) et le guide [Plugins](/plugins).
