---
summary: "Statut de prise en charge du bot Microsoft Teams, capacites et configuration"
read_when:
  - Travail sur les fonctionnalites du canal MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> « Abandonnez tout espoir, vous qui entrez ici.

Mis a jour : 2026-01-21

Statut : le texte + les pieces jointes en Message prive sont pris en charge ; l’envoi de fichiers dans les canaux/groupes requiert `sharePointSiteId` + des autorisations Graph (voir [Envoi de fichiers dans les discussions de groupe](#sending-files-in-group-chats)). Les sondages sont envoyes via des Cartes adaptatives.

## Plugin requis

Microsoft Teams est fourni sous forme de plugin et n’est pas inclus dans l’installation de base.

**Changement incompatible (2026.1.15) :** MS Teams a ete retire du core. Si vous l’utilisez, vous devez installer le plugin.

Explication : cela allege les installations du core et permet aux dependances MS Teams de se mettre a jour independamment.

Installation via la CLI (registre npm) :

```bash
openclaw plugins install @openclaw/msteams
```

Depot local (lors d’une execution depuis un depot git) :

```bash
openclaw plugins install ./extensions/msteams
```

Si vous choisissez Teams lors de la configuration/prise en main et qu’un checkout git est detecte,
OpenClaw proposera automatiquement le chemin d’installation local.

Details : [Plugins](/plugin)

## Demarrage rapide (debutant)

1. Installez le plugin Microsoft Teams.
2. Creez un **Azure Bot** (ID d’application + secret client + ID de locataire).
3. Configurez OpenClaw avec ces identifiants.
4. Exposez `/api/messages` (port 3978 par defaut) via une URL publique ou un tunnel.
5. Installez le package d’application Teams et demarrez la passerelle.

Configuration minimale :

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Remarque : les discussions de groupe sont bloquees par defaut (`channels.msteams.groupPolicy: "allowlist"`). Pour autoriser les reponses de groupe, definissez `channels.msteams.groupAllowFrom` (ou utilisez `groupPolicy: "open"` pour autoriser tout membre, avec mention requise).

## Objectifs

- Discuter avec OpenClaw via des Messages prives Teams, des discussions de groupe ou des canaux.
- Garder un routage deterministe : les reponses reviennent toujours sur le canal d’origine.
- Adopter par defaut un comportement de canal sur (mentions requises sauf configuration contraire).

## Ecritures de configuration

Par defaut, Microsoft Teams est autorise a ecrire des mises a jour de configuration declenchees par `/config set|unset` (requiert `commands.config: true`).

Desactiver avec :

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Controle d’acces (Messages prives + groupes)

**Accès DM**

- Par defaut : `channels.msteams.dmPolicy = "pairing"`. Les expediteurs inconnus sont ignores jusqu’a approbation.
- `channels.msteams.allowFrom` accepte des ID d’objet AAD, des UPN ou des noms d’affichage. L’assistant resout les noms en ID via Microsoft Graph lorsque les identifiants le permettent.

**Acces de groupe**

- Par defaut : `channels.msteams.groupPolicy = "allowlist"` (bloque sauf si vous ajoutez `groupAllowFrom`). Utilisez `channels.defaults.groupPolicy` pour remplacer le defaut lorsqu’il n’est pas defini.
- `channels.msteams.groupAllowFrom` controle quels expediteurs peuvent declencher dans les discussions de groupe/canaux (repli sur `channels.msteams.allowFrom`).
- Definissez `groupPolicy: "open"` pour autoriser tout membre (mention toujours requise par defaut).
- Pour n’autoriser **aucun canal**, definissez `channels.msteams.groupPolicy: "disabled"`.

Exemple :

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + liste d’autorisation de canaux**

- Cadrez les reponses de groupe/canal en listant les equipes et canaux sous `channels.msteams.teams`.
- Les cles peuvent etre des ID ou des noms d’equipe ; les cles de canal peuvent etre des ID de conversation ou des noms.
- Lorsque `groupPolicy="allowlist"` et qu’une liste d’autorisation d’equipes est presente, seules les equipes/canaux listes sont acceptes (mention requise).
- L’assistant de configuration accepte les entrees `Team/Channel` et les stocke pour vous.
- Au demarrage, OpenClaw resout les noms d’equipe/canal et de liste d’autorisation d’utilisateurs en ID (lorsque les autorisations Graph le permettent)
  et journalise le mappage ; les entrees non resolues sont conservees telles quelles.

Exemple :

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Fonctionnement

1. Installez le plugin Microsoft Teams.
2. Creez un **Azure Bot** (ID d’application + secret + ID de locataire).
3. Construisez un **package d’application Teams** qui reference le bot et inclut les autorisations RSC ci-dessous.
4. Televersez/installez l’application Teams dans une equipe (ou en perimetre personnel pour les Messages prives).
5. Configurez `msteams` dans `~/.openclaw/openclaw.json` (ou via des variables d’environnement) et demarrez la passerelle.
6. La passerelle ecoute le trafic webhook Bot Framework sur `/api/messages` par defaut.

## Configuration Azure Bot (Prerequis)

Avant de configurer OpenClaw, vous devez creer une ressource Azure Bot.

### Etape 1 : Creer Azure Bot

1. Allez sur [Creer Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Remplissez l'onglet **Basics** :

   | Champ              | Valeur                                                                                                             |
   | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
   | **Bot handle**     | Nom de votre bot, p. ex., `openclaw-msteams` (doit etre unique) |
   | **Subscription**   | Selectionnez votre abonnement Azure                                                                                |
   | **Resource group** | Creez-en un nouveau ou utilisez l’existant                                                                         |
   | **Pricing tier**   | **Free** pour dev/test                                                                                             |
   | **Type of App**    | **Single Tenant** (recommande – voir note ci-dessous)                                           |
   | **Creation type**  | **Create new Microsoft App ID**                                                                                    |

> **Avis de deprecation :** la creation de nouveaux bots multi-locataires a ete depreciee apres le 2025-07-31. Utilisez **Single Tenant** pour les nouveaux bots.

3. Cliquez sur **Review + create** → **Create** (attendez ~1–2 minutes)

### Etape 2 : Obtenir les identifiants

1. Allez sur votre ressource Azure Bot → **Configuration**
2. Copiez **Microsoft App ID** → c’est votre `appId`
3. Cliquez sur **Manage Password** → allez sur l’Inscription d’application
4. Sous **Certificates & secrets** → **New client secret** → copiez la **Value** → c’est votre `appPassword`
5. Allez sur **Overview** → copiez **Directory (tenant) ID** → c’est votre `tenantId`

### Etape 3 : Configurer le point de terminaison de messagerie

1. Dans Azure Bot → **Configuration**
2. Definissez **Messaging endpoint** sur l’URL de votre webhook :
   - Production : `https://your-domain.com/api/messages`
   - Dev local : utilisez un tunnel (voir [Developpement local](#local-development-tunneling) ci-dessous)

### Etape 4 : Activer le canal Teams

1. Dans Azure Bot → **Channels**
2. Cliquez sur **Microsoft Teams** → Configurer → Enregistrer
3. Acceptez les Conditions d’utilisation

## Developpement local (Tunneling)

Teams ne peut pas atteindre `localhost`. Utilisez un tunnel pour le developpement local :

**Option A : ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Option B : Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Portail Developpeur Teams (Alternative)

Au lieu de creer manuellement un ZIP de manifeste, vous pouvez utiliser le [Portail Developpeur Teams](https://dev.teams.microsoft.com/apps) :

1. Cliquez sur **+ New app**
2. Renseignez les informations de base (nom, description, informations developpeur)
3. Allez sur **App features** → **Bot**
4. Selectionnez **Enter a bot ID manually** et collez l’ID d’application Azure Bot
5. Cochez les perimetres : **Personal**, **Team**, **Group Chat**
6. Cliquez sur **Distribute** → **Download app package**
7. Dans Teams : **Apps** → **Manage your apps** → **Upload a custom app** → selectionnez le ZIP

C’est souvent plus simple que l’edition manuelle de manifestes JSON.

## Tester le bot

**Option A : Azure Web Chat (verifier d’abord le webhook)**

1. Dans le Portail Azure → votre ressource Azure Bot → **Test in Web Chat**
2. Envoyez un message – vous devriez voir une reponse
3. Cela confirme que votre point de terminaison webhook fonctionne avant la configuration Teams

**Option B : Teams (apres installation de l’app)**

1. Installez l’application Teams (sideload ou catalogue d’organisation)
2. Trouvez le bot dans Teams et envoyez un Message prive
3. Verifiez les journaux de la passerelle pour l’activite entrante

## Configuration (texte uniquement, minimale)

1. **Installer le plugin Microsoft Teams**
   - Depuis npm : `openclaw plugins install @openclaw/msteams`
   - Depuis un depot local : `openclaw plugins install ./extensions/msteams`

2. **Enregistrement du bot**
   - Creez un Azure Bot (voir ci-dessus) et notez :
     - ID d’application
     - Secret client (mot de passe de l’application)
     - ID de locataire (single-tenant)

3. **Manifeste de l’application Teams**
   - Inclure une entree `bot` avec `botId = <App ID>`.
   - Perimetres : `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (requis pour la gestion des fichiers en perimetre personnel).
   - Ajouter les autorisations RSC (ci-dessous).
   - Creer des icones : `outline.png` (32x32) et `color.png` (192x192).
   - Zipper les trois fichiers ensemble : `manifest.json`, `outline.png`, `color.png`.

4. **Configurer OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Vous pouvez aussi utiliser des variables d’environnement a la place des cles de configuration :

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Point de terminaison du bot**
   - Definissez le Messaging Endpoint Azure Bot sur :
     - `https://<host>:3978/api/messages` (ou le chemin/port de votre choix).

6. **Lancer la passerelle**
   - Le canal Teams demarre automatiquement lorsque le plugin est installe et que la configuration `msteams` existe avec des identifiants.

## Contexte d’historique

- `channels.msteams.historyLimit` controle le nombre de messages recents de canal/groupe inclus dans l’invite.
- Repli sur `messages.groupChat.historyLimit`. Definissez `0` pour desactiver (50 par defaut).
- L’historique des Messages prives peut etre limite avec `channels.msteams.dmHistoryLimit` (tours utilisateur). Remplacements par utilisateur : `channels.msteams.dms["<user_id>"].historyLimit`.

## Autorisations RSC Teams actuelles (Manifeste)

Voici les **autorisations resourceSpecific existantes** dans notre manifeste d’application Teams. Elles s’appliquent uniquement a l’equipe/discussion ou l’app est installee.

**Pour les canaux (perimetre equipe) :**

- `ChannelMessage.Read.Group` (Application) – recevoir tous les messages de canal sans @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Pour les discussions de groupe :**

- `ChatMessage.Read.Chat` (Application) – recevoir tous les messages de discussion de groupe sans @mention

## Exemple de manifeste Teams (expurge)

Exemple minimal et valide avec les champs requis. Remplacez les ID et URL.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Points d’attention du manifeste (champs indispensables)

- `bots[].botId` **doit** correspondre a l’ID d’application Azure Bot.
- `webApplicationInfo.id` **doit** correspondre a l’ID d’application Azure Bot.
- `bots[].scopes` doit inclure les surfaces que vous prevoyez d’utiliser (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` est requis pour la gestion des fichiers en perimetre personnel.
- `authorization.permissions.resourceSpecific` doit inclure la lecture/envoi de canal si vous voulez du trafic de canal.

### Mettre a jour une application existante

Pour mettre a jour une application Teams deja installee (p. ex., pour ajouter des autorisations RSC) :

1. Mettez a jour votre `manifest.json` avec les nouveaux parametres
2. **Incrementez le champ `version`** (p. ex., `1.0.0` → `1.1.0`)
3. **Re-zippez** le manifeste avec les icones (`manifest.json`, `outline.png`, `color.png`)
4. Televersez le nouveau zip :
   - **Option A (Centre d’administration Teams) :** Teams Admin Center → Teams apps → Manage apps → trouvez votre app → Upload new version
   - **Option B (Sideload) :** Dans Teams → Apps → Manage your apps → Upload a custom app
5. **Pour les canaux d’equipe :** Reinstallez l’app dans chaque equipe pour que les nouvelles autorisations prennent effet
6. **Quittez completement et relancez Teams** (pas seulement fermer la fenetre) pour vider les metadonnees d’app en cache

## Capacites : RSC uniquement vs Graph

### Avec **Teams RSC uniquement** (app installee, sans autorisations Graph API)

Fonctionne :

- Lire le contenu **texte** des messages de canal.
- Envoyer du **texte** dans les canaux.
- Recevoir des pieces jointes **personnelles (Message prive)**.

Ne fonctionne pas :

- **Images ou contenus de fichiers** de canal/groupe (la charge utile n’inclut qu’un stub HTML).
- Telechargement de pieces jointes stockees dans SharePoint/OneDrive.
- Lecture de l’historique des messages (au-dela de l’evenement webhook en direct).

### Avec **Teams RSC + autorisations d’application Microsoft Graph**

Ajoute :

- Telechargement de contenus heberges (images collees dans les messages).
- Telechargement de pieces jointes stockees dans SharePoint/OneDrive.
- Lecture de l’historique des messages de canal/discussion via Graph.

### RSC vs Graph API

| Capacite                        | Autorisations RSC                     | Graph API                                        |
| ------------------------------- | ------------------------------------- | ------------------------------------------------ |
| **Messages temps reel**         | Oui (via webhook)  | Non (sondage uniquement)      |
| **Messages historiques**        | Non                                   | Oui (requete de l’historique) |
| **Complexite de mise en place** | Manifeste d’app uniquement            | Requiert consentement admin + flux de jeton      |
| **Fonctionne hors ligne**       | Non (doit tourner) | Oui (requete a tout moment)   |

**Conclusion :** RSC sert a l’ecoute temps reel ; Graph API sert a l’acces historique. Pour rattraper des messages manques hors ligne, vous avez besoin de Graph API avec `ChannelMessage.Read.All` (requiert un consentement admin).

## Medias + historique actives par Graph (requis pour les canaux)

Si vous avez besoin d’images/fichiers dans les **canaux** ou de recuperer l’**historique des messages**, vous devez activer les autorisations Microsoft Graph et accorder le consentement admin.

1. Dans Entra ID (Azure AD) **App Registration**, ajoutez des **autorisations d’application** Microsoft Graph :
   - `ChannelMessage.Read.All` (pieces jointes de canal + historique)
   - `Chat.Read.All` ou `ChatMessage.Read.All` (discussions de groupe)
2. **Accordez le consentement admin** pour le locataire.
3. Incrementez la **version du manifeste** de l’app Teams, re-televersez et **reinstallez l’app dans Teams**.
4. **Quittez completement et relancez Teams** pour vider les metadonnees d’app en cache.

## Limitations connues

### Delais d’expiration des webhooks

Teams livre les messages via webhook HTTP. Si le traitement prend trop de temps (p. ex., reponses LLM lentes), vous pouvez observer :

- Délai d'attente de la passerelle
- Des tentatives de re-livraison par Teams (causant des doublons)
- Des reponses perdues

OpenClaw gère cela en retournant rapidement et en envoyant des réponses proactivement, mais des réponses très lentes peuvent quand même causer des problèmes.

### Mise en forme

Le markdown Teams est plus limite que Slack ou Discord :

- La mise en forme de base fonctionne : **gras**, _italique_, `code`, liens
- Le markdown complexe (tableaux, listes imbriquees) peut mal s’afficher
- Les Cartes adaptatives sont prises en charge pour les sondages et les envois arbitraires (voir ci-dessous)

## Configuration

Parametres cles (voir `/gateway/configuration` pour les schemas de canaux partages) :

- `channels.msteams.enabled` : activer/desactiver le canal.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId` : identifiants du bot.
- `channels.msteams.webhook.port` (par defaut `3978`)
- `channels.msteams.webhook.path` (par defaut `/api/messages`)
- `channels.msteams.dmPolicy` : `pairing | allowlist | open | disabled` (par defaut : appairage)
- `channels.msteams.allowFrom` : liste d’autorisation pour les Messages prives (ID d’objet AAD, UPN ou noms d’affichage). L’assistant resout les noms en ID lors de la configuration quand l’acces Graph est disponible.
- `channels.msteams.textChunkLimit` : taille des segments de texte sortant.
- `channels.msteams.chunkMode` : `length` (par defaut) ou `newline` pour decouper sur les lignes vides (limites de paragraphes) avant le decoupage par longueur.
- `channels.msteams.mediaAllowHosts` : liste d’autorisation des hotes de pieces jointes entrantes (par defaut domaines Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts` : liste d’autorisation pour joindre des en-tetes Authorization lors des reprises media (par defaut hotes Graph + Bot Framework).
- `channels.msteams.requireMention` : exiger @mention dans les canaux/groupes (par defaut true).
- `channels.msteams.replyStyle` : `thread | top-level` (voir [Style de reponse](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle` : remplacement par equipe.
- `channels.msteams.teams.<teamId>.requireMention` : remplacement par equipe.
- `channels.msteams.teams.<teamId>.tools` : remplacements de politique d’outils par defaut par equipe (`allow`/`deny`/`alsoAllow`) utilises lorsqu’un remplacement de canal est manquant.
- `channels.msteams.teams.<teamId>.toolsBySender` : remplacements de politique d’outils par defaut par equipe et par expediteur (`"*"` joker pris en charge).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle` : remplacement par canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention` : remplacement par canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools` : remplacements de politique d’outils par canal (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender` : remplacements de politique d’outils par canal et par expediteur (`"*"` joker pris en charge).
- `channels.msteams.sharePointSiteId` : ID de site SharePoint pour les televersements de fichiers dans les discussions de groupe/canaux (voir [Envoi de fichiers dans les discussions de groupe](#sending-files-in-group-chats)).

## Routage & Sessions

- Les cles de session suivent le format standard d’agent (voir [/concepts/session](/concepts/session)) :
  - Les Messages prives partagent la session principale (`agent:<agentId>:<mainKey>`).
  - Les messages de canal/groupe utilisent l’ID de conversation :
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Style de reponse : Fils vs Publications

Teams a recemment introduit deux styles d’interface de canal au-dessus du meme modele de donnees sous-jacent :

| Style                                           | Description                                                                 | `replyStyle` recommande                  |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| **Publications** (classique) | Les messages apparaissent comme des cartes avec des reponses en fil dessous | `thread` (par defaut) |
| **Fils** (type Slack)        | Les messages s’enchainent lineairement, comme Slack                         | `top-level`                              |

**Le probleme :** l’API Teams n’expose pas le style d’interface utilise par un canal. Si vous utilisez le mauvais `replyStyle` :

- `thread` dans un canal de type Fils → les reponses apparaissent imbriquees de facon maladroite
- `top-level` dans un canal de type Publications → les reponses apparaissent comme des publications de premier niveau separees au lieu d’etre en fil

**Solution :** configurez `replyStyle` par canal selon la configuration du canal :

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Pieces jointes & Images

**Limitations actuelles :**

- **Messages prives :** les images et pieces jointes fonctionnent via les API de fichiers des bots Teams.
- **Canaux/groupes :** les pieces jointes vivent dans le stockage M365 (SharePoint/OneDrive). La charge utile du webhook n’inclut qu’un stub HTML, pas les octets du fichier. **Des autorisations Graph API sont requises** pour telecharger les pieces jointes de canal.

Sans autorisations Graph, les messages de canal avec images seront recus en texte seul (le contenu de l’image n’est pas accessible au bot).
Par defaut, OpenClaw ne telecharge les medias que depuis des noms d’hote Microsoft/Teams. Remplacez avec `channels.msteams.mediaAllowHosts` (utilisez `["*"]` pour autoriser n’importe quel hote).
Les en-tetes Authorization ne sont joints que pour les hotes dans `channels.msteams.mediaAuthAllowHosts` (par defaut hotes Graph + Bot Framework). Gardez cette liste stricte (evitez les suffixes multi-locataires).

## Envoi de fichiers dans les discussions de groupe

Les bots peuvent envoyer des fichiers en Messages prives via le flux FileConsentCard (integre). Cependant, **l’envoi de fichiers dans les discussions de groupe/canaux** requiert une configuration supplementaire :

| Contexte                                      | Methode d’envoi des fichiers                               | Configuration requise                             |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| **Messages prives**                           | FileConsentCard → l’utilisateur accepte → le bot televerse | Fonctionne hors de la boîte                       |
| **Discussions de groupe/canaux**              | Televersement vers SharePoint → lien de partage            | Requiert `sharePointSiteId` + autorisations Graph |
| **Images (tout contexte)** | Inline encode en Base64                                    | Fonctionne hors de la boîte                       |

### Pourquoi les discussions de groupe necessitent SharePoint

Les bots n’ont pas de lecteur OneDrive personnel (le point de terminaison Graph `/me/drive` ne fonctionne pas pour les identites d’application). Pour envoyer des fichiers dans les discussions de groupe/canaux, le bot televerse vers un **site SharePoint** et cree un lien de partage.

### Configuration

1. **Ajouter des autorisations Graph API** dans Entra ID (Azure AD) → App Registration :
   - `Sites.ReadWrite.All` (Application) – televerser des fichiers vers SharePoint
   - `Chat.Read.All` (Application) – optionnel, active les liens de partage par utilisateur

2. **Accorder le consentement admin** pour le locataire.

3. **Obtenir l’ID de votre site SharePoint :**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configurer OpenClaw :**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Comportement de partage

| Autorisation                            | Comportement de partage                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` uniquement        | Lien de partage a l’echelle de l’organisation (tout membre de l’org peut acceder)    |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Lien de partage par utilisateur (seuls les membres de la discussion peuvent acceder) |

Le partage par utilisateur est plus securise, car seuls les participants de la discussion peuvent acceder au fichier. Si l’autorisation `Chat.Read.All` est absente, le bot se rabat sur un partage a l’echelle de l’organisation.

### Comportement de repli

| Scenario                                                      | Resultat                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Discussion de groupe + fichier + `sharePointSiteId` configure | Televersement vers SharePoint, envoi du lien                                            |
| Discussion de groupe + fichier + pas de `sharePointSiteId`    | Tentative de televersement OneDrive (peut echouer), envoi texte seul |
| Discussion personnelle + fichier                              | Flux FileConsentCard (fonctionne sans SharePoint)                    |
| Tout contexte + image                                         | Inline encode en Base64 (fonctionne sans SharePoint)                 |

### Emplacement de stockage des fichiers

Les fichiers televerses sont stockes dans un dossier `/OpenClawShared/` de la bibliotheque de documents par defaut du site SharePoint configure.

## Sondages (Cartes adaptatives)

OpenClaw envoie les sondages Teams sous forme de Cartes adaptatives (il n’existe pas d’API de sondage Teams native).

- CLI : `openclaw message poll --channel msteams --target conversation:<id> ...`
- Les votes sont enregistres par la passerelle dans `~/.openclaw/msteams-polls.json`.
- La passerelle doit rester en ligne pour enregistrer les votes.
- Les sondages ne publient pas encore automatiquement des resumes de resultats (inspectez le fichier de stockage si necessaire).

## Cartes adaptatives (arbitraires)

Envoyez n’importe quel JSON de Carte adaptative a des utilisateurs ou conversations Teams a l’aide de l’outil `message` ou de la CLI.

Le parametre `card` accepte un objet JSON de Carte adaptative. Lorsque `card` est fourni, le texte du message est optionnel.

**Outil d’agent :**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI :**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Voir la [documentation des Cartes adaptatives](https://adaptivecards.io/) pour le schema et des exemples. Pour les details de format cible, voir [Formats cibles](#target-formats) ci-dessous.

## Formats cibles

Les cibles MSTeams utilisent des prefixes pour distinguer les utilisateurs et les conversations :

| Type de cible                            | Format                           | Exemple                                                                |
| ---------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Utilisateur (par ID)  | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                            |
| Utilisateur (par nom) | `user:<display-name>`            | `user:John Smith` (requiert Graph API)              |
| Groupe/canal                             | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                               |
| Groupe/canal (brut)   | `<conversation-id>`              | `19:abc123...@thread.tacv2` (si contient `@thread`) |

**Exemples CLI :**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Exemples d’outil d’agent :**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Remarque : sans le prefixe `user:`, les noms sont resolus par defaut comme groupe/equipe. Utilisez toujours `user:` lorsque vous ciblez des personnes par nom d’affichage.

## Messagerie proactive

- Les messages proactifs ne sont possibles **qu’apres** qu’un utilisateur a interagi, car nous stockons alors les references de conversation.
- Voir `/gateway/configuration` pour `dmPolicy` et le filtrage par liste d’autorisation.

## ID d’equipe et de canal (piege courant)

Le parametre de requete `groupId` dans les URL Teams **N’EST PAS** l’ID d’equipe utilise pour la configuration. Extrayez les ID depuis le chemin de l’URL :

**URL d’equipe :**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL de canal :**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Pour la configuration :**

- ID d’equipe = segment du chemin apres `/team/` (URL-decode, p. ex., `19:Bk4j...@thread.tacv2`)
- ID de canal = segment du chemin apres `/channel/` (URL-decode)
- **Ignorez** le parametre de requete `groupId`

## Canaux prives

Les bots ont une prise en charge limitee dans les canaux prives :

| Fonctionnalite                                   | Canaux standards | Canaux prives                               |
| ------------------------------------------------ | ---------------- | ------------------------------------------- |
| Installation du bot                              | Oui              | Limitee                                     |
| Messages temps reel (webhook) | Oui              | Peut ne pas fonctionner                     |
| Autorisations RSC                                | Oui              | Peut se comporter differemment              |
| @mentions                           | Oui              | Si le bot est accessible                    |
| Historique Graph API                             | Oui              | Oui (avec autorisations) |

**Contournements si les canaux prives ne fonctionnent pas :**

1. Utilisez des canaux standards pour les interactions avec le bot
2. Utilisez les Messages prives – les utilisateurs peuvent toujours contacter le bot directement
3. Utilisez Graph API pour l’acces historique (requiert `ChannelMessage.Read.All`)

## Problemes courants

### Problemes courants

- **Images absentes dans les canaux :** autorisations Graph ou consentement admin manquants. Reinstallez l’app Teams et quittez/reouvrez completement Teams.
- **Aucune reponse dans le canal :** les mentions sont requises par defaut ; definissez `channels.msteams.requireMention=false` ou configurez par equipe/canal.
- **Incoherence de version (Teams affiche encore l’ancien manifeste) :** supprimez puis re-ajoutez l’app et quittez completement Teams pour rafraichir.
- **401 Unauthorized depuis le webhook :** attendu lors de tests manuels sans JWT Azure – signifie que le point de terminaison est accessible mais que l’authentification a echoue. Utilisez Azure Web Chat pour tester correctement.

### Erreurs de televersement du manifeste

- **« Icon file cannot be empty » :** le manifeste reference des fichiers d’icones de 0 octet. Creez des icones PNG valides (32x32 pour `outline.png`, 192x192 pour `color.png`).
- **« webApplicationInfo.Id already in use » :** l’app est encore installee dans une autre equipe/discussion. Trouvez-la et desinstallez-la d’abord, ou attendez 5–10 minutes pour la propagation.
- **« Something went wrong » lors du televersement :** televersez via https://admin.teams.microsoft.com a la place, ouvrez les DevTools du navigateur (F12) → onglet Network, et verifiez le corps de reponse pour l’erreur reelle.
- **Echec du sideload :** essayez « Upload an app to your org’s app catalog » au lieu de « Upload a custom app » – cela contourne souvent les restrictions de sideload.

### Autorisations RSC qui ne fonctionnent pas

1. Verifiez que `webApplicationInfo.id` correspond exactement a l’ID d’application de votre bot
2. Re-televersez l’app et reinstallez-la dans l’equipe/discussion
3. Verifiez si votre administrateur d’organisation a bloque les autorisations RSC
4. Confirmez le bon perimetre : `ChannelMessage.Read.Group` pour les equipes, `ChatMessage.Read.Chat` pour les discussions de groupe

## References

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) – Guide de configuration Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) – creer/gerer des apps Teams
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (canal/groupe requiert Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
