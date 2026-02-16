---
summary: "Statut support Matrix, capacités et configuration"
read_when:
  - Travail sur fonctionnalités canal Matrix
title: "Matrix"
---

# Matrix (plugin)

Matrix est un protocole de messagerie ouvert et décentralisé. OpenClaw se connecte en tant qu'**utilisateur** Matrix sur n'importe quel homeserver, vous avez donc besoin d'un compte Matrix pour le bot. Une fois connecté, vous pouvez envoyer un DM directement au bot ou l'inviter dans des salles (« groupes » Matrix). Beeper est aussi une option client valide, mais nécessite que E2EE soit activé.

Statut : supporté via plugin (@vector-im/matrix-bot-sdk). Messages directs, salles, fils, médias, réactions, sondages (envoi + poll-start comme texte), emplacement et E2EE (avec support crypto).

## Plugin requis

Matrix est fourni comme plugin et n'est pas inclus avec l'installation de base.

Installation via CLI (registre npm) :

```bash
openclaw plugins install @openclaw/matrix
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/matrix
```

Si vous choisissez Matrix pendant configure/onboarding et qu'un checkout git est détecté, OpenClaw offrira automatiquement le chemin d'installation local.

Détails : [Plugins](/fr-FR/tools/plugin)

## Configuration

1. Installez le plugin Matrix :
   - Depuis npm : `openclaw plugins install @openclaw/matrix`
   - Depuis un checkout local : `openclaw plugins install ./extensions/matrix`
2. Créez un compte Matrix sur un homeserver :
   - Parcourez les options d'hébergement sur [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Ou hébergez-le vous-même.
3. Obtenez un jeton d'accès pour le compte bot :
   - Utilisez l'API de connexion Matrix avec `curl` sur votre homeserver :

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "votre-nom-utilisateur"
     },
     "password": "votre-mot-de-passe"
   }'
   ```

   - Remplacez `matrix.example.org` par l'URL de votre homeserver.
   - Ou définissez `channels.matrix.userId` + `channels.matrix.password` : OpenClaw appelle le même point de terminaison de connexion, stocke le jeton d'accès dans `~/.openclaw/credentials/matrix/credentials.json`, et le réutilise au prochain démarrage.

4. Configurez les identifiants :
   - Env : `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (ou `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Ou config : `channels.matrix.*`
   - Si les deux sont définis, la config a la priorité.
   - Avec jeton d'accès : l'ID utilisateur est récupéré automatiquement via `/whoami`.
   - Quand défini, `channels.matrix.userId` doit être l'ID Matrix complet (exemple : `@bot:example.org`).
5. Redémarrez la passerelle (ou terminez l'onboarding).
6. Démarrez un DM avec le bot ou invitez-le dans une salle depuis n'importe quel client Matrix (Element, Beeper, etc. ; voir [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper nécessite E2EE, donc définissez `channels.matrix.encryption: true` et vérifiez l'appareil.

Configuration minimale (jeton d'accès, ID utilisateur auto-récupéré) :

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

Configuration E2EE (chiffrement de bout en bout activé) :

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

Le chiffrement de bout en bout est **supporté** via le SDK crypto Rust.

Activez avec `channels.matrix.encryption: true` :

- Si le module crypto se charge, les salles chiffrées sont déchiffrées automatiquement.
- Les médias sortants sont chiffrés lors de l'envoi dans des salles chiffrées.
- À la première connexion, OpenClaw demande la vérification d'appareil depuis vos autres sessions.
- Vérifiez l'appareil dans un autre client Matrix (Element, etc.) pour activer le partage de clés.
- Si le module crypto ne peut pas être chargé, E2EE est désactivé et les salles chiffrées ne déchiffreront pas ; OpenClaw enregistre un avertissement.
- Si vous voyez des erreurs de module crypto manquant (par exemple, `@matrix-org/matrix-sdk-crypto-nodejs-*`), autorisez les scripts de build pour `@matrix-org/matrix-sdk-crypto-nodejs` et exécutez `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` ou récupérez le binaire avec `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

L'état crypto est stocké par compte + jeton d'accès dans `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/` (base de données SQLite). L'état de sync vit à côté dans `bot-storage.json`. Si le jeton d'accès (appareil) change, un nouveau magasin est créé et le bot doit être re-vérifié pour les salles chiffrées.

**Vérification d'appareil :**
Quand E2EE est activé, le bot demandera la vérification depuis vos autres sessions au démarrage. Ouvrez Element (ou un autre client) et approuvez la demande de vérification pour établir la confiance. Une fois vérifié, le bot peut déchiffrer les messages dans les salles chiffrées.

## Multi-comptes

Support multi-comptes : utilisez `channels.matrix.accounts` avec identifiants par compte et `name` optionnel. Voir [`gateway/configuration`](/fr-FR/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) pour le modèle partagé.

Chaque compte fonctionne comme un utilisateur Matrix séparé sur n'importe quel homeserver. La config par compte hérite des paramètres `channels.matrix` de niveau supérieur et peut remplacer n'importe quelle option (politique DM, groupes, chiffrement, etc.).

```json5
{
  channels: {
    matrix: {
      enabled: true,
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          name: "Assistant principal",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_***",
          encryption: true,
        },
        alerts: {
          name: "Bot d'alertes",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_***",
          dm: { policy: "allowlist", allowFrom: ["@admin:example.org"] },
        },
      },
    },
  },
}
```

Notes :

- Le démarrage des comptes est sérialisé pour éviter les conditions de concurrence avec les importations de modules concurrentes.
- Les variables d'environnement (`MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, etc.) s'appliquent uniquement au compte **par défaut**.
- Les paramètres de canal de base (politique DM, politique de groupe, mention gating, etc.) s'appliquent à tous les comptes sauf remplacement par compte.
- Utilisez `bindings[].match.accountId` pour router chaque compte vers un agent différent.
- L'état crypto est stocké par compte + jeton d'accès (magasins de clés séparés par compte).

## Modèle de routage

- Les réponses retournent toujours vers Matrix.
- Les DM partagent la session principale de l'agent ; les salles mappent à des sessions de groupe.

## Contrôle d'accès (DM)

- Par défaut : `channels.matrix.dm.policy = "pairing"`. Les expéditeurs inconnus obtiennent un code d'appairage.
- Approuver via :
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- DM publics : `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepte les IDs utilisateur Matrix complets (exemple : `@user:server`). L'assistant résout les noms d'affichage en IDs utilisateur quand la recherche d'annuaire trouve une correspondance exacte unique.
- N'utilisez pas les noms d'affichage ou localparts nus (exemple : `"Alice"` ou `"alice"`). Ils sont ambigus et sont ignorés pour la correspondance allowlist. Utilisez les IDs complets `@user:server`.

## Salles (groupes)

- Par défaut : `channels.matrix.groupPolicy = "allowlist"` (mention-gated). Utilisez `channels.defaults.groupPolicy` pour remplacer le défaut quand non défini.
- Allowlist salles avec `channels.matrix.groups` (IDs ou alias de salle ; les noms sont résolus en IDs quand la recherche d'annuaire trouve une correspondance exacte unique) :

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

- `requireMention: false` active la réponse automatique dans cette salle.
- `groups."*"` peut définir les valeurs par défaut pour mention gating à travers les salles.
- `groupAllowFrom` restreint quels expéditeurs peuvent déclencher le bot dans les salles (IDs utilisateur Matrix complets).
- Les allowlists `users` par salle peuvent restreindre davantage les expéditeurs à l'intérieur d'une salle spécifique (utilisez les IDs utilisateur Matrix complets).
- L'assistant de configuration invite pour les allowlists de salles (IDs de salle, alias ou noms) et résout les noms uniquement sur une correspondance exacte et unique.
- Au démarrage, OpenClaw résout les noms de salle/utilisateur dans les allowlists en IDs et enregistre le mappage ; les entrées non résolues sont ignorées pour la correspondance allowlist.
- Les invitations sont auto-rejointes par défaut ; contrôlez avec `channels.matrix.autoJoin` et `channels.matrix.autoJoinAllowlist`.
- Pour n'autoriser **aucune salle**, définissez `channels.matrix.groupPolicy: "disabled"` (ou gardez une allowlist vide).
- Clé legacy : `channels.matrix.rooms` (même forme que `groups`).

## Fils

- Le threading de réponse est supporté.
- `channels.matrix.threadReplies` contrôle si les réponses restent dans les fils :
  - `off`, `inbound` (par défaut), `always`
- `channels.matrix.replyToMode` contrôle les métadonnées reply-to quand on ne répond pas dans un fil :
  - `off` (par défaut), `first`, `all`

## Capacités

| Fonctionnalité    | Statut                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Messages directs  | ✅ Supporté                                                                                     |
| Salles            | ✅ Supporté                                                                                     |
| Fils              | ✅ Supporté                                                                                     |
| Médias            | ✅ Supporté                                                                                     |
| E2EE              | ✅ Supporté (module crypto requis)                                                              |
| Réactions         | ✅ Supporté (envoi/lecture via outils)                                                          |
| Sondages          | ✅ Envoi supporté ; démarrages de sondages entrants convertis en texte (réponses/fins ignorées) |
| Emplacement       | ✅ Supporté (geo URI ; altitude ignorée)                                                        |
| Commandes natives | ✅ Supporté                                                                                     |

## Dépannage

Exécutez d'abord cette échelle :

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Puis confirmez l'état d'appairage DM si nécessaire :

```bash
openclaw pairing list matrix
```

Échecs courants :

- Connecté mais messages de salle ignorés : salle bloquée par `groupPolicy` ou allowlist de salle.
- DM ignorés : expéditeur en attente d'approbation quand `channels.matrix.dm.policy="pairing"`.
- Échec des salles chiffrées : support crypto ou désaccord des paramètres de chiffrement.

Pour le flux de triage : [/fr-FR/channels/troubleshooting](/fr-FR/channels/troubleshooting).

## Référence de configuration (Matrix)

Configuration complète : [Configuration](/fr-FR/gateway/configuration)

Options du fournisseur :

- `channels.matrix.enabled`: activer/désactiver démarrage canal.
- `channels.matrix.homeserver`: URL homeserver.
- `channels.matrix.userId`: ID utilisateur Matrix (optionnel avec jeton d'accès).
- `channels.matrix.accessToken`: jeton d'accès.
- `channels.matrix.password`: mot de passe pour connexion (jeton stocké).
- `channels.matrix.deviceName`: nom d'affichage appareil.
- `channels.matrix.encryption`: activer E2EE (par défaut : false).
- `channels.matrix.initialSyncLimit`: limite sync initiale.
- `channels.matrix.threadReplies`: `off | inbound | always` (par défaut : inbound).
- `channels.matrix.textChunkLimit`: taille morceau texte sortant (caractères).
- `channels.matrix.chunkMode`: `length` (par défaut) ou `newline` pour diviser sur lignes vides (limites paragraphe) avant découpage longueur.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (par défaut : pairing).
- `channels.matrix.dm.allowFrom`: allowlist DM (IDs utilisateur Matrix complets). `open` nécessite `"*"`. L'assistant résout les noms en IDs quand possible.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (par défaut : allowlist).
- `channels.matrix.groupAllowFrom`: expéditeurs autorisés pour messages de groupe (IDs utilisateur Matrix complets).
- `channels.matrix.allowlistOnly`: forcer règles allowlist pour DM + salles.
- `channels.matrix.groups`: allowlist groupe + map paramètres par salle.
- `channels.matrix.rooms`: allowlist/config groupe legacy.
- `channels.matrix.replyToMode`: mode reply-to pour fils/tags.
- `channels.matrix.mediaMaxMb`: limite média entrant/sortant (MB).
- `channels.matrix.autoJoin`: gestion invitation (`always | allowlist | off`, par défaut : always).
- `channels.matrix.autoJoinAllowlist`: IDs/alias de salle autorisés pour auto-join.
- `channels.matrix.accounts`: configuration multi-compte indexée par ID compte (chaque compte hérite des paramètres de niveau supérieur).
- `channels.matrix.actions`: gating outil par action (reactions/messages/pins/memberInfo/channelInfo).

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
