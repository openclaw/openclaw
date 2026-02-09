---
summary: "Prise en charge de Signal via signal-cli (JSON-RPC + SSE), configuration et modèle de numéros"
read_when:
  - Configuration de la prise en charge de Signal
  - Dépannage de l’envoi/réception Signal
title: "Signal"
---

# Signal (signal-cli)

Statut : intégration CLI externe. La Gateway communique avec `signal-cli` via HTTP JSON-RPC + SSE.

## Demarrage rapide (debutant)

1. Utilisez un **numero Signal distinct** pour le bot (recommande).
2. Installez `signal-cli` (Java requis).
3. Liez l’appareil du bot et demarrez le daemon :
   - `signal-cli link -n "OpenClaw"`
4. Configurez OpenClaw et demarrez la Gateway.

Configuration minimale :

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Ce que c’est

- Canal Signal via `signal-cli` (pas de libsignal embarquee).
- Routage deterministe : les reponses reviennent toujours sur Signal.
- Les Messages prives partagent la session principale de l’agent ; les groupes sont isoles (`agent:<agentId>:signal:group:<groupId>`).

## Ecritures de configuration

Par defaut, Signal est autorise a ecrire des mises a jour de configuration declenchees par `/config set|unset` (necessite `commands.config: true`).

Desactiver avec :

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## Le modele de numeros (important)

- La Gateway se connecte a un **appareil Signal** (le compte `signal-cli`).
- Si vous executez le bot sur **votre compte Signal personnel**, il ignorera vos propres messages (protection contre les boucles).
- Pour « je texte le bot et il repond », utilisez un **numero de bot distinct**.

## Configuration (chemin rapide)

1. Installez `signal-cli` (Java requis).
2. Liez un compte bot :
   - `signal-cli link -n "OpenClaw"` puis scannez le QR dans Signal.
3. Configurez Signal et demarrez la Gateway.

Exemple :

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Prise en charge multi-comptes : utilisez `channels.signal.accounts` avec une configuration par compte et `name` en option. Voir [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) pour le modele partage.

## Mode daemon externe (httpUrl)

Si vous souhaitez gerer `signal-cli` vous-meme (demarrages JVM a froid lents, initialisation de conteneur ou CPU partages), lancez le daemon separement et pointez OpenClaw dessus :

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

Cela ignore l’auto-lancement et l’attente de demarrage dans OpenClaw. Pour des demarrages lents lors de l’auto-lancement, definissez `channels.signal.startupTimeoutMs`.

## Controle d’acces (Messages prives + groupes)

DMs:

- Par defaut : `channels.signal.dmPolicy = "pairing"`.
- Les expediteurs inconnus recoivent un code d’appairage ; les messages sont ignores jusqu’a approbation (les codes expirent apres 1 heure).
- Approuver via :
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- L’appairage est l’echange de jeton par defaut pour les Messages prives Signal. Details : [Appairage](/start/pairing)
- Les expediteurs uniquement UUID (depuis `sourceUuid`) sont stockes comme `uuid:<id>` dans `channels.signal.allowFrom`.

Groupes :

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` controle qui peut declencher dans les groupes lorsque `allowlist` est defini.

## Comment ça marche (comportement)

- `signal-cli` s’execute comme un daemon ; la Gateway lit les evenements via SSE.
- Les messages entrants sont normalises dans l’enveloppe de canal partagee.
- Les reponses sont toujours renvoyees vers le meme numero ou groupe.

## Medias + limites

- Le texte sortant est segmente en blocs de `channels.signal.textChunkLimit` (par defaut 4000).
- Segmentation optionnelle par sauts de ligne : definir `channels.signal.chunkMode="newline"` pour decouper sur les lignes vides (frontieres de paragraphes) avant la segmentation par longueur.
- Pieces jointes prises en charge (base64 recupere depuis `signal-cli`).
- Limite media par defaut : `channels.signal.mediaMaxMb` (par defaut 8).
- Utilisez `channels.signal.ignoreAttachments` pour ignorer le telechargement des medias.
- Le contexte d’historique de groupe utilise `channels.signal.historyLimit` (ou `channels.signal.accounts.*.historyLimit`), avec repli vers `messages.groupChat.historyLimit`. Definir `0` pour desactiver (par defaut 50).

## Indicateurs de saisie + accusés de lecture

- **Indicateurs de saisie** : OpenClaw envoie des signaux de saisie via `signal-cli sendTyping` et les rafraichit pendant l’execution d’une reponse.
- **Accuses de lecture** : lorsque `channels.signal.sendReadReceipts` est vrai, OpenClaw transmet les accuses de lecture pour les Messages prives autorises.
- Signal-cli n’expose pas les accuses de lecture pour les groupes.

## Reactions (outil message)

- Utilisez `message action=react` avec `channel=signal`.
- Cibles : expediteur E.164 ou UUID (utilisez `uuid:<id>` depuis la sortie d’appairage ; l’UUID brut fonctionne aussi).
- `messageId` est l’horodatage Signal du message auquel vous reagissez.
- Les reactions en groupe necessitent `targetAuthor` ou `targetAuthorUuid`.

Exemples :

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Configuration :

- `channels.signal.actions.reactions` : activer/desactiver les actions de reaction (par defaut true).
- `channels.signal.reactionLevel` : `off | ack | minimal | extensive`.
  - `off`/`ack` desactive les reactions de l’agent (l’outil message `react` renverra une erreur).
  - `minimal`/`extensive` active les reactions de l’agent et definit le niveau de guidage.
- Surcharges par compte : `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Cibles de livraison (CLI/cron)

- Messages prives : `signal:+15551234567` (ou E.164 simple).
- Messages prives UUID : `uuid:<id>` (ou UUID brut).
- Groupes : `signal:group:<groupId>`.
- Noms d’utilisateur : `username:<name>` (si pris en charge par votre compte Signal).

## Problemes courants

Exécutez d'abord cette échelle :

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

Ensuite, confirmez l'état d'appairage du DM si nécessaire:

```bash
openclaw pairing list signal
```

Échecs communs :

- Le démon est joignable mais pas de réponses : vérifiez les paramètres du compte/démon (`httpUrl`, `account`) et le mode réception.
- DMs ignorés: l'expéditeur est en attente d'approbation du jumelage.
- Les messages de groupe ont été ignorés : envoi de blocs de barrière d'expéditeur/mention de groupe.

channels/signal.md

## Reference de configuration (Signal)

Configuration complete : [Configuration](/gateway/configuration)

Options du fournisseur :

- `channels.signal.enabled` : activer/desactiver le demarrage du canal.
- `channels.signal.account` : E.164 pour le compte bot.
- `channels.signal.cliPath` : chemin vers `signal-cli`.
- `channels.signal.httpUrl` : URL complete du daemon (remplace hote/port).
- `channels.signal.httpHost`, `channels.signal.httpPort` : liaison du daemon (par defaut 127.0.0.1:8080).
- `channels.signal.autoStart` : auto-lancement du daemon (par defaut true si `httpUrl` n’est pas defini).
- `channels.signal.startupTimeoutMs` : delai d’attente au demarrage en ms (plafond 120000).
- `channels.signal.receiveMode` : `on-start | manual`.
- `channels.signal.ignoreAttachments` : ignorer le telechargement des pieces jointes.
- `channels.signal.ignoreStories` : ignorer les stories du daemon.
- `channels.signal.sendReadReceipts` : transmettre les accuses de lecture.
- `channels.signal.dmPolicy` : `pairing | allowlist | open | disabled` (par defaut : appairage).
- `channels.signal.allowFrom` : liste blanche des Messages prives (E.164 ou `uuid:<id>`). `open` necessite `"*"`. Signal n’a pas de noms d’utilisateur ; utilisez des identifiants telephone/UUID.
- `channels.signal.groupPolicy` : `open | allowlist | disabled` (par defaut : liste blanche).
- `channels.signal.groupAllowFrom` : liste blanche des expediteurs de groupe.
- `channels.signal.historyLimit` : nombre maximal de messages de groupe a inclure comme contexte (0 desactive).
- `channels.signal.dmHistoryLimit` : limite d’historique des Messages prives en tours utilisateur. Surcharges par utilisateur : `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit` : taille de segmentation sortante (caracteres).
- `channels.signal.chunkMode` : `length` (par defaut) ou `newline` pour decouper sur les lignes vides (frontieres de paragraphes) avant la segmentation par longueur.
- `channels.signal.mediaMaxMb` : limite media entrante/sortante (Mo).

Options globales associees :

- `agents.list[].groupChat.mentionPatterns` (Signal ne prend pas en charge les mentions natives).
- `messages.groupChat.mentionPatterns` (repli global).
- `messages.responsePrefix`.
