---
summary: "Statut du support Matrix, capacites et configuration"
read_when:
  - Travail sur les fonctionnalites du canal Matrix
title: "Matrix"
---

# Matrix (plugin)

Matrix est un protocole de messagerie ouvert et decentralise. OpenClaw se connecte en tant qu’**utilisateur** Matrix
sur n’importe quel homeserver ; vous avez donc besoin d’un compte Matrix pour le bot. Une fois connecte, vous pouvez envoyer un Message prive
au bot directement ou l’inviter dans des salons (les « groupes » Matrix). Beeper est egalement une option de client valide,
mais il necessite l’activation de l’E2EE.

Statut : pris en charge via un plugin (@vector-im/matrix-bot-sdk). Messages prives, salons, fils, media, reactions,
sondages (envoi + poll-start en tant que texte), localisation et E2EE (avec prise en charge du chiffrement).

## Plugin requis

Matrix est fourni sous forme de plugin et n’est pas inclus dans l’installation du noyau.

Installation via la CLI (registre npm) :

```bash
openclaw plugins install @openclaw/matrix
```

Verification locale (lors d’une execution depuis un depot git) :

```bash
openclaw plugins install ./extensions/matrix
```

Si vous choisissez Matrix pendant la configuration/la prise en main et qu’un depot git est detecte,
OpenClaw proposera automatiquement le chemin d’installation local.

Details : [Plugins](/plugin)

## Configuration

1. Installez le plugin Matrix :
   - Depuis npm : `openclaw plugins install @openclaw/matrix`
   - Depuis une verification locale : `openclaw plugins install ./extensions/matrix`

2. Creez un compte Matrix sur un homeserver :
   - Parcourez les options d’hebergement sur [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Ou hebergez-le vous-meme.

3. Obtenez un jeton d’acces pour le compte du bot :

   - Utilisez l’API de connexion Matrix avec `curl` sur votre homeserver :

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Remplacez `matrix.example.org` par l’URL de votre homeserver.
   - Ou definissez `channels.matrix.userId` + `channels.matrix.password` : OpenClaw appelle le meme
     point de terminaison de connexion, stocke le jeton d’acces dans `~/.openclaw/credentials/matrix/credentials.json`,
     et le reutilise au demarrage suivant.

4. Configurez les informations d’identification :
   - Env : `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (ou `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Ou config : `channels.matrix.*`
   - Si les deux sont definis, la configuration est prioritaire.
   - Avec un jeton d’acces : l’ID utilisateur est recupere automatiquement via `/whoami`.
   - Lorsqu’il est defini, `channels.matrix.userId` doit etre l’ID Matrix complet (exemple : `@bot:example.org`).

5. Redemarrez la Gateway (passerelle) (ou terminez la prise en main).

6. Lancez un Message prive avec le bot ou invitez-le dans un salon depuis n’importe quel client Matrix
   (Element, Beeper, etc. ; voir https://matrix.org/ecosystem/clients/). Beeper necessite l’E2EE ;
   definissez donc `channels.matrix.encryption: true` et verifiez l’appareil.

Configuration minimale (jeton d’acces, ID utilisateur recupere automatiquement) :

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Configuration E2EE (chiffrement de bout en bout active) :

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Chiffrement (E2EE)

Le chiffrement de bout en bout est **pris en charge** via le SDK crypto Rust.

Activez-le avec `channels.matrix.encryption: true` :

- Si le module crypto se charge, les salons chiffres sont dechiffres automatiquement.
- Les médias sortants sont chiffrés lors de l'envoi vers des salles chiffrées.
- Lors de la premiere connexion, OpenClaw demande la verification de l’appareil depuis vos autres sessions.
- Verifiez l’appareil dans un autre client Matrix (Element, etc.) pour activer le partage de cles.
- Si le module crypto ne peut pas etre charge, l’E2EE est desactive et les salons chiffres ne seront pas dechiffres ;
  OpenClaw enregistre un avertissement.
- Si vous voyez des erreurs de module crypto manquant (par exemple, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  autorisez les scripts de build pour `@matrix-org/matrix-sdk-crypto-nodejs` et executez
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` ou recuperez le binaire avec
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

L’etat crypto est stocke par compte + jeton d’acces dans
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(base de donnees SQLite). L’etat de synchronisation se trouve a cote dans `bot-storage.json`.
Si le jeton d’acces (appareil) change, un nouveau stockage est cree et le bot doit etre
re-verifie pour les salons chiffres.

**Verification de l’appareil :**
Lorsque l’E2EE est active, le bot demandera la verification depuis vos autres sessions au demarrage.
Ouvrez Element (ou un autre client) et approuvez la demande de verification pour etablir la confiance.
Une fois verifie, le bot peut dechiffrer les messages dans les salons chiffres.

## Modele de routage

- Les reponses retournent toujours vers Matrix.
- Les Messages prives partagent la session principale de l’agent ; les salons correspondent a des sessions de groupe.

## Contrôle d'accès (DMs)

- Par defaut : `channels.matrix.dm.policy = "pairing"`. Les expediteurs inconnus recoivent un code d’appairage.
- Approbation via :
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Messages prives publics : `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepte des ID utilisateur Matrix complets (exemple : `@user:server`). L’assistant resolve les noms d’affichage en ID utilisateur lorsque la recherche d’annuaire trouve une correspondance unique exacte.

## Salons (groupes)

- Par defaut : `channels.matrix.groupPolicy = "allowlist"` (controle par mention). Utilisez `channels.defaults.groupPolicy` pour remplacer la valeur par defaut lorsqu’elle n’est pas definie.
- Autorisez des salons via `channels.matrix.groups` (ID de salon ou alias ; les noms sont resolus en ID lorsque la recherche d’annuaire trouve une correspondance unique exacte) :

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` active la reponse automatique dans ce salon.
- `groups."*"` peut definir des valeurs par defaut pour le controle par mention entre les salons.
- `groupAllowFrom` restreint quels expediteurs peuvent declencher le bot dans les salons (ID utilisateur Matrix complets).
- Des listes d’autorisation `users` par salon peuvent restreindre davantage les expediteurs au sein d’un salon specifique (utilisez des ID utilisateur Matrix complets).
- L’assistant de configuration demande des listes d’autorisation de salons (ID de salon, alias ou noms) et ne resolve les noms qu’en cas de correspondance exacte et unique.
- Au demarrage, OpenClaw resolve les noms de salon/utilisateur dans les listes d’autorisation en ID et consigne le mapping ; les entrees non resolues sont ignorees pour la correspondance des listes d’autorisation.
- Les invitations sont rejointes automatiquement par defaut ; controlez ce comportement avec `channels.matrix.autoJoin` et `channels.matrix.autoJoinAllowlist`.
- Pour n’autoriser **aucun salon**, definissez `channels.matrix.groupPolicy: "disabled"` (ou conservez une liste d’autorisation vide).
- Cle heritee : `channels.matrix.rooms` (meme structure que `groups`).

## Fil de discussion

- Les reponses en fil sont prises en charge.
- `channels.matrix.threadReplies` controle si les reponses restent dans les fils :
  - `off`, `inbound` (par defaut), `always`
- `channels.matrix.replyToMode` controle les metadonnees de reponse lorsque l’on ne repond pas dans un fil :
  - `off` (par defaut), `first`, `all`

## Capacites

| Fonctionnalite    | Statut                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Messages directs  | ✅ Pris en charge                                                                                                                |
| Salons            | ✅ Pris en charge                                                                                                                |
| Fil de discussion | ✅ Pris en charge                                                                                                                |
| Media             | ✅ Pris en charge                                                                                                                |
| E2EE              | ✅ Pris en charge (module crypto requis)                                                                      |
| Reactions         | ✅ Pris en charge (envoi/lecture via des outils)                                                              |
| Sondages          | ✅ Envoi pris en charge ; les demarrages de sondage entrants sont convertis en texte (reponses/fins ignorees) |
| Localisation      | ✅ Pris en charge (URI geo ; altitude ignoree)                                                                |
| Commandes natives | ✅ Pris en charge                                                                                                                |

## Problemes courants

Exécutez d'abord cette échelle :

```bash
openclaw models auth paste-token --provider anthropic
openclaw models status
```

Ensuite, confirmez l'état d'appairage du DM si nécessaire:

```bash
openclaw pairing list matrix
```

Échecs communs :

- Connecté mais les messages de la salle ont été ignorés: espace bloqué par `groupPolicy` ou la liste d'autorisations de salle.
- DMs ignorés: expéditeur en attente d'approbation lorsque `channels.matrix.dm.policy="appairage"`.
- Les salles chiffrées échouent : le support du cryptage ou les paramètres de chiffrement ne correspondent pas.

channels/matrix.md

## Reference de configuration (Matrix)

Configuration complete : [Configuration](/gateway/configuration)

Options du fournisseur :

- `channels.matrix.enabled` : activer/desactiver le demarrage du canal.
- `channels.matrix.homeserver` : URL du homeserver.
- `channels.matrix.userId` : ID utilisateur Matrix (optionnel avec jeton d’acces).
- `channels.matrix.accessToken` : jeton d’acces.
- `channels.matrix.password` : mot de passe pour la connexion (jeton stocke).
- `channels.matrix.deviceName` : nom d’affichage de l’appareil.
- `channels.matrix.encryption` : activer l’E2EE (par defaut : false).
- `channels.matrix.initialSyncLimit` : limite de synchronisation initiale.
- `channels.matrix.threadReplies` : `off | inbound | always` (par defaut : inbound).
- `channels.matrix.textChunkLimit` : taille des fragments de texte sortants (caracteres).
- `channels.matrix.chunkMode` : `length` (par defaut) ou `newline` pour fractionner sur les lignes vides (frontieres de paragraphes) avant le fractionnement par longueur.
- `channels.matrix.dm.policy` : `pairing | allowlist | open | disabled` (par defaut : appairage).
- `channels.matrix.dm.allowFrom` : liste d’autorisation des Messages prives (ID utilisateur Matrix complets). `open` requiert `"*"`. L’assistant resolve les noms en ID lorsque c’est possible.
- `channels.matrix.groupPolicy` : `allowlist | open | disabled` (par defaut : liste d’autorisation).
- `channels.matrix.groupAllowFrom` : expediteurs autorises pour les messages de groupe (ID utilisateur Matrix complets).
- `channels.matrix.allowlistOnly` : forcer les regles de liste d’autorisation pour Messages prives + salons.
- `channels.matrix.groups` : liste d’autorisation de groupe + carte des parametres par salon.
- `channels.matrix.rooms` : liste d’autorisation/configuration de groupe heritee.
- `channels.matrix.replyToMode` : mode de reponse pour les fils/balises.
- `channels.matrix.mediaMaxMb` : plafond de media entrant/sortant (Mo).
- `channels.matrix.autoJoin` : gestion des invitations (`always | allowlist | off`, par defaut : toujours).
- `channels.matrix.autoJoinAllowlist` : ID/alias de salons autorises pour l’adhesion automatique.
- `channels.matrix.actions` : controle d’outils par action (reactions/messages/epingles/memberInfo/channelInfo).
