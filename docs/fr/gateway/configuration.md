---
summary: "Toutes les options de configuration pour ~/.openclaw/openclaw.json avec des exemples"
read_when:
  - Ajout ou modification de champs de configuration
title: "Configuration"
---

# Configuration 🔧

OpenClaw lit une configuration **JSON5** optionnelle depuis `~/.openclaw/openclaw.json` (commentaires + virgules finales autorisés).

Si le fichier est absent, OpenClaw utilise des valeurs par défaut relativement sûres (agent Pi intégré + sessions par expéditeur + espace de travail `~/.openclaw/workspace`). En général, vous n’avez besoin d’une configuration que pour :

- restreindre qui peut déclencher le bot (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, etc.)
- contrôler les listes d’autorisation de groupes + le comportement des mentions (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- personnaliser les préfixes de messages (`messages`)
- définir l’espace de travail de l’agent (`agents.defaults.workspace` ou `agents.list[].workspace`)
- ajuster les paramètres par défaut de l’agent intégré (`agents.defaults`) et le comportement des sessions (`session`)
- définir l’identité par agent (`agents.list[].identity`)

> **Nouveau dans la configuration ?** Consultez le guide [Configuration Examples](/gateway/configuration-examples) pour des exemples complets avec des explications détaillées !

## Validation stricte de la configuration

OpenClaw n’accepte que les configurations qui correspondent entièrement au schéma.
Les clés inconnues, les types mal formés ou les valeurs invalides amènent la Gateway (passerelle) à **refuser de démarrer** par mesure de sécurité.

En cas d’échec de la validation :

- La Gateway ne démarre pas.
- Seules les commandes de diagnostic sont autorisées (par exemple : `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Exécutez `openclaw doctor` pour voir les problèmes exacts.
- Exécutez `openclaw doctor --fix` (ou `--yes`) pour appliquer les migrations/réparations.

Doctor n’écrit jamais de modifications sauf si vous optez explicitement pour `--fix`/`--yes`.

## Schéma + indications UI

La Gateway expose une représentation JSON Schema de la configuration via `config.schema` pour les éditeurs d’interface.
L’interface de contrôle génère un formulaire à partir de ce schéma, avec un éditeur **Raw JSON** comme échappatoire.

Les plugins et extensions de canaux peuvent enregistrer un schéma + des indications UI pour leur configuration, afin que les paramètres de canaux restent pilotés par schéma dans toutes les applications sans formulaires codés en dur.

Les indications (libellés, regroupements, champs sensibles) accompagnent le schéma afin que les clients puissent rendre de meilleurs formulaires sans connaissance codée en dur de la configuration.

## Appliquer + redémarrer (RPC)

Utilisez `config.apply` pour valider + écrire la configuration complète et redémarrer la Gateway en une seule étape.
Cela écrit un marqueur de redémarrage et ping la dernière session active après le redémarrage de la Gateway.

Avertissement : `config.apply` remplace **l’intégralité de la configuration**. Si vous souhaitez ne modifier que quelques clés,
utilisez `config.patch` ou `openclaw config set`. Conservez une sauvegarde de `~/.openclaw/openclaw.json`.

Parametres :

- `raw` (string) — charge utile JSON5 pour la configuration complète
- `baseHash` (optionnel) — hachage de configuration provenant de `config.get` (requis lorsqu’une configuration existe déjà)
- `sessionKey` (optionnel) — clé de la dernière session active pour le ping de réveil
- `note` (optionnel) — note à inclure dans le marqueur de redémarrage
- `restartDelayMs` (optionnel) — délai avant redémarrage (par défaut 2000)

Exemple (via `gateway call`) :

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Mises à jour partielles (RPC)

Utilisez `config.patch` pour fusionner une mise à jour partielle dans la configuration existante sans écraser
les clés non liées. Cela applique la sémantique de _JSON merge patch_ :

- les objets fusionnent récursivement
- `null` supprime une clé
- les tableaux sont remplacés  
  Comme `config.apply`, la configuration est validée, écrite, un marqueur de redémarrage est stocké, puis le redémarrage de la Gateway est planifié (avec un réveil optionnel lorsque `sessionKey` est fourni).

Parametres :

- `raw` (string) — charge utile JSON5 contenant uniquement les clés à modifier
- `baseHash` (requis) — hachage de configuration provenant de `config.get`
- `sessionKey` (optionnel) — clé de la dernière session active pour le ping de réveil
- `note` (optionnel) — note à inclure dans le marqueur de redémarrage
- `restartDelayMs` (optionnel) — délai avant redémarrage (par défaut 2000)

Exemple :

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Configuration minimale (point de départ recommandé)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Construisez l’image par défaut une seule fois avec :

```bash
scripts/sandbox-setup.sh
```

## Mode auto-discussion (recommandé pour le contrôle des groupes)

Pour empêcher le bot de répondre aux @-mentions WhatsApp dans les groupes (répondre uniquement à des déclencheurs textuels spécifiques) :

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Inclusions de configuration (`$include`)

Scindez votre configuration en plusieurs fichiers à l’aide de la directive `$include`. Ceci est utile pour :

- organiser de grandes configurations (p. ex. définitions d’agents par client)
- partager des paramètres communs entre environnements
- conserver les configurations sensibles séparément

### Utilisation de base

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### Comportement de fusion

- **Fichier unique** : remplace l’objet contenant `$include`
- **Tableau de fichiers** : fusion profonde des fichiers dans l’ordre (les fichiers ultérieurs remplacent les précédents)
- **Avec clés sœurs** : les clés sœurs sont fusionnées après les inclusions (elles remplacent les valeurs incluses)
- **Clés sœurs + tableaux/primitifs** : non pris en charge (le contenu inclus doit être un objet)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Inclusions imbriquées

Les fichiers inclus peuvent eux-mêmes contenir des directives `$include` (jusqu’à 10 niveaux de profondeur) :

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Résolution des chemins

- **Chemins relatifs** : résolus par rapport au fichier incluant
- **Chemins absolus** : Utilisé tel quel
- **Répertoires parents** : les références `../` fonctionnent comme attendu

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Gestion des erreurs

- **Fichier manquant** : erreur claire avec le chemin résolu
- **Erreur d’analyse** : indique quel fichier inclus a échoué
- **Inclusions circulaires** : détectées et signalées avec la chaîne d’inclusion

### Exemple : configuration légale multi‑clients

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## Options courantes

### Env vars + `.env`

OpenClaw lit les variables d’environnement depuis le processus parent (shell, launchd/systemd, CI, etc.).

De plus, il charge :

- `.env` depuis le répertoire de travail courant (s’il existe)
- un repli global `.env` depuis `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env`)

Aucun fichier `.env` ne remplace des variables d’environnement existantes.

Vous pouvez également fournir des variables d’environnement en ligne dans la configuration. Elles ne sont appliquées que si
la variable est absente de l’environnement du processus (même règle de non‑remplacement) :

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

Voir [/environment](/environment) pour la priorité complète et les sources.

### `env.shellEnv` (optionnel)

Option de confort : si activée et qu’aucune des clés attendues n’est encore définie, OpenClaw exécute votre shell de connexion et importe uniquement les clés attendues manquantes (ne remplace jamais).
Cela revient à sourcer votre profil de shell.

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var équivalent:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Substitution de variables d’environnement dans la configuration

Vous pouvez référencer des variables d’environnement directement dans toute valeur de chaîne de la configuration en utilisant la syntaxe `${VAR_NAME}`. Les variables sont substituées au chargement de la configuration, avant validation.

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**Règles :**

- Seuls les noms de variables en majuscules sont reconnus : `[A-Z_][A-Z0-9_]*`
- Il manque ou vide env vars lancer une erreur au chargement de la configuration
- Échappez avec `$${VAR}` pour produire un `${VAR}` littéral
- Fonctionne avec `$include` (les fichiers inclus bénéficient aussi de la substitution)

**Substitution en ligne :**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

### Stockage d’authentification (OAuth + clés API)

OpenClaw stocke des profils d’authentification **par agent** (OAuth + clés API) dans :

- `<agentDir>/auth-profiles.json` (par défaut : `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

Voir aussi : [/concepts/oauth](/concepts/oauth)

Imports OAuth hérités :

- `~/.openclaw/credentials/oauth.json` (ou `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

L’agent Pi intégré maintient un cache d’exécution à :

- `<agentDir>/auth.json` (géré automatiquement ; ne pas modifier manuellement)

Répertoire d’agent hérité (avant le multi‑agent) :

- `~/.openclaw/agent/*` (migré par `openclaw doctor` vers `~/.openclaw/agents/<defaultAgentId>/agent/*`)

Remplacements :

- Répertoire OAuth (import hérité uniquement) : `OPENCLAW_OAUTH_DIR`
- Répertoire d’agent (remplacement de la racine par défaut) : `OPENCLAW_AGENT_DIR` (préféré), `PI_CODING_AGENT_DIR` (hérité)

Lors de la première utilisation, OpenClaw importe les entrées `oauth.json` dans `auth-profiles.json`.

### `auth`

Métadonnées optionnelles pour les profils d’authentification. Cela **ne** stocke **pas** de secrets ; cela mappe
les identifiants de profil vers un fournisseur + un mode (et un e‑mail optionnel) et définit l’ordre de rotation des fournisseurs utilisé pour le basculement.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

Identité par agent optionnelle utilisée pour les valeurs par défaut et l’UX. Elle est écrite par l’assistant de prise en main macOS.

Si définie, OpenClaw dérive des valeurs par défaut (uniquement si vous ne les avez pas définies explicitement) :

- `messages.ackReaction` depuis l’`identity.emoji` de l’agent **actif** (repli sur 👀)
- `agents.list[].groupChat.mentionPatterns` depuis l’`identity.name`/`identity.emoji` de l’agent (ainsi « @Samantha » fonctionne dans les groupes sur Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` accepte un chemin d’image relatif à l’espace de travail ou une URL distante/URL de données. Les fichiers locaux doivent se trouver dans l’espace de travail de l’agent.

`identity.avatar` accepte :

- un chemin relatif à l’espace de travail (doit rester dans l’espace de travail de l’agent)
- une URL `http(s)`
- un URI `data:`

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

Métadonnées écrites par les assistants CLI (`onboard`, `configure`, `doctor`).

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `journalisation`

- Fichier journal par défaut: `/tmp/openclaw/openclaw-YYYYY-MM-DD.log`
- Si vous voulez un chemin stable, définissez `logging.file` à `/tmp/openclaw/openclaw.log`.
- La sortie de la console peut être réglée séparément via :
  - `logging.consoleLevel` (par défaut, `info`, bumps à `debug` quand `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Les résumés des outils peuvent être reproduits pour éviter les fuites de secrets :
  - `logging.redactSensitive` (`off` | `tools`, default: `tools`)
  - `logging.redactPatterns` (tableau de chaînes regex ; remplace les valeurs par défaut)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw. og",
    ConsoleLevel: "info",
    ConsoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Exemple: remplacer les valeurs par défaut par vos propres règles.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']? ([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

Contrôle la gestion des discussions directes sur WhatsApp (DMs) :

- `"appairage"` (par défaut): les expéditeurs inconnus obtiennent un code d'appairage ; le propriétaire doit approuver
- `"allowlist"`: n'autoriser que les expéditeurs dans `channels.whatsapp.allowFrom` (ou le magasin autorisé par apparition)
- `"open"`: autorise toutes les DMs entrantes (**requires** `channels.whatsapp.allowFrom` à inclure `"*"`)
- `"désactivé"`: ignorer tous les MP entrants

Les codes d'appairage expirent après 1 heure ; le bot n'envoie un code d'appairage que lorsqu'une nouvelle requête est créée. Les requêtes d'appairage de DM en attente sont plafonnées à **3 par canal** par défaut.

Approbations d'appairage :

- `liste d'appairage openclaw whatsapp`
- `L'appairage openclaw approuve whatsapp <code>`

### `channels.whatsapp.allowFrom`

Liste des numéros de téléphone E.164 qui peuvent déclencher les réponses automatiques WhatsApp (**MP seulement**).
Si vide et `channels.whatsapp.dmPolicy="appairage"`, les expéditeurs inconnus recevront un code d'appairage.
Pour les groupes, utilisez `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "appairage", // appairage | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // taille de chunk sortant optionnelle (caractères)
      chunkMode : "length", // mode de chunking optionnel (longueur | newline)
      mediaMaxMb: 50, // capuche média entrante en option (MB)
    },
  },
}
```

### `channels.whatsapp.sendReadReadReceipts`

Contrôle si les messages WhatsApp entrants sont marqués comme lus (tickets bleus). Par défaut: `true`.

Le mode auto-chat saute toujours les reçus de lecture, même lorsqu'il est activé.

Surcharge par compte : `channels.whatsapp.accounts.<id>.sendReadReadReceipts`.

```json5
{
  canaux: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (multi-compte)

Exécutez plusieurs comptes WhatsApp dans une seule passerelle :

```json5
{
  channels: {
    whatsapp: {
      accouns: {
        default: {}, // optionnelle; garde l'id stable par défaut
        personal: {},
        biz: {
          // Substitution facultative. Par défaut: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/. penclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

Notes :

- Les commandes sortantes sont par défaut le compte `default` si elles sont présentes; sinon le premier identifiant de compte configuré (trié).
- L'ancien dossier d'authentification unique Baileys est migré par `openclaw doctor` vers `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Exécutez plusieurs comptes par canal (chaque compte a son propre `accountId` et optionnel `name`) :

```json5
{
  channels: {
    telegram: {
      accouns: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC... ,
        },
        alertes: {
          nom: "Alertes bot",
          botToken: "987654:XYZ. .",
        },
      },
    },
  },
}
```

Remarques :

- `default` est utilisé lorsque `accountId` est omis (CLI + routing).
- Les jetons d'Env ne s'appliquent qu'au compte **default**.
- Paramètres du canal de base (politique de groupe, portail de mention etc.) s'appliquent à tous les comptes sauf si surchargé par compte.
- Utilisez `bindings[].match.accountId` pour acheminer chaque compte vers un agents.defaults.

### Clôture de mention de groupe (`agents.list[].groupChat` + `messages.groupChat`)

Les messages de groupe sont par défaut **require mention** (soit la mention des métadonnées ou les schémas de regex ). S'applique aux discussions de groupe WhatsApp, Telegram, Discord, Google Chat et iMessage.

**Types de mentions :**

- **Mentions de métadonnées** : Plate-forme native @-mentions (par exemple, WhatsApp tap-to-mention). Ignoré dans le mode WhatsApp auto-chat (voir `channels.whatsapp.allowFrom`).
- **Modèles de texte**: Modèles de Regex définis dans `agents.list[].groupChat.mentionPatterns`. Toujours vérifié indépendamment du mode auto-chat.
- La mention de la barrière n'est obligatoire que lorsque la détection des mentions est possible (mentions natives ou au moins un `mentionPattern`).

```json5
{
  messages : {
    groupChat: { historyLimit: 50 },
  },
  agents : {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` définit la valeur par défaut globale pour le contexte de l'histoire du groupe. Les canaux peuvent être remplacés par `channels.<channel>.historyLimit` (ou `channels.<channel>.accounts.*.historyLimit` pour plusieurs comptes). Définissez `0` pour désactiver le wrapping historique.

#### Limites de l'historique des DM

Les conversations DM utilisent un historique de session géré par l'agent. Vous pouvez limiter le nombre de tours d'utilisateurs retenus par session DM :

```json5
{
  canaux: {
    télégramme: {
      dmHistoryLimit: 30, // limite les sessions de DM à 30 devient
      dms: {
        "123456789": { historyLimit: 50 }, // surcharge par utilisateur (ID utilisateur)
      },
    },
  },
}
```

Ordre de resolution:

1. Substitution par DM: `channels.<provider>.dms[userId].historyLimit`
2. Fournisseur par défaut : `channels.<provider>Limite de .dmHistory`
3. Aucune limite (tout historique retenu)

Fournisseurs supportés : `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Surcharge par agent (prend la priorité lorsque défini, même `[]`):

```json5
{
  agents : {
    liste: [
      { id: "travail", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personnel", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

Mentionnez les valeurs par défaut des gages en direct par canal (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). Lorsque `*.groups` est défini, il agit également comme une liste d'autorisations de groupe; inclure `"*"` pour autoriser tous les groupes.

Pour répondre **seulement** aux déclencheurs de texte spécifiques (ignorant les @-mentions natives) :

```json5
{
  channels: {
    whatsapp: {
      // Inclure votre propre numéro pour activer le mode auto-chat (ignorer les @-mentions natifs).
      permisDe: ["+15555550123"],
      groupes: { "*": { requireMention: true } },
    },
  },
  agents : {
    liste: [
      {
        id: "main",
        groupChat: {
          // Seules ces pratiques de texte déclencheront les réponses
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### Règles de groupe (par canal)

Utilisez `channels.*.groupPolicy` pour contrôler si les messages de groupe/salle sont acceptés du tout:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupeAllowDe: ["+15551234567"],
    },
    télégramme : {
      groupPolicy: "allowlist",
      groupAllowDe: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowDe: ["+15551234567"],
    },
    imitation : {
      groupPolicy: "allowlist",
      groupAllowDe: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org. om"],
    },
    discord: {
      groupPolicy: "allowlist",
      guildes: {
        GUILD_ID: {
          canaux: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      canaux: { "#general": { allow: true } },
    },
  },
}
```

Notes :

- `"open"`: groupe de contourner les listes d'autorisations; mention-gating s'applique toujours.
- `"disabled"`: bloque tous les messages de groupe/salle.
- `"allowlist"`: n'autorise que les groupes/salles qui correspondent à la liste d'autorisations configurée.
- `channels.defaults.groupPolicy` définit la valeur par défaut quand le `groupPolicy` d'un fournisseur est dédéfini.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams utilisent `groupAllowFrom` (repli : explicite `allowFrom`).
- Discord/Slack utilise des listes d'autorisations de canal (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Les DMs de groupe (Discord/Slack) sont toujours contrôlés par `dm.groupEnabled` + `dm.groupChannels`.
- La valeur par défaut est `groupPolicy: "allowlist"` (à moins que `channels.defaults.groupPolicy`); si aucune liste d'autorisations n'est configurée, les messages de groupe sont bloqués.

### Routage multi-agents (`agents.list` + `bindings`)

Exécutez plusieurs agents isolés (espace de travail séparé, `agentDir`, sessions) à l'intérieur d'une passerelle.
Les messages entrants sont acheminés vers un agent via des liaisons.

- gateway/configuration.md
  - `id`: id de l'agent stable (obligatoire).
  - `default`: optionnel; lorsque plusieurs sont définis, le premier gagne et un avertissement est enregistré.
    Si aucun n'est défini, la **première entrée** dans la liste est l'agent par défaut.
  - `name` : affiche le nom de l'agent.
  - `workspace`: par défaut `~/.openclaw/workspace-<agentId>` (pour `main`, tombe à `agents.defaults.workspace`).
  - `agentDir`: default `~/.openclaw/agents/<agentId>/agent`.
  - `model`: le modèle par défaut par agent remplace `agents.defaults.model` pour cet agent.
    - string form: `"provider/model"`, remplace seulement `agents.defaults.model.primary`
    - forme de l'objet : `{ primary, fallbacks }` (les replis remplacent `agents.defaults.model.fallbacks`; `[]` désactive les replis globaux pour cet agent)
  - `identity`: nom de chaque agent / thème/emoji (utilisé pour les motifs de mention + réactions de ack).
  - `groupChat`: per-agent mention-gating (`mentionPatterns`).
  - `sandbox`: per-agent sandbox config (remplace `agents.defaults.sandbox`).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `scope`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: racine de l'espace de travail du sandbox personnalisé
    - `docker`: le docker par agent remplace (par exemple `image`, `network`, `env`, `setupCommand`, limites; ignoré quand `scope: "shared"`)
    - `browser`: par agent sandboxed browser overrides (ignoré lorsque `scope: "shared"`)
    - `prune`: le nettoyage par agent du bac à sable remplace (ignoré lorsque `scope: "shared"`)
  - `sous-agents`: par agent sous-agent par défaut.
    - `allowAgents`: autorise la liste des identifiants d'agents pour `sessions_spawn` de cet agent (`["*"]` = autorise n'importe ; par défaut: seulement le même agent)
  - `tools`: restrictions par agent (appliquées avant la politique de l'outil sandbox).
    - `profile`: profil de l'outil de base (appliqué avant autoriser/refuser)
    - `allow`: tableau de noms d'outils autorisés
    - `niy`: tableau de noms d'outils refusés (refuse gagne)
- `agents.defaults`: agent partagé par défaut (modèle, espace de travail, bac à sable, etc.).
- `bindings[]`: annule les messages entrants vers un `agentId`.
  - `match.channel` (obligatoire)
  - `match.accountId` (facultatif; `*` = n'importe quel compte; omis = compte par défaut)
  - `match.peer` (facultatif; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (optional; channel-specific)

Ordre de correspondance déterministe :

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (exact, pas de peer/guild/team)
5. `match.accountId: "*"` (canal-wide, no peer/guild/team)
6. agent par défaut (`agents.list[].default`, sinon première entrée de liste, sinon `"main"`)

Dans chaque niveau de match, la première entrée correspondante dans `bindings` gagne.

#### Profils d’accès par agent (multi‑agent)

Chaque agent peut porter sa propre politique de sandbox + outils. Utilisez ceci pour mélanger les niveaux d'accès
dans une seule passerelle:

- **Accès complet** (agent personnel)
- Outils **en lecture seule** + espace de travail
- **Aucun accès au système de fichiers** (outils de messagerie/session seulement)

Voir [Sandbox & Outils multi-agents](/tools/multi-agent-sandbox-tools) pour la priorité et
des exemples supplémentaires.

Accès complet (sans bac à sable) :

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

Outils en lecture seule + espace de travail en lecture seule :

```json5
{
  agents : {
    liste: [
      {
        id: "famille",
        espace de travail: "~/. penclaw/workspace-family",
        sandbox: {
          mode : "all",
          téles: "agent",
          workspaceAccess : "ro",
        },
        outils : {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          : ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

Aucun accès au système de fichiers (outils de messagerie/session activés) :

```json5
{
  agents : {
    liste: [
      {
        id: "public",
        espace de travail: "~/. penclaw/workspace-public",
        sandbox: {
          mode : "all",
          téles: "agent",
          workspaceAccess : "none",
        },
        outils : {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "statut de session",
            "whatsapp",
            "télégramme",
            "slack",
            "discord",
            "passerelle",
          ],
          Ni : [
            "lu",
            "écrire",
            "modifier",
            "apply_patch",
            "exec",
            "processus",
            "navigateur",
            "toile",
            "nœuds",
            "cron",
            "passerelle",
            "image",
          ],
        },
      },
    ],
  },
}
```

Exemple: deux comptes WhatsApp → deux agents:

```json5
{
  agents : {
    liste: [
      { id: "maison", par défaut : true, workspace: "~/. penclaw/workspace-home" },
      { id: "work", workspace: "~/. penclaw/workspace-work" },
    ],
  },
  liaisons : [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  salons : {
    whatsapp: {
      accouns: {
        personal: {},
        biz : {},
      },
    },
  },
}
```

### `tools.agentToAgent` (facultatif)

La messagerie Agent-to-Agent est opt-in :

```json5
{
  tools: {
    agentToAgent: {
      activé: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.queue`

Contrôle le comportement des messages entrants lorsqu'un agent est déjà actif.

```json5
{
  messages: {
    file d'attente: {
      mode : "collect", // va | suivi | collect | steer-backlog (steer+backlog ok) | interrupt (queue=legacy)
      debounceMs: 1000,
      majuscule : 20,
      drop: "résumer", // ancien | nouveau | résumé
      par Channel: {
        whatsapp: "collect",
        télégramme : "collecter",
        discord: "collecter",
        Impression : "collecter",
        webchat : "collecter",
      },
    },
  },
}
```

### `messages.inbound`

Debouncez les messages entrants rapides du **même expéditeur** de sorte que les messages
multiples deviennent un tour d'agent. Le debouncing est delimite par canal + conversation
et utilise le message le plus recent pour le fil de reponse et les IDs.

```json5
{
  messages : {
    inbound: {
      debounceMs: 2000, // 0 désactive
      byChannel: {
        whatsapp: 5000,
        slack : 1500,
        discord: 1500,
      },
    },
  },
}
```

Notes :

- Debounce batches **text-only** messages; media/attachments purge immédiatement.
- Les commandes de contrôle (par exemple `/queue`, `/new`) contournent le débouncement pour qu'ils restent autonomes.

### `commands` (gestion des commandes de chat)

Contrôle comment les commandes de chat sont activées entre les connecteurs.

```json5
{
  commandes: {
    natif : "auto", // registre les commandes natives lorsque supporté (auto)
    text: true, // analyse les commandes slash dans les messages de chat
    bash: false, // allow ! (alias: /bash) (Hôte seulement; nécessite des outils. listes d'autorisations levées)
    bashForegroundMs: 2000, // bash fenêtre de premier plan (0 arrière-plans immédiatement)
    config: false, // autorise /config (écrit sur le disque)
    debug: false, // autorise /debug (runtime-only overrides)
    redémarrage: false, // autorise /restart + outil de redémarrage de passerelle
    useAccessGroups: true, // force les listes d'autorisations de groupe d'accès / politiques pour les commandes
  },
}
```

Notes :

- Les commandes de texte doivent être envoyées en tant que message **standalone** et utiliser le `/` (aucun alias en texte brut).
- `commands.text: false` désactive l'analyse des messages de chat pour les commandes.
- `commands.native: "auto"` (par défaut) active les commandes natives pour Discord/Telegram et laisse Slack éteint ; les canaux non pris en charge ne restent que du texte.
- Définissez `commands.native: true|false` pour forcer tous, ou remplacez par canal par `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool ou `"auto"`). `false` efface les commandes précédemment enregistrées sur Discord/Telegram au démarrage; les commandes Slack sont gérées dans l'application Slack.
- `channels.telegram.customCommands` ajoute des entrées de menu Telegram bot supplémentaires. Les noms sont normalisés ; les conflits avec les commandes natives sont ignorés.
- `commands.bash: true` active `! <cmd>` pour exécuter les commandes du shell hôte (`/bash <cmd>` fonctionne aussi comme un alias). Nécessite `tools.elevated.enabled` et autorise l'expéditeur dans `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` contrôle combien de temps bash attend avant l'arrière-plan. Pendant qu'une tâche de bash est en cours d'exécution, nouveau `! <cmd>` les demandes sont rejetées (une à la fois).
- `commands.config: true` active `/config` (reads/writes `openclaw.json`).
- `canaux.<provider>.configWrites` porte les mutations de configuration initiées par ce canal (par défaut : true). Ceci s'applique à `/config set|unset` plus aux auto-migrations spécifiques au fournisseur (changements d'ID de super-groupe Telegram, changement d'ID de canal Slack).
- `commands.debug: true` active `/debug` (overrides).
- `commands.restart: true` active `/restart` et l'outil passerelle redémarre l'action.
- `commands.useAccessGroups: false` permet aux commandes de contourner les listes d'autorisations de groupe d'accès/polices.
- Les commandes slash et directives ne sont honorées que pour des **expéditeurs autorisés**. L'autorisation est dérivée de
  channel allowlists/appairage plus `commands.useAccessGroups`.

### `web` (Exécution du canal web WhatsApp)

WhatsApp passe par le canal web de la passerelle (Baileys Web). Il démarre automatiquement lorsqu'une session liée existe.
Définissez `web.enabled: false` pour le garder désactivé par défaut.

```json5
{
  web: {
    activé: true,
    heartbeatSeconds: 60,
    reconnecté: {
      initialMs: 2000,
      maxMs : 120000,
      facteur : 1. ,
      jitter: 0. ,
      maxTentatives : 0,
    },
  },
}
```

### `channels.telegram` (transport du bot)

OpenClaw démarre Telegram seulement quand une section de configuration `channels.telegram` existe. Le jeton de bot est résolu à partir de `channels.telegram.botToken` (ou `channels.telegram.tokenFile`), avec `TELEGRAM_BOT_TOKEN` comme secours pour le compte par défaut.
Définir `channels.telegram.enabled: false` pour désactiver le démarrage automatique.
La prise en charge des comptes multi-comptes se trouve sous `channels.telegram.accounts` (voir la section multi-comptes ci-dessus). Les jetons Env ne s'appliquent qu'au compte par défaut.
Définissez `channels.telegram.configWrites: false` pour bloquer l'écriture de configuration initialisée par Telegram-initiated (incluant les migrations d'ID de supergroupe et `/config set|unset`).

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // include last N group messages as context (0 disables)
      replyToMode: "first", // off | first | all
      linkPreview: true, // toggle outbound link previews
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {
        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // transport overrides
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

Notes de streaming brouillon :

- Utilise Telegram `sendMessageDraft` (bulle brouillon, pas un vrai message).
- Nécessite **des sujets de chat privés** (message_thread_id en DMs; le bot a activé les sujets).
- `/reasoning stream` envoie le raisonnement dans le brouillon, puis envoie la réponse finale.
  La politique de réessai par défaut et le comportement sont documentés dans [Politique de réessai] (/concepts/retry).

### `channels.discord` (transport du bot)

Configurer le bot Discord en définissant le jeton de bot et le portail facultatif :
Le support multi-comptes vit sous `channels.discord.accounts` (voir la section multi-comptes ci-dessus). Les jetons Env ne s'appliquent qu'au compte par défaut.

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // clamp inbound media size
      allowBots: false, // allow bot-authored messages
      actions: {
        // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // disable all DMs when false
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false, // enable group DMs
        groupChannels: ["openclaw-dm"], // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (preferred) or slug
          slug: "friends-of-openclaw",
          requireMention: false, // per-guild default
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // include last N guild messages as context
      textChunkLimit: 2000, // optional outbound text chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

OpenClaw démarre Discord uniquement quand une section de configuration `channels.discord` existe. Le jeton est résolu à partir de `channels.discord.token`, avec `DISCORD_BOT_TOKEN` comme secours pour le compte par défaut (sauf si `channels.discord.enabled` est `false`). Utilisez `user:<id>` (DM) ou `channel:<id>` (canal de guilde) lorsque vous spécifiez des cibles de livraison pour les commandes cron/CLI ; les identifiants numériques nus sont ambigus et rejetés.
Les identifiants de guilde sont en minuscule avec des espaces remplacés par `-`; les clés de canal utilisent le nom du canal slugged (aucun `#` en tête). Préférez les identifiants de guilde comme des clés pour éviter de renommer l'ambiguïté.
Les messages créés par le bot sont ignorés par défaut. Activer avec `channels.discord.allowBots` (les propres messages sont toujours filtrés pour éviter les boucles d'auto-réponse).
Modes de notification de réaction :

- `off` : aucun evenement de reaction.
- `own` : reactions sur les propres messages du bot (defaut).
- `all` : toutes les reactions sur tous les messages.
- `allowlist` : reactions provenant de `guilds.<id>.users` sur tous les messages (liste vide desactive).
  Le texte sortant est chunked par `channels.discord.textChunkLimit` (par défaut 2000). Définissez `channels.discord.chunkMode="newline"` à séparer sur des lignes vides (limites du paragraphe) avant le chunking de longueur. Les clients Discord peuvent couper de très grands messages, donc `channels.discord.maxLinesPerMessage` (par défaut 17) divise les réponses longues de plusieurs lignes même si moins de 2000 caractères.
  La politique de réessai par défaut et le comportement sont documentés dans [Politique de réessai] (/concepts/retry).

### `channels.googlechat` (Chat API webhook)

Google Chat s'exécute sur des webhooks HTTP avec une authentification au niveau de l'application (compte de service).
La prise en charge des comptes multi-comptes se trouve sous `channels.googlechat.accounts` (voir la section multi-comptes ci-dessus). Les variables Env ne s'appliquent qu'au compte par défaut.

```json5
{
  salons: {
    googlechat: {
      activé: vrai,
      serviceAccountFile: "/path/vers/service-account. son",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example. om/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; améliore la détection des mentions
      dm: {
        activé: vrai,
        Politique : "appairage", // appairage | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groupes: {
        "espaces/AAAA": { allow: true, requireMention: true },
      },
      actions : { reactions: true },
      indicateur de frappe: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notes :

- Le compte de service JSON peut être en ligne (`serviceAccount`) ou basé sur un fichier (`serviceAccountFile`).
- Env fallbacks pour le compte par défaut : `GOOGLE_CHAT_SERVICE_ACCOUNT` ou `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience` doit correspondre à la configuration d'authentification du webhook de l'application de Chat.
- Utilisez `spaces/<spaceId>` ou `users/<userId|email>` lorsque vous définissez des cibles de livraison.

### `channels.slack` (mode socket)

Slack fonctionne en mode Socket et nécessite à la fois un jeton de bot et un jeton d'application:

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

La prise en charge des comptes multi-comptes se trouve sous `channels.slack.accounts` (voir la section multi-comptes ci-dessus). Les jetons Env ne s'appliquent qu'au compte par défaut.

OpenClaw démarre Slack lorsque le fournisseur est activé et que les deux jetons sont définis (via config ou `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Utilisez `user:<id>` (DM) ou `channel:<id>` lorsque vous spécifiez des cibles de livraison pour les commandes cron/CLI.
Définissez `channels.slack.configWrites: false` pour bloquer l'écriture de la configuration Slack-initiated (y compris les migrations d'ID du canal et `/config set|unset`).

Les messages créés par le bot sont ignorés par défaut. Activer avec `channels.slack.allowBots` ou `channels.slack.channels.<id>.allowBots`.

Modes de notification de réaction :

- `off` : aucun evenement de reaction.
- `own` : reactions sur les propres messages du bot (defaut).
- `all` : toutes les reactions sur tous les messages.
- `allowlist`: les réactions de `channels.slack.reactionAllowlist` sur tous les messages (liste vide désactive).

Isolation de la session de discussion :

- `channels.slack.thread.historyScope` contrôle si l'historique du thread est par thread (`thread`, default) ou partagé sur le canal (`channel`).
- `channels.slack.thread.inheritParent` contrôle si les nouvelles sessions de thread héritent de la transcription du canal parent (par défaut: false).

Groupes d'action Slack (actions de l'outil `slack` de portes):

| Groupe d’actions | Par défaut | Remarques                     |
| ---------------- | ---------- | ----------------------------- |
| reactions        | active     | React + lister les reactions  |
| messages         | active     | Lire/envoyer/editer/supprimer |
| pins             | active     | Epingler/desepingler/lister   |
| memberInfo       | active     | Informations de membres       |
| emojiList        | active     | Liste d’emoji personnalises   |

### `channels.mattermost` (jeton de bot)

Mattermost est distribue sous forme de plugin et n’est pas inclus dans l’installation de base.
Installez d'abord : `openclaw plugins install @openclaw/mattermost` (ou `./extensions/mattermost` depuis un checkout).

Le plus important nécessite un jeton de bot plus l'URL de base de votre serveur:

```json5
{
  channels: {
    mattermost: {
      activé: true,
      botToken: "mm-token",
      baseUrl: "https://chat. xample. om",
      dmPolicy: "appairage",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "! ],
      textChunkLimit: 4000,
      chunkMode : "length",
    },
  },
}
```

OpenClaw démarre le plus important lorsque le compte est configuré (jeton de bot + URL de base) et activé. Le jeton + l'URL de base sont résolus à partir de `channels.mattermost.botToken` + `channels.mattermost.baseUrl` ou `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` pour le compte par défaut (sauf si `channels.mattermost.enabled` est `false`).

Modes de chat :

- `oncall` (par défaut) : ne répond aux messages du canal que lorsque @mentionné.
- `onmessage` : repond a chaque message du canal.
- `onchar`: répond lorsqu'un message commence par un préfixe de déclenchement (`channels.mattermost.oncharPrefixes`, default `[">", "!"]`).

Contrôle d'accès :

- DMs par défaut: `channels.mattermost.dmPolicy="appairage"` (les expéditeurs inconnus obtiennent un code d'appairage).
- Messages prives publics : `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.
- Groupes : `channels.mattermost.groupPolicy="allowlist"` par défaut (mention-gated). Utilisez `channels.mattermost.groupAllowFrom` pour restreindre les expéditeurs.

La prise en charge des comptes multi-comptes se trouve sous `channels.mattermost.accounts` (voir la section multi-comptes ci-dessus). Les variables Env ne s'appliquent qu'au compte par défaut.
Utilisez `channel:<id>` ou `user:<id>` (ou `@username`) lorsque vous spécifiez des cibles de livraison; les identifiants natifs sont traités comme des identifiants de canal.

### `channels.signal` (signal-cli)

Les réactions de signal peuvent émettre des événements système (outils de réaction partagée) :

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | propre | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // inclure les derniers N messages de groupe dans le contexte (0 désactivé)
    },
  },
}
```

Modes de notification de réaction :

- `off` : aucun evenement de reaction.
- `own` : reactions sur les propres messages du bot (defaut).
- `all` : toutes les reactions sur tous les messages.
- `allowlist`: les réactions de `channels.signal.reactionAllowlist` sur tous les messages (liste vide désactive).

### `channels.imessage` (imsg CLI)

OpenClaw fait apparaître `imsg rpc` (JSON-RPC sur stdio). Aucun démon ou port requis.

```json5
{
  salons: {
    imessage: {
      activé: vrai,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat. b",
      distantHôte : "user@gateway-host", // SCP pour les pièces jointes distantes lors de l'utilisation du wrapper SSH
      dmPolicy: "appairage", // appairage | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example. om", "chat_id:123"],
      historyLimit: 50, // inclure les derniers N messages de groupe dans le contexte (0 désactivé)
      includeAttaches: false,
      mediaMaxMb: 16,
      service: "auto",
      région: "USA",
    },
  },
}
```

La prise en charge des comptes multi-comptes se trouve dans `channels.imessage.accounts` (voir la section multi-comptes ci-dessus).

Notes :

- Nécessite un accès complet au disque dur de la base de données des messages.
- Le premier envoi demandera l'autorisation d'automatiser les messages.
- Préférez les cibles `chat_id:<id>`. Utilisez `imsg chats --limit 20` pour lister les chats.
- `channels.imessage.cliPath` peut pointer vers un script de wrapper (par exemple `ssh` vers un autre Mac qui exécute `imsg rpc`); utilisez les clés SSH pour éviter les instructions de mot de passe.
- Pour les enveloppeurs SSH distants, définissez `channels.imessage.remoteHost` pour récupérer les pièces jointes via SCP lorsque `includeAttachments` est activé.

Exemple de wrapper :

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Définit le **répertoire de l'espace de travail global unique** utilisé par l'agent pour les opérations de fichiers.

Par defaut : `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Si `agents.defaults.sandbox` est activé, les sessions non-principales peuvent remplacer cela avec leur
leurs propres espaces de travail par portée sous `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Racine optionnelle du dépôt à afficher dans la ligne d'exécution de l'invite système. Si non défini, OpenClaw
tente de détecter un répertoire `.git` en marchant vers le haut depuis l'espace de travail (et le dossier de travail
actuel). Le chemin doit exister pour être utilisé.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

Désactive la création automatique des fichiers de bootstrap de l'espace de travail (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, et `BOOTSTRAP.md`).

Utilisez ceci pour les déploiements préconfigurés où vos fichiers d'espace de travail proviennent d'un dépôt.

```json5
{
  agents : { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

Nombre maximum de caractères de chaque fichier de bootstrap de l'espace de travail injecté dans l'invite de système
avant troncation. Par défaut : `20000`.

Lorsqu’un fichier dépasse cette limite, OpenClaw consigne un avertissement et injecte un début/fin tronqué avec un marqueur.

```json5
{
  agents : { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

Définit le fuseau horaire de l’utilisateur pour le **contexte du prompt système** (pas pour les horodatages dans les enveloppes de messages). Si non défini, OpenClaw utilise le fuseau horaire de l'hôte à l'exécution.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Contrôle le **format horaire** affiché dans la section Date et heure courante de l'invite du système.
Par défaut: `auto` (préférence de l'OS).

```json5
**Chemins absolus** : utilisés tels quels
```

### `messages`

Contrôle les préfixes entrants/sortants et les réactions d'ack optionnelles.
Voir [Messages](/concepts/messages) pour la file d'attente, les sessions et le contexte de streaming.

```json5
{
  messages: {
    responsePrefix: "🦞", // ou "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` est appliqué à **toutes les réponses sortantes** (résumés d'outils, bloc
streaming, réponses finales) à travers les canaux sauf si déjà présents.

Les remplacements peuvent être configurés par canal et par compte :

- \`channels.<channel>Préfixe de réponse
- \`channels.<channel>.accounts.<id>Préfixe de réponse

Ordre de résolution (le plus spécifique l’emporte) :

1. \`channels.<channel>.accounts.<id>Préfixe de réponse
2. \`channels.<channel>Préfixe de réponse
3. `messages.responsePrefix`

Sémantiques:

- `undefined` tombe au niveau suivant.
- `""` désactive explicitement le préfixe et arrête la cascade.
- `"auto"` dérive `[{identity.name}]` pour l'agent routé.

Les remplacements s'appliquent à tous les canaux, y compris les extensions, et à chaque type de réponse sortante.

Si `messages.responsePrefix` est dédéfini, aucun préfixe n'est appliqué par défaut. Les réponses à WhatsApp auto-chat
sont l'exception : elles sont par défaut `[{identity.name}]` lorsqu'elles sont définies, sinon
`[openclaw]`, donc les conversations du même téléphone restent lisibles.
Définissez à `"auto"` pour dériver `[{identity.name}]` pour l'agent routé (lorsqu'il est défini).

#### Variables de modèle

La chaîne `responsePrefix` peut inclure des variables de modèle qui se résolvent dynamiquement :

| Variable          | Description                   | Exemple                                        |
| ----------------- | ----------------------------- | ---------------------------------------------- |
| `{model}`         | Nom du modèle court           | `claude-opus-4-6`, `gpt-4o`                    |
| `{modelFull}`     | Identifiant complet du modèle | `anthropique/claude-opus-4-6`                  |
| `{provider}`      | Nom du fournisseur            | `anthropique`, `openai`                        |
| `{thinkingLevel}` | Niveau de pensée actuel       | `high`, `low`, `off`                           |
| `{identity.name}` | Nom d'identité de l'agent     | (même que le mode `"auto"`) |

Les variables sont insensibles à la casse (`{MODEL}` = `{model}`). `{think}` est un alias pour `{thinkingLevel}`.
Les variables non résolues restent en tant que texte littéral.

```json5
{
  messages : {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

Exemple de sortie: `[claude-opus-4-6 | think:high] Voici ma réponse...`

Le préfixe d'entrée WhatsApp est configuré via `channels.whatsapp.messagePrefix` (obsolète:
`messages.messagePrefix`). La valeur par défaut reste **inchangée**: `"[openclaw]"` quand
`channels.whatsapp.allowFrom` est vide, sinon `""` (pas de préfixe). Lorsque vous utilisez
`"[openclaw]"`, OpenClaw utilisera à la place `[{identity.name}]` lorsque l'agent routé
a défini `identity.name`.

`ackReaction` envoie une réaction emoji du meilleur effort pour reconnaître les messages entrants
sur les canaux qui supportent les réactions (Slack/Discord/Telegram/Google Chat). La valeur par défaut du `identity.emoji` de l'agent actif
lorsqu'il est défini, sinon `"👀"`. Définir à `""` pour désactiver.

`ackReactionScope` contrôle quand les réactions se déclencheront :

- `group-mentions` (par défaut) : seulement quand un groupe/salle nécessite des mentions **et** que le bot a été mentionné
- `group-all`: tous les messages de groupe/salle
- `direct`: messages directs uniquement
- `all`: tous les messages

`removeAckAfterReply` supprime la réaction d’accusé de réception du bot après l’envoi d’une réponse (Slack/Discord/Telegram/Google Chat uniquement). Par défaut: `false`.

#### `messages.tts`

Activer la synthèse vocale pour les réponses sortantes. Lorsqu'activé, OpenClaw génère de l'audio
en utilisant ElevenLabs ou OpenAI et l'attache aux réponses. Telegram utilise des notes vocales Opus
; les autres canaux envoient de l'audio MP3.

```json5
{
  messages: {
    tts: {
      auto: "toujours", // off | always | entrant | tagged
      mode : "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4. -mini",
      modèles: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/. penclaw/paramètres/tts. son",
      onze labs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api. levenlabs. o",
        voiceId : "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode : "fr",
        paramètres vocaux: {
          stabilité: 0. ,
          similarityBoost: 0. 5,
          style: 0. ,
          useSpeakerBoost : vrai,
          vitesse: 1. ,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        modèle: "gpt-4o-mini-tts",
        voix: "alliage",
      },
    },
  },
}
```

Notes :

- `messages.tts.auto` contrôle auto‐TTS (`off`, `always`, `inbound`, `tagged`).
- `/tts off|toujours|inbound|tagged` définit le mode auto par session (remplace la config).
- `messages.tts.enabled` est hérité; le médecin le migre vers `messages.tts.auto`.
- `prefsPath` stocke les substitutions locales (provider/limit/summarize).
- `maxTextLength` est un capuchon dur pour l'entrée TTS ; les résumés sont tronqués pour s'adapter.
- `summaryModel` remplace `agents.defaults.model.primary` pour auto-summary.
  - Accepte `provider/model` ou un alias de `agents.defaults.models`.
- `modelOverrides` active les remplacements basés sur le modèle comme les balises `[[tts:...]]` (par défaut).
- `/tts limit` et `/tts summary` contrôlent les paramètres de synthèse par utilisateur.
- Les valeurs `apiKey` reviennent à `ELEVENLABS_API_KEY`/`XI_API_KEY` et `OPENAI_API_KEY`.
- `elevenlabs.baseUrl` remplace l'URL de base de l'API ElevenLabs.
- `elevenlabs.voiceSettings` supporte `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, et `speed` (0.5..2.0).

### `parler`

Par défaut pour le mode Talk (macOS/iOS/Android). Les identifiants vocaux sont remplacés par « ELEVENLABS_VOICE_ID» ou « SAG_VOICE_ID» lorsque le paramètre n'est pas défini.
`apiKey` tombe à `ELEVENLABS_API_KEY` (ou le profil du shell de la passerelle) quand il n'est pas défini.
`voiceAliases` permet aux directives Talk d'utiliser des noms conviviaux (par exemple `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Griffe : "EXAVITQu4vr4xnSDxMaL",
      Roger : "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

Contrôle le runtime de l'agent intégré (modèle/pense/verbose/timeouts).
`agents.defaults.models` définit le catalogue de modèles configuré (et agit comme la liste d'autorisations pour `/model`).
`agents.defaults.model.primary` définit le modèle par défaut; `agents.defaults.model.fallbacks` sont des utilisateurs globaux.
`agents.defaults.imageModel` est optionnel et n'est **utilisé que si le modèle principal manque d'entrée d'image**.
Chaque entrée `agents.defaults.models` peut inclure :

- `alias` (raccourci du modèle optionnel, par exemple `/opus`).
- `params` (des paramètres d'API optionnels spécifiques au fournisseur sont passés à la requête du modèle).

`params` est également appliqué aux exécutions de streaming (agent embarqué + compaction). Clés supportées aujourd'hui: `temperature`, `maxTokens`. Celles-ci fusionnent avec les options de temps d'appel; les valeurs fournies par l'appelant gagnent. `temperature` est un bouton avancé, laisser vide à moins que vous ne connaissiez les valeurs par défaut du modèle et que vous ayez besoin d'un changement.

Exemple :

```json5
{
  agents: {
    par défaut: {
      modèles: {
        "anthropic/claude-sonnet-4-5-20250929": {
          paramètres : { temperature: 0.6 },
        },
        "openai/gpt-5. ": {
          paramètres : { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Les modèles Z.AI GLM-4.x activent automatiquement le mode de pensée à moins que vous :

- définir `--thinking off`, ou
- définissez vous-même `agents.defaults.models["zai/<model>"].params.thinking`.

OpenClaw fournit également quelques raccourcis d'alias intégrés. Les valeurs par défaut ne s'appliquent que lorsque le modèle
est déjà présent dans `agents.defaults.models`:

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

Si vous configurez le même nom d'alias (insensible à la casse) vous-même, votre valeur gagnera (par défaut, elle ne sera jamais remplacée).

Exemple : Opus 4.6 primaire avec MiniMax M2.1 (hébergé MiniMax) :

```json5
{
  agents: {
    par défaut: {
      modèles: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2. ": { alias : "minimax" },
      }, Modèle
      : {
        primaire : "anthropique/claude-opus-4-6",
        replis : ["minimax/MiniMax-M2. "],
      },
    },
  },
}
```

MiniMax auth: définir `MINIMAX_API_KEY` (env) ou configurer `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI replié)

Backends CLI optionnels pour les exécutions de secours en mode texte (pas d'appels d'outils). Celles-ci sont utiles comme un chemin de sauvegarde
lorsque les fournisseurs d'API échouent. Le passage de l'image est pris en charge lorsque vous configurez
un `imageArg` qui accepte les chemins de fichier.

Notes :

- Les backends CLI sont **text-first** ; les outils sont toujours désactivés.
- Les sessions sont prises en charge lorsque `sessionArg` est défini; les identifiants de session sont persistés par backend.
- Pour `claude-cli`, les valeurs par défaut sont câblées. Remplacer le chemin de la commande si PATH est minimum
  (launchd/systemd).

Exemple :

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "mon-cli": {
          commande: "mon-cli",
          args: ["--json"],
          sortie : "json",
          modèle Arg: "--model",
          sessionArg: "--session",
          sessionMode : "existant",
          systemPromptArg : "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode : "répéter",
        },
      },
    },
  },
}
```

```json5
{
  agents: {
    par défaut: {
      modèles: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4. ": {
          alias : "GLM",
          paramètres : {
            pense: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      modèle : {
        primaire : "anthropique/claude-opus-4-6",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3. -70b-instruct:gratuit",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2. -vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2. -vision flash: libre"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      secondes de timeout: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        cible : "dernier",
      },
      maxConcurrent : 3,
      sous-agents : {
        model: "minimax/MiniMax-M2. ",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        nettoyageM: 1800000,
      },
      contextTokens : 200000,
    },
  },

```

#### `agents.defaults.contextPruning` (tool-result pruning)

`agents.defaults.contextPruning` supprime **les résultats de l'ancien outil** du contexte en mémoire juste avant qu'une requête ne soit envoyée au LLM.
Il **ne modifie pas** l'historique de session sur le disque (`*.jsonl` reste terminé).

Ceci est destiné à réduire l'utilisation de jetons pour les agents de chat qui accumulent des sorties de gros outils au fil du temps.

Niveau supérieur:

- Ne touchez jamais les messages utilisateur/assistant.
- Protège les derniers messages d'assistant `keepLastAssistants` (aucun résultat d'outil après que ce point soit supprimé).
- Protège le préfixe de bootstrap (rien avant que le premier message utilisateur soit effacé).
- Modes:
  - `adaptive`: soft-trims oversized tool results (keep head/tail) when the estimated context ratio crosses `softTrimRatio`.
    Puis hard-efface les résultats les plus anciens outils éligibles lorsque le ratio contextuel estimé traverse `hardClearRatio` **et**
    il y a assez de prunable tool-result bulk (`minPrunableToolChars`).
  - `agressive`: remplace toujours les résultats des outils éligibles avant la coupure par le `hardClear.placeholder` (pas de vérifications de ratifs).

Soft vs hard pruning (quels changements dans le contexte envoyés au LLM):

- **Soft-trim**: seulement pour les résultats de l'outil _surdimensionnés_. Conserve le début + la fin et insère `...` au milieu.
  - Before: `toolResult("…very long output…")`
  - Après: `toolResult("HEAD…\n...\n…TAIL\n\n[Résultat de l'outil : …]")`
- **Hard-clear** : remplace le résultat de l'outil entier par le placeholder.
  - Before: `toolResult("…very long output…")`
  - Après: `toolResult("[Ancien outil contenu de résultat effacé]")`

Notes / Limites actuelles:

- Les résultats de l'outil contenant des **blocs d'image sont ignorés** (jamais tronqués/effacés) pour le moment.
- Le “ratio contextuel” estimé est basé sur des **caractères** (approximatifs), pas des jetons exacts.
- Si la session ne contient pas encore au moins de messages d'assistant `keepLastAssistants`, la taille est ignorée.
- En mode `agressive`, `hardClear.enabled` est ignoré (les résultats des outils éligibles sont toujours remplacés par `hardClear.placeholder`).

Par défaut (adaptatif) :

```json5
{
  Agents: { defaults: { contextPruning: { mode: "adaptive" } },
}
```

Pour désactiver:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } },
}
```

Par défaut (lorsque `mode` est `"adaptive"` ou `"agressive"`):

- `keepLastAssistants` : `3`
- `softTrimRatio`: `0.3` (adaptatif seulement)
- `hardClearRatio`: `0.5` (adaptatif seulement)
- `minPrunableToolChars`: `50000` (adaptatif seulement)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (adaptatif seulement)
- `hardClear` : `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Exemple (agressif, minimum) :

```json5
{
  agents: { defaults: { contextPruning: { mode: "agressive" } },
}
```

Exemple (ajusté adaptatif) :

```json5
{
  agents : {
    par défaut : {
      contextPruning: {
        mode : "adaptatif",
        keepLastAssistants: 3,
        softTrimRatio: 0. ,
        hardClearRatio : 0. ,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { activé: true, placeholder: "[Ancien outil contenu de résultat effacé]" },
        // Facultatif: restreindre la taille à des outils spécifiques (refuser les victoires; supporte les caractères génériques "*")
        outils: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

Voir [/concepts/session-pruning](/concepts/session-pruning) pour plus de détails sur le comportement.

#### `agents.defaults.compaction` (réserve headroom + mémoire flush)

`agents.defaults.compaction.mode` sélectionne la stratégie de résumé de la compaction. Par défaut, `default`; définit `safeguard` pour activer la synthèse des chunked pour les très longues histoires. Voir [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` impose une valeur minimale `reserveTokens`
pour la compaction Pi (par défaut: `20000`). Définissez-le à `0` pour désactiver le sol.

`agents.defaults.compaction.memoryFlush` exécute un tour agentique **silencieux** avant
auto-compaction, instruction au modèle de stocker des mémoires durables sur le disque (par exemple
`memory/YYYY-MM-DD.md`). Il se déclenche lorsque l’estimation des jetons de session dépasse un seuil souple inférieur à la limite de compaction.

Défaut hérité :

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: valeurs par défaut intégrées avec `NO_REPLY`
- Note: la mémoire vive est ignorée lorsque l'espace de travail de la session est en lecture seule
  (`agents.defaults.sandbox.workspaceAccess: "ro"` ou `"none"`).

Exemple (ajusté) :

```json5
{
  agents: {
    par défaut : {
      compaction: {
        mode : "sauvegarde",
        réservoirTokensFloor: 24000,
        memoryFlush: {
          activé: true,
          softThresholdTokens : 6000,
          systemPrompt: "Session presque compact". Stockez des souvenirs durables.",
          : "Écrivez des notes durables à la mémoire/AAAA-MM-JJ. ; répondez avec NO_REPLY si rien à stocker. ,
        },
      },
    },
  },
}
```

Bloquer le streaming:

- `agents.defaults.blockStreamingDefault` : `"on"`/`"off"` (désactivé par défaut).

- Substitutions de canal : `*.blockStreaming` (et variantes par compte) pour forcer le blocage du streaming on/off.
  Les canaux non-Telegram nécessitent un `*.blockStreaming: true` explicite pour activer les réponses de bloc.

- `agents.defaults.blockStreamingBreak`: `"text_end"` ou `"message_end"` (par défaut: text_end).

- `agents.defaults.blockStreamingChunk`: un chunking souple pour les blocs streamés. Par défaut,
  800-1200 caractères, préfère les sauts de paragraphe (\`\n\nA), puis les nouvelles lignes, puis les phrases.
  Exemple :

  ```json5
  {
    agents : { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: fusionne les blocs avant l'envoi.
  Par défaut, `{ idleMs: 1000 }` et hérite `minChars` de `blockStreamingChunk`
  avec la limite de texte de `maxChars` Signal/Slack/Discord/Google Chat par défaut
  à `minChars: 1500` sauf remplacement.
  Substitutions de canaux: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (et variantes de compte per).

- `agents.defaults.humanDelay`: pause aléatoire entre **réponses de bloc** après la première.
  Modes: `off` (par défaut), `natural` (800–2500ms), `custom` (utilisez `minMs`/`maxMs`).
  Surcharge par agent : `agents.list[].humanDelay`.
  Exemple :

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } },
  }
  ```

  Voir [/concepts/streaming](/concepts/streaming) pour plus de détails sur le comportement + le chunking.

Indicateurs d'écriture :

- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"`. Par défaut,
  `instant` pour les chats directs/mentions et `message` pour les chats de groupe non mentionnés.
- `session.typingMode`: surcharge par session pour le mode.
- `agents.defaults.typingIntervalSeconds`: à quelle fréquence le signal de saisie est actualisé (par défaut: 6s).
- `session.typingIntervalSeconds`: surcharge par session pour l'intervalle de rafraîchissement.
  Voir [/concepts/typing-indicators](/concepts/typing-indicators) pour plus de détails sur le comportement.

`agents.defaults.model.primary` doit être défini comme `provider/model` (par exemple `anthropic/claude-opus-4-6`).
Les alias proviennent de `agents.defaults.models.*.alias` (par exemple `Opus`).
Si vous omettez le fournisseur, OpenClaw assume actuellement `anthropique` comme un repli temporaire de la dépréciation
.
Les modèles Z.AI sont disponibles en tant que `zai/<model>` (par exemple `zai/glm-4.7`) et requièrent
`ZAI_API_KEY` (ou `Z_AI_API_KEY`) dans l'environnement.

`agents.defaults.heartbeat` configure les exécutions périodiques de pulsations cardiaques :

- `every`: duration string (`ms`, `s`, `m`, `h`); default unit minutes. Par défaut:
  `30m`. Définissez `0m` pour désactiver.
- `model`: modèle optionnel de remplacement pour les exécutions de pulsations (`provider/model`).
- `includeReasoning`: lorsque `true`, les pulsations du cœur fourniront également le message séparé `Raisoning:` quand il est disponible (même forme que `/reasoning on`). Par défaut: `false`.
- `session`: clé de session optionnelle pour contrôler la session dans laquelle le rythme cardiaque s'exécute. Par défaut: `main`.
- `to` : surcharge optionnelle du destinataire (id spécifique au canal, par exemple E.164 pour WhatsApp, ID de chat pour Telegram).
- `target`: canal de livraison optionnel (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Par défaut: `last`.
- `prompt`: surcharge optionnelle pour le corps du cœur-beat (par défaut: `Lire HEARTBEAT.md s'il existe (contexte d'espace de travail). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Les remplacements sont envoyés verbatim; inclure une ligne `Lire HEARTBEAT.md` si vous voulez toujours que le fichier soit lu.
- `ackMaxChars`: max caractères autorisés après `HEARTBEAT_OK` avant la livraison (par défaut : 300).

Heartbeats par agent:

- Définissez `agents.list[].heartbeat` pour activer ou outrepasser les paramètres de pulsations cardiaques pour un agent spécifique.
- Si une entrée d'agent définit `heartbeat`, **only those agents** run heartbeats; defaults
  devient la ligne de base partagée pour ces agents.

Les heartbeats exécutent des tours d’agent complets. Les intervalles plus courts brûlent plus de jetons ; soyez attentif à
de `tous`, gardez petit `HEARTBEAT.md` et/ou choisissez un `modèle moins cher`.

`tools.exec` configure le fond par défaut exec :

- `backgroundMs`: temps avant l'arrière-plan automatique (ms, valeur par défaut 10000)
- `timeoutSec`: auto-kill après cette exécution (secondes, par défaut 1800)
- `cleanupMs`: combien de temps pour conserver les sessions terminées en mémoire (ms, 1800000)
- `notifyOnExit`: mettre en file d'attente un événement système + demander des pulsations cardiaques en arrière-plan exec (valeur par défaut vraie)
- `applyPatch.enabled`: active `apply_patch` expérimental (Codex OpenAI/OpenAI seulement; default false)
- `applyPatch.allowModels`: optionel allowlist of model ids (e.g. `gpt-5.2` or `openai/gpt-5.2`)
  Note: `applyPatch` is only under `tools.exec`.

`tools.web` configure la recherche web + les outils de recherche :

- `tools.web.search.enabled` (par défaut : true lorsque la clé est présente)
- `tools.web.search.apiKey` (recommandé: définir via `openclaw configure --section web`, ou utiliser `BRAVE_API_KEY` env var)
- `tools.web.search.maxResults` (1–10, par défaut 5)
- `tools.web.search.timeoutSeconds` (par défaut 30)
- `tools.web.search.cacheTtlMinutes` (par défaut 15)
- `tools.web.fetch.enabled` (par défaut true)
- `tools.web.fetch.maxChars` (par défaut 50000)
- `tools.web.fetch.maxCharsCap` (par défaut 50000; clampe maxChars des appels config/tool)
- `tools.web.fetch.timeoutSeconds` (par défaut 30)
- `tools.web.fetch.cacheTtlMinutes` (par défaut 15)
- `tools.web.fetch.userAgent` (surcharge optionnelle)
- `tools.web.fetch.readability` (par défaut true; disable to use basic HTML cleanup only)
- `tools.web.fetch.firecrawl.enabled` (par défaut vrai quand une clé API est définie)
- `tools.web.fetch.firecrawl.apiKey` (facultatif; par défaut `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (par défaut [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (par défaut true)
- `tools.web.fetch.firecrawl.maxAgeMs` (optionnel)
- `tools.web.fetch.firecrawl.timeoutSeconds` (optionnel)

`tools.media` configure la compréhension des médias entrants (image/audio/vidéo) :

- `tools.media.models`: liste de modèles partagés (capability-tagged; utilisée après les listes de capture).
- `tools.media.concurrency`: capacité simultanée max exécutée (par défaut 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video` :
  - `enabled`: opt-out switch (par défaut true lorsque les modèles sont configurés).
  - `prompt`: surcharge optionnelle de l'invite (image/vidéo ajoute automatiquement un indice `maxChars`).
  - `maxChars`: nombre maximum de caractères de sortie (par défaut 500 pour l'image/la vidéo; annuler pour l'audio).
  - `maxBytes`: taille maximale du média à envoyer (par défaut: image 10Mo, audio 20Mo, vidéo 50Mo).
  - `timeoutSeconds`: demande de timeout (par défaut : image 60s, audio 60s, vidéo 120).
  - `language`: indice audio optionnel.
  - `attachments`: politique d'attachement (`mode`, `maxAttachments`, `prefer`).
  - `scope`: portail optionnel (premier match gagne) avec `match.channel`, `match.chatType`, ou `match.keyPrefix`.
  - `models`: liste ordonnée des entrées du modèle; les échecs ou les dépassements de média tombent à l'entrée suivante.
- Chaque entrée `models[]` :
  - Entrée du fournisseur (`type: "provider"` ou omisé) :
    - `provider`: ID de fournisseur API (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).
    - `model`: remplacement de l'id du modèle (requis pour l'image; valeur par défaut à `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` pour les fournisseurs audio, et `gemini-3-flash-preview` pour la vidéo).
    - `profile` / `preferredProfile`: sélection du profil d'authentification.
  - Entrée CLI (`type: "cli"`):
    - `commande`: exécutable à exécuter.
    - `args`: gabarit args (supporte `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `capabilities`: liste optionnelle (`image`, `audio`, `video`) pour ouvrir une entrée partagée. Défaut quand omis : `openai`/`anthropic`/`minimax` → image, `google` → image+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` peuvent être remplacés par entrée.

Si aucun modèle n'est configuré (ou `activé: false`), la compréhension est ignorée; le modèle reçoit toujours les pièces jointes originales.

L'authentification du fournisseur suit l'ordre d'authentification standard des modèles (profils d'authentification, env vars comme `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, ou `models.providers.*.apiKey`).

Exemple :

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` configure les valeurs par défaut des sous-agents :

- `model`: modèle par défaut pour les sous-agents apparus (chaîne de caractères ou `{ primary, fallbacks }`). En cas d'omission, les sous-agents héritent du modèle de l'appelant à moins d'être remplacés par agent ou par appel.
- `maxConcurrent`: nombre maximum de sous-agents simultanés exécutés (par défaut 1)
- `archiveAfterMinutes`: archiver automatiquement les sessions de sous-agents après N minutes (par défaut 60; définir `0` pour désactiver)
- Règle de l'outil par sous-agent : `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (deny wins)

`tools.profile` définit un **outil de base allowlist** avant `tools.allow`/`tools.deny`:

- `minimal` : `session_status` uniquement
- `coding` : `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging` : `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full` : aucune restriction (identique à non défini)

Surcharge par agent : `agents.list[].tools.profile`.

Exemple (messagerie uniquement par défaut, autoriser aussi les outils Slack + Discord) :

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Exemple (profil de codage, mais interdire exec/process partout) :

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` vous permet **de restreindre** les outils pour des fournisseurs spécifiques (ou un seul `provider/model`).
Surcharge par agent : `agents.list[].tools.byProvider`.

Commande : profil de base → profil du fournisseur → autoriser/refuser les politiques.
Les clés du fournisseur acceptent soit `provider` (par exemple `google-antigravity`) soit `provider/model`
(par exemple `openai/gpt-5.2`).

Exemple (conserver le profil de codage global, mais outils minimaux pour Google Antigravity) :

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Exemple (liste d'autorisations spécifique au fournisseur/modèle) :

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

`tools.allow` / `tools.deny` configure un outil global autoriser/deny policy (deny wins).
La correspondance est insensible à la casse et supporte les caractères génériques `*` (`"*"` signifie tous les outils).
Ceci est appliqué même lorsque le sandbox Docker est **désactivé**.

Exemple (désactiver le navigateur/canvas partout):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

Les groupes d’outils (raccourcis) fonctionnent dans les politiques d’outils **global** et **par agent** :

- `group:runtime` : `exec`, `bash`, `process`
- `group:fs` : `read`, `write`, `edit`, `apply_patch`
- `group:sessions` : `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory` : `memory_search`, `memory_get`
- `group:web` : `web_search`, `web_fetch`
- `group:ui` : `browser`, `canvas`
- `group:automation` : `cron`, `gateway`
- `group:messaging` : `message`
- `group:nodes` : `nodes`
- `group:openclaw` : tous les outils OpenClaw intégrés (exclut les plugins de fournisseurs)

`tools.elevated` contrôle l'accès exec élevé (host) :

- `enabled` : autorise le mode élevé (par défaut true)
- `allowFrom`: per-channel allowlists (vide = désactivé)
  - `whatsapp`: nombre E.164
  - `telegram` : ID de chat ou nom d'utilisateur
  - `discord`: les identifiants des utilisateurs ou les noms d'utilisateur (tombe à `channels.discord.dm.allowFrom` si omis)
  - `signal`: nombre E.164
  - `imessage`: gestion/ID de chat
  - `webchat`: ID de session ou nom d'utilisateur

Exemple :

```json5
{
  outils: {
    élévé: {
      activé: vrai,
      allowDe: {
        whatsapp: ["+155550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

Surcharge par agent (restriction supplémentaire):

```json5
{
  agents : {
    liste: [
      {
        id: "famille", Outils
        : {
          élevés : { enabled: false },
        },
      },
    ],
  },
}
```

Notes :

- `tools.elevated` est la ligne de base globale. `agents.list[].tools.elevated` ne peut que restreindre davantage (les deux doivent autoriser).
- `/elevated on|off|ask|full` stocke l'état par clé de session; les directives en ligne s'appliquent à un seul message.
- `exec` élevé fonctionne sur l'hôte et contourne la sandboxing.
- La politique des outils s'applique toujours; si `exec` est refusé, il est impossible d'utiliser une politique élevée.

`agents.defaults.maxConcurrent` définit le nombre maximum d'exécutions d'agents embarqués qui peuvent
exécuter en parallèle entre les sessions. Chaque session est toujours sérialisée (une fois exécutée
par clé de session à la fois). Defaut : 1.

### `agents.defaults.sandbox`

Optionnel **sandboxing Docker** pour l'agent embarqué. Destiné aux sessions
non principales, elles ne peuvent donc pas accéder à votre système hôte.

Détails: [Sandboxing](/gateway/sandboxing)

Par défaut (si activé) :

- scope: `"agent"` (un conteneur + espace de travail par agent)
- Image basée sur Debian bookworm-slim
- agent workspace access: `workspaceAccess: "none"` (par défaut)
  - `"none"`: utilise un espace de travail sandbox par portée sous `~/.openclaw/sandboxes`
- `"ro"`: garde l'espace de travail sandbox à `/workspace`, et monte l'espace de travail de l'agent en lecture seule à `/agent` (désactive `write`/`edit`/`apply_patch`)
  - `"rw"`: monte l'espace de travail de l'agent en lecture/écriture dans `/workspace`
- auto-prune : inactif > 24 h OU âge > 7 j
- tool policy: allow only `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (deny wins)
  - configurer via `tools.sandbox.tools`, remplacer par agent via `agents.list[].tools.sandbox.tools`
  - les groupes d'outils supportés dans la politique sandbox : `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (voir [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- navigateur en boîte à sable optionnel (Chromium + CDP, observateur noVNC)
- boutons de durcissement : `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

Attention: `scope: "shared"` signifie un conteneur partagé et un espace de travail partagé. Aucune isolation inter‑session. Utilisez `scope: "session"` pour l'isolement par session.

Legacy: `perSession` est toujours supporté (`true` → `scope: "session"`,
`false` → `scope: "shared"`).

`setupCommand` s'exécute **une fois** après que le conteneur soit créé (à l'intérieur du conteneur via `sh -lc`).
Pour les installations de paquets, assurez-vous que le réseau est égal, un système de gestion des droits en écriture et un utilisateur root.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Construire l'image du sandbox par défaut une fois avec:

```bash
scripts/sandbox-setup.sh
```

Note: Les conteneurs sandbox sont par défaut `network: "none"`; définissez `agents.defaults.sandbox.docker.network`
à `"bridge"` (ou votre réseau personnalisé) si l'agent a besoin d'un accès sortant.

Note: les pièces jointes entrantes sont mises en scène dans l'espace de travail actif à `media/inbound/*`. Avec `workspaceAccess: "rw"`, cela signifie que les fichiers sont écrits dans l'espace de travail de l'agent.

Note : `docker.binds` monte des répertoires d'hôtes supplémentaires ; les liaisons globales et par agent sont fusionnées.

Construire l'image optionnelle du navigateur avec:

```bash
scripts/sandbox-browser-setup.sh
```

Lorsque `agents.defaults.sandbox.browser.enabled=true`, l'outil du navigateur utilise une instance de sandboxed
Chromium (CDP). Si noVNC est activé (par défaut quand headless=false),
l'URL noVNC est injectée dans l'invite système pour que l'agent puisse la référentier.
Cela ne nécessite pas `browser.enabled` dans la configuration principale; l'URL de contrôle de bac à sable
est injectée par session.

`agents.defaults.sandbox.browser.allowHostControl` (par défaut: false) permet à
sandboxed sessions de cibler explicitement le **host** browser control server
via l'outil navigateur (`target: "host"`). Laissez cette option désactivée si vous voulez une isolation stricte du bac à sable
stricte.

Listes d'autorisations pour le contrôle à distance :

- `allowedControlUrls`: URL de contrôle exacte permise pour `target: "custom"`.
- `allowedControlHosts`: noms d'hôtes autorisés (nom d'hôte seulement, aucun port).
- `allowedControlPorts`: ports autorisés (par défaut: http=80, https=443).
  Par défaut : toutes les listes d'autorisations sont non définies (aucune restriction). `allowHostControl` est par défaut à false.

### `models` (fournisseurs personnalisés + URL de base)

OpenClaw utilise le modèle **pi-coding-agent**. Vous pouvez ajouter des fournisseurs personnalisés
(LiteLLM, serveurs compatibles avec OpenAI, proxy Anthropique, etc.) en écrivant
`~/.openclaw/agents/<agentId>/agent/models.json` ou en définissant le même schéma dans votre configuration
OpenClaw sous `models.providers`.
Aperçu du fournisseur par fournisseur + exemples : [/concepts/model-providers](/concepts/model-providers).

Lorsque `models.providers` est présent, OpenClaw écrit / fusionne un `models.json` en
`~/.openclaw/agents/<agentId>/agent/` au démarrage :

- comportement par défaut : **fusion** (conserve les fournisseurs existants, remplace le nom)
- définir `models.mode: "replace"` pour écraser le contenu du fichier

Sélectionnez le modèle via `agents.defaults.model.primary` (provider/model).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3. -8b" },
      modèles: {
        "custom-proxy/llama-3. -8b : {},
      },
    },
  }, Modèles
  : mode {
    : "fusion",
    Fournisseurs : {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey : "LITELLM_KEY",
        api : "openai-completions",
        modèles: [
          {
            id: "llama-3. -8b",
            nom: "Llama 3. 8B",
            raisonnement : faux, Entrée
            : ["texte"],
            coût : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            fenêtre contextuelle: 128000,
            maxTokens : 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen (proxy multi-modèles)

OpenCode Zen est une passerelle multi-modèles avec des points de terminaison par modèle. OpenClaw utilise
le fournisseur intégré `opencode` de pi-ai; définissez `OPENCODE_API_KEY` (ou
`OPENCODE_ZEN_API_KEY`) de [https://opencode.ai/auth](https://opencode.ai/auth).

Notes :

- Les modèles utilisent `opencode/<modelId>` (exemple: `opencode/claude-opus-4-6`).
- Si vous activez une liste d'autorisations via `agents.defaults.models`, ajoutez chaque modèle que vous prévoyez utiliser.
- Raccourci : `openclaw à la carte --auth-choice opencode-zen`.

```json5
{
  agents: {
    par défaut: {
      model: { primary: "opencode/claude-opus-4-6" },
      modèles: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) — support des alias du fournisseur

Les modèles Z.AI sont disponibles via le fournisseur intégré `zai`. Définissez `ZAI_API_KEY`
dans votre environnement et référencez le modèle par fournisseur/modèle.

Raccourci : `openclaw à la carte --auth-choice zai-api-key`.

```json5
{
  agents: {
    par défaut: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

Notes :

- `z.ai/*` et `z-ai/*` sont des alias acceptés et se normalisent en `zai/*`.
- Si `ZAI_API_KEY` est manquant, les requêtes vers `zai/*` échoueront avec une erreur d'authentification au moment de l'exécution.
- Erreur d'exemple : `Aucune clé API trouvée pour le fournisseur "zai".`
- Le point de terminaison général de l'API de Z.AI est `https://api.z.ai/api/paas/v4`. Les requêtes de codage GLM
  utilisent le point de terminaison dédié `https://api.z.ai/api/coding/paas/v4`.
  Le fournisseur intégré `zai` utilise le point de terminaison de Codage. Si vous avez besoin de l'extrémité générale
  , définissez un fournisseur personnalisé dans `models.providers` avec la substitution de l'URL de base
  (voir la section des fournisseurs personnalisés ci-dessus).
- Utilisez un faux placeholder dans les docs/configs ; ne commettez jamais de vraies clés d'API.

### Moonshot AI (Kimi)

Utiliser le point de terminaison compatible OpenAI de Moonshot:

```json5
{
  env: { MOONSHOT_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2. " },
      modèles: { "lune/kimi-k2. ": { alias: "Kimi K2. " } },
    },
  },
  modèles: {
    mode : "fusion",
    Fournisseurs : {
      lune: {
        baseUrl: "https://api. oonshot. i/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        modèles: [
          {
            id: "kimi-k2. ",
            nom: "Kimi K2. ",
            raisonnement : faux, Entrée
            : ["texte"],
            coût : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextFenêtre : 256000,
            maxTokens : 8192,
          },
        ],
      },
    },
  },
}
```

Notes :

- Définissez `MOONSHOT_API_KEY` dans l'environnement ou utilisez `openclaw à bord --auth-choice moonshot-api-key`.
- Modèle ref: `moonshot/kimi-k2.5`.
- Pour le point de terminaison de la Chine:
  - Exécutez `openclaw à la carte --auth-choice moonshot-api-key-cn` (l'assistant va définir `https://api.moonshot.cn/v1`), ou
  - Définissez manuellement `baseUrl: "https://api.moonshot.cn/v1"` dans `models.providers.moonshot`.

### Kimi Coding

Utiliser le point de terminaison du codage Kimi de Moonshot AI (fournisseur intégré et compatible Anthropique) :

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

Notes :

- Définissez `KIMI_API_KEY` dans l'environnement ou utilisez `openclaw à bord --auth-choice kimi-code-api-key`.
- Modèle ref: `kimi-coding/k2p5`.

### Synthétique (compatible Anthropique)

Utiliser le point de terminaison Anthropique du synthétique:

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Notes :

- Définissez `SYNTHETIC_API_KEY` ou utilisez `openclaw à bord --auth-choice synthetic-api-key`.
- Modèle ref: `synthétique/hf:MiniMaxAI/MiniMax-M2.1`.
- L'URL de base devrait omettre `/v1` car le client anthropique l'ajoute.

### Modèles locaux (LM Studio) — Configuration recommandée

Voir [/gateway/local-models](/gateway/local-models) pour les conseils locaux actuels. TL;DR: exécutez MiniMax M2.1 via LM Studio Responses API sur un matériel sérieux; gardez les modèles hébergés fusionnés pour une solution de repli.

### MiniMax M2.1

Utiliser MiniMax M2.1 directement sans LM Studio :

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2. " },
    modèles: {
      "anthropique/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2. ": { alias: "Minimax" },
    },
  }, Modèles
  : mode {
    : "fusion",
    Fournisseurs : {
      minimax: {
        baseUrl: "https://api. inimax. o/anthropique",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropique-messages",
        modèles: [
          {
            id: "MiniMax-M2. ",
            nom: "MiniMax M2. ",
            raisonnement : faux, Entrée
            : ["texte"],
            // Tarif: mise à jour dans les modèles. si vous avez besoin d'un suivi exact des coûts.
            coût: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens : 8192,
          },
        ],
      },
    },
  },
}
```

Notes :

- Définissez la variable d'environnement `MINIMAX_API_KEY` ou utilisez `openclaw à bord --auth-choice minimax-api`.
- Modèle disponible: `MiniMax-M2.1` (par défaut).
- Mettre à jour les prix dans `models.json` si vous avez besoin de suivi exact des coûts.

### Cérébraux (GLM 4.6 / 4.7)

Utilisez Cerebras via leur point de terminaison compatible OpenAI:

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

Notes :

- Utilisez `cerebras/zai-glm-4.7` pour Cerebras; utilisez `zai/glm-4.7` pour Z.AI direct.
- Définissez `CEREBRAS_API_KEY` dans l'environnement ou la configuration.

Notes :

- APIs supportés : `openai-completions`, `openai-respones`, `anthropic-messages`,
  `google-generative-ai`
- Utilisez `authHeader: true` + `headers` pour des besoins d'authentification personnalisés.
- Remplacer la configuration root de l'agent avec `OPENCLAW_AGENT_DIR` (ou `PI_CODING_AGENT_DIR`)
  si vous voulez `models.json` stockés ailleurs (par défaut: `~/.openclaw/agents/main/agent`).

### `session`

Contrôle la portée de la session, la politique de réinitialisation, les déclencheurs de réinitialisation et le lieu où la boutique de session est écrite.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    réinitialiser: {
      mode: "daily",
      atHour: 4,
      minutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "inactif", inactifs: 240 },
      groupe: { mode: "inactif", inactifs: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // Par défaut est déjà per-agent sous ~/. penclaw/agents/<agentId>/sessions/sessions.json
    // Vous pouvez remplacer avec {agentId} templating:
    store: "~/. penclaw/agents/{agentId}/sessions/sessions.json",
    // Les chats directs s'effondrent à l'agent:<agentId>:<mainKey> (par défaut: "main").
    clé principale : "main",
    agentToAgent: {
      // Max ping-pong response turns between requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      par défaut : "allow",
    },
  },
}
```

Champs :

- `mainKey`: clé bucket direct-chat (par défaut: `"main"`). Utile lorsque vous voulez « renommer » le fil principal du DM sans changer « agentId ».
  - Note Sandbox : `agents.defaults.sandbox.mode: "non-main"` utilise cette clé pour détecter la session principale. N'importe quelle clé de session qui ne correspond pas à `mainKey` (groups/canaux) est en bac à sable.
- `dmScope`: comment les sessions DM sont regroupées (par défaut: `"main"`).
  - `main`: tous les DMs partagent la session principale pour la continuité.
  - `per-peer`: isoler les DMs par l'id de l'expéditeur à travers les canaux.
  - `per-channel-peer`: isoler les DMs par canal + expéditeur (recommandé pour les boîtes de réception multi-utilisateurs).
  - `per-account-channel-peer`: isoler les DMs par compte + canal + expéditeur (recommandé pour les boîtes de réception multi-comptes).
  - Mode DM sécurisé (recommandé) : définir `session.dmScope: "per-channel-peer"` lorsque plusieurs personnes peuvent DM le bot (boîtes de réception partagées, listes d'autorisations multi-personnes ou `dmPolicy: "open"`).
- `identityLinks`: mapper les identifiants canoniques aux pairs préfixés par le fournisseur afin que la même personne partage une session DM à travers les canaux lors de l'utilisation de `per-peer`, `per-channel-peer`, ou `per-account-channel-peer`.
  - Exemple: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: politique de réinitialisation primaire. La valeur par défaut de réinitialisation quotidienne à 4:00 heure locale sur l'hôte de la passerelle.
  - `mode`: `daily` ou `idle` (par défaut: `daily` quand `reset` est présent).
  - `atHour`: heure locale (0-23) pour la limite quotidienne de réinitialisation.
  - `idleMinutes`: glisser la fenêtre inactive en quelques minutes. Lorsque quotidien + inactivite sont tous deux configures, celui qui expire en premier l’emporte.
- `resetByType`: chaque session remplace `dm`, `group` et `thread`.
  - Si vous ne définissez que les anciens `session.idleMinutes` sans aucun `reset`/`resetByType`, OpenClaw reste en mode idle-only pour une compatibilité ascendante.
- `heartbeatIdleMinutes`: option de remplacement inactif pour les tests de pulsations cardiaques (réinitialisation quotidienne s'applique toujours quand activé).
- `agentToAgent.maxPingPongTurns`: max reply-back turns between requester/target (0–5, default 5).
- `sendPolicy.default`: `allow` ou `deny` quand aucune règle ne correspond.
- `sendPolicy.rules[]`: correspond par `channel`, `chatType` (`direct|group|room`), ou `keyPrefix` (par exemple `cron:`). Premier refus gagne; sinon autoriser.

### `skills` (configuration des compétences)

Contrôle la liste d'autorisations groupée, les préférences d'installation, les dossiers de compétences supplémentaires et les dérogations par compétence
. S'applique aux compétences **groupées** et `~/.openclaw/skills` (compétences de l'espace de travail
gagnent toujours en conflit de noms).

Champs :

- `allowBundled` : liste blanche optionnelle pour les skills **intégrées** uniquement. S’il est défini, seules ces compétences groupées sont éligibles (les compétences gérées/de l’espace de travail ne sont pas affectées).
- `load.extraDirs` : répertoires de Skills supplémentaires à analyser (priorité la plus basse).
- `install.preferBrew` : privilégier les installateurs brew lorsqu’ils sont disponibles (par défaut : true).
- `install.nodeManager`: préférence de l'installateur de node (`npm` | `pnpm` | `yarn`, default: npm).
- `entries.<skillKey>`: substitutions de configuration par compétence.

Champs par Skill :

- `enabled` : définir `false` pour désactiver un Skill même s’il est fourni/installé.
- `env` : variables d’environnement injectées pour l’exécution de l’agent (uniquement si elles ne sont pas déjà définies).
- `apiKey` : commodité optionnelle pour les compétences qui déclarent une var env primaire (par exemple `nano-banane pro` → `GEMINI_API_KEY`).

Exemple :

```json5
{
  compétences: {
    allowBundled: ["gemini", "peekaboo"],
    charge: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projets/oss/some-skill-pack/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager : "npm",
    },
    entrées : {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      Su : { enabled: false },
    },
  },
}
```

### `plugins` (extensions)

Contrôle la découverte de plugins, autoriser/refuser et la configuration par plugin. Les plugins sont chargés
depuis `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, plus toutes les entrées
`plugins.load.paths`. **Les modifications de configuration nécessitent un redémarrage de la passerelle.**
Voir [/plugin](/tools/plugin) pour une utilisation complète.

Champs :

- `enabled`: bascule maître pour le chargement du plugin (par défaut: true).
- `allow`: option allowlist des identifiants de plugins; lorsque défini, seul le chargement des plugins est listé.
- `niy`: refus optionnel des identifiants de plugins (refus de gagne).
- `load.paths`: fichiers ou répertoires supplémentaires à charger (absolus ou `~`).
- `entrées.<pluginId>`: surcharge par plugin.
  - `enabled`: définit `false` pour désactiver.
  - `config` : objet de configuration spécifique au plugin (validé par le plugin si fourni).

Exemple :

```json5
{
  plugins: {
    activé: true,
    allow: ["appel vocal"],
    charge: {
      chemins: ["~/Projects/oss/voice-call-extension"],
    },
    entrées : {
      "appel vocal" : {
        activé : vrai,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (navigateur géré par openclaw)

OpenClaw peut démarrer une instance **dédiée, isolée** Chrome/Brave/Edge/Chromium pour openclaw et exposer un petit service de contrôle de bouclage.
Les profils peuvent pointer vers un navigateur **distant** basé sur Chromium via `profils.<name>.cdpUrl`. Les profils
distants sont en pièces jointes uniquement (démarrer/arrêter/réinitialiser sont désactivés).

`browser.cdpUrl` reste présent pour les configurations mono‑profil héritées et comme schéma/hôte de base pour les profils qui ne définissent que `cdpPort`.

Variables d’environnement + `.env`

- activé: `true`
- evaluateEnabled: `true` (définir `false` pour désactiver `act:evaluate` et `wait --fn`)
- service de contrôle : loopback uniquement (port dérivé de `gateway.port`, valeur par défaut `18791`)
- URL CDP: `http://127.0.0.1:18792` (service de contrôle + 1, profil unique hérité)
- couleur du profil: `#FF4500` (lobster-orange)
- Note: le serveur de contrôle est démarré par la passerelle en cours d'exécution (barre de menus OpenClaw.app ou `passerelle openclaw`).
- Ordre de détection automatique : navigateur par défaut si basé sur Chromium ; sinon Chrome → Brave → Bord → Chromium → Canary Chrome.

```json5
{
  browser: {
    activé: vrai,
    evaluateEnabled: true,
    // cdpUrl: "http://127. 0.0. :18792", // héritage mono-profil surcharge
    defaultProfile: "chrome",
    profils : {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      fonctionne: { cdpPort: 18801, color: "#0066CC" },
      distante : { cdpUrl: "http://10. .0.42:9222", couleur: "#00AA00" },
    },
    couleur: "#FF4500",
    // Avancé:
    // sans tête: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser. pp/Contents/MacOS/Brave Browser",
    // attachSeulement: false, // définit vrai lors du tunneling d'un CDP distant sur localhost
  },
}
```

### `ui` (Apparence)

Couleur d'accentuation optionnelle utilisée par les applications natives pour le chrome de l'interface (ex: teinte de bulle Mode Talk).

Si non défini, les clients retombent à un bleu clair mis en sourdine.

```json5
{
  ui: {
    couture Color: "#FF4500", // hexadécimal (RRGGBB ou #RRGGBB)
    // Optionnel: Contrôle de l'assistant d'identité de l'interface utilisateur.
    // Si non défini, l'interface de contrôle utilise l'identité de l'agent actif (config ou IDENTITY. d).
    assistant : {
      name : "OpenClaw",
      avatar : "CB", // emoji, texte court, ou URI URI
    },
  },
}
```

### `passerelle` (mode serveur Gateway + lier)

Utilisez `gateway.mode` pour déclarer explicitement si cette machine doit exécuter la passerelle.

Équivalent en variable d’environnement :

- mode : **unset** (traité comme “ne pas démarrer automatique”)
- bind: `loopback`
- port: `18789` (port unique pour WS + HTTP)

```json5
{
  gateway: {
    mode : "local", // ou "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/openclaw" }
    // auth: { mode: "token", token: "votre-jeton" } // portes de jeton WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

Contrôler le chemin de base de l'interface :

- `gateway.controlUi.basePath` définit le préfixe d'URL où l'interface de contrôle est servie.
- Exemples: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- Par défaut: root (`/`) (inchangé).
- `gateway.controlUi.root` définit la racine du système de fichiers pour les assets de Control UI (par défaut: `dist/control-ui`).
- `gateway.controlUi.allowInsecureAuth` autorise une authentification par jeton uniquement pour l’UI de contrôle lorsque l’identité de l’appareil est omise (généralement via HTTP). Par défaut: `false`. Préférez HTTPS
  (Tailscale Serve) ou `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` désactive les vérifications d'identité du périphérique pour
  Control UI (jeton/mot de passe uniquement). Par défaut: `false`. Verre de pause seulement.

Documentation connexe :

- [Interface de controle](/web/control-ui)
- [Vue d'ensemble Web](/web)
- [Tailscale](/gateway/tailscale)
- [Acces a distance](/gateway/remote)

Proxys de confiance :

- `gateway.trustedProxies`: liste des adresses IP de proxy inversé qui terminent TLS devant la passerelle.
- Quand une connexion provient d'un de ces IPs, OpenClaw utilise `x-forwarded-for` (ou `x-real-ip`) pour déterminer l'adresse IP du client pour les vérifications locales d'appairage et les vérifications HTTP auth/local.
- Ne listez que les proxys que vous contrôlez entièrement et assurez-vous qu'ils **écrasent** les `x-forwarded-for`.

Remarques :

- `openclaw gateway` refuse de démarrer sauf si `gateway.mode` est défini à `local` (ou si vous passez le paramètre de remplacement).
- `gateway.port` contrôle le seul port multiplexé utilisé pour WebSocket + HTTP (control UI, hooks, A2UI).
- Point de terminaison des compléments de chat OpenAI : **désactivé par défaut**; activez avec `gateway.http.endpoints.chatCompletions.enabled: true`.
- Précédent: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > default `18789`.
- L'authentification de la passerelle est requise par défaut (token/mot de passe ou identité de service en échelle de taille). Les liaisons non-loopback nécessitent un jeton/mot de passe partagé.
- L'assistant d'intégration génère un jeton de passerelle par défaut (même sur le rebouclage).
- `gateway.remote.token` est **uniquement** pour les appels CLI; il n'active pas l'authentification de la passerelle locale. `gateway.token` est ignoré.

Auth and Tailscale :

- `gateway.auth.mode` définit les exigences d'établissement de main (`token` ou `password`). Quand le jeton n'est pas défini, l'authentification est utilisée.
- `gateway.auth.token` stocke le jeton partagé pour l'authentification des jetons (utilisé par le CLI sur la même machine).
- Lorsque `gateway.auth.mode` est défini, seule cette méthode est acceptée (plus des en-têtes optionnels d'échelle de queue).
- `gateway.auth.password` peut être défini ici, ou via `OPENCLAW_GATEWAY_PASSWORD` (recommandé).
- `gateway.auth.allowTailscale` permet aux Tailscale Serve des en-têtes d'identité
  (`tailscale-user-login`) de satisfaire l'authentification lorsque la requête arrive sur loopback
  avec `x-forwarded-for`, `x-forwarded-proto`, et `x-forwarded-host`. OpenClaw
  vérifie l'identité en résolvant l'adresse `x-forwarded-for` via
  `tailscale whois` avant de l'accepter. Lorsqu’il est défini sur `true`, les requêtes Serve n’ont pas besoin de jeton/mot de passe ; définissez `false` pour exiger des identifiants explicites. Par défaut,
  `true` lorsque `tailscale.mode = "serveur"` et le mode d'authentification n'est pas `password`.
- `gateway.tailscale.mode: "serve"` utilise Tailscale Serve (tailnet uniquement, lien loopback).
- `gateway.tailscale.mode: "funnel"` expose le tableau de bord publiquement; nécessite auth.
- `gateway.tailscale.resetOnExit` réinitialise la configuration Serve/Funnel lors de l'extinction.

Client distant par défaut (CLI) :

- `gateway.remote.url` définit l'URL par défaut de passerelle WebSocket pour les appels CLI lorsque `gateway.mode = "remote"`.
- `gateway.remote.transport` sélectionne le transport à distance macOS (`ssh` par défaut, `direct` pour ws/wss). Lorsque `direct`, `gateway.remote.url` doit être `ws://` ou `wss://`. `ws://host` est par défaut le port `18789`.
- `gateway.remote.token` fournit le jeton pour les appels distants (laisser non défini sans authentification).
- `gateway.remote.password` fournit le mot de passe pour les appels distants (laisser vide sans authentification).

Comportement de l'application macOS :

- OpenClaw.app surveille `~/.openclaw/openclaw.json` et communique les modes en direct lorsque `gateway.mode` ou `gateway.remote.url` change.
- Si `gateway.mode` est désactivé, mais `gateway.remote.url` est défini, l'application macOS le traite comme mode distant.
- Lorsque vous changez de mode de connexion dans l'application macOS, il écrit `gateway.mode` (et `gateway.remote.url` + `gateway.remote.transport` en mode distant) dans le fichier de configuration.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "votre-jeton",
      password: "votre-mot de passe",
    },
  },
}
```

Exemple de transport direct (application macOS) :

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload` (Rechargement chaud de la configuration)

La passerelle surveille `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`) et applique les changements automatiquement.

Modes:

- `hybrid` (par défaut) : appliquer des changements sûrs à chaud; redémarrer la passerelle pour les changements critiques.
- `hot`: n'appliquer que les changements à chaud ; log quand un redémarrage est nécessaire.
- `restart` : redémarrez la passerelle en cas de changement de configuration.
- `off`: désactive le rechargement chaud.

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### Matrice de rechargement à chaud (fichiers + impact)

Fichiers surveillés :

- `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)

Appliqué à chaud (pas de redémarrage complet de la passerelle):

- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail watcher redémarré)
- `browser` (redémarrage du serveur de contrôle du navigateur)
- `cron` (redémarrage du service cron + mise à jour simultanée)
- `agents.defaults.heartbeat` (redémarrage du runner du cœur)
- `web` (redémarrage du canal web WhatsApp)
- `telegram`, `discord`, `signal`, `imessage` (redémarrage du canal)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (lectures dynamiques)

Nécessite un redémarrage complet de la passerelle:

- `gateway` (port/bind/auth/control UI/tailscale)
- `bridge` (hérité)
- `découverte `
- `canvasHost`
- `plugins`
- Tout chemin de configuration inconnu/non pris en charge (redémarrage par défaut pour sécurité)

### Isolation multi-instance

Pour exécuter plusieurs passerelles sur un hôte (pour redondance ou un robot de sauvetage), isoler l'état par instance + configuration et utiliser des ports uniques:

- `OPENCLAW_CONFIG_PATH` (configuration par instance)
- `OPENCLAW_STATE_DIR` (sessions/creds)
- `agents.defaults.workspace` (souvenirs)
- `gateway.port` (unique par instance)

Drapeaux de confort (CLI) :

- `openclaw --dev …` → utilise `~/.openclaw-dev` + déplace les ports depuis la base `19001`
- `openclaw --profile <name> …` → utilise `~/.openclaw-<name>` (port via config/env/flags)

Voir [Carnet de passerelle](/gateway) pour le mapping de ports dérivé (passerelle/navigateur/canvas).
Voir [passerelles multiples](/gateway/multiple-gateways) pour plus de détails sur l'isolation du port par navigateur/CDP.

Exemple :

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
passerelle openclaw --port 19001
```

### `hooks` (Gateway webhooks)

Activer un point de terminaison simple du webhook HTTP sur le serveur HTTP de la passerelle.

Paramètres :

- activé: `false`
- chemin : `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  crochets : {
    activé: true,
    token: "shared-secret",
    chemin: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/. penclaw/crochets",
    correspondances : [
      {
        correspondance: { path: "gmail" }, Action
        : "agent",
        wakeMode : "now",
        name : "Gmail",
        sessionKey: "crochete:gmail:{{messages[0].id}}",
        Modèle de message : "De: {{messages[0].from}}\nSujet : {{messages[0].subject}}\n{{messages[0].snippet}}",
        : vrai,
        canal: "last",
        modèle : "openai/gpt-5. -mini",
      },
    ],
  },
}
```

Les requêtes doivent inclure le jeton de crochet :

- `Authorization: Bearer <token>` **ou**
- `x-openclaw-token: <token>`

Points de terminaison :

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → résolu via `hooks.mappings`

`/hooks/agent` publie toujours un résumé dans la session principale (et peut éventuellement déclencher un pulsateur immédiat via \`wakeMode: "now").

Mappage des notes :

- `match.path` correspond au sous-chemin après `/hooks` (par exemple `/hooks/gmail` → `gmail`).
- `match.source` correspond à un champ payload (par exemple `{ source: "gmail" }`) afin que vous puissiez utiliser un chemin générique `/hooks/ingest`.
- Modèles comme `{{messages[0].subject}}` lu depuis le payload.
- `transform` peut pointer vers un module JS/TS qui retourne une action de crochet.
- `deliver: true` envoie la réponse finale à un salon ; `channel` est par défaut `last` (tombe sur WhatsApp).
- S'il n'y a pas de route de livraison préalable, définissez explicitement `channel` + `to` (requis pour Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).
- `model` remplace le LLM pour ce hook run (`provider/model` ou alias; doit être autorisé si `agents.defaults.models` est défini).

Gmail helper config (utilisé par `openclaw webhooks gmail setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Optional: use a cheaper model for Gmail hook processing
      // Falls back to agents.defaults.model.fallbacks, then primary, on auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // Optional: default thinking level for Gmail hooks
      thinking: "off",
    },
  },
}
```

Remplacer le modèle pour les crochets Gmail :

- `hooks.gmail.model` spécifie un modèle à utiliser pour le traitement du hook Gmail (par défaut pour la session primaire).
- Accepte les refs `provider/model` ou les alias de `agents.defaults.models`.
- Falls back to `agents.defaults.model.fallbacks`, then `agents.defaults.model.primary`, on auth/rate-limit/timeouts.
- Si `agents.defaults.models` est défini, inclure le modèle de crochets dans la liste d'autorisations.
- Au démarrage, avertit si le modèle configuré n'est pas dans le catalogue de modèles ou la liste d'autorisations.
- `hooks.gmail.thinking` définit le niveau de pensée par défaut pour les hooks Gmail et est écrasé par per-hook `thinking`.

Démarrage automatique de la passerelle:

- Si `hooks.enabled=true` et `hooks.gmail.account` sont définis, la passerelle démarre
  `gog gmail watch serve` au démarrage et renouvelle automatiquement la montre.
- Définissez `OPENCLAW_SKIP_GMAIL_WATCHER=1` pour désactiver le démarrage automatique (pour les exécutions manuelles).
- Évitez d’exécuter un `gog gmail watch serve` séparé en parallèle du Gateway ; cela échouera avec `listen tcp 127.0.0.1:8788: bind: address already in use`.

Note: lorsque `tailscale.mode` est activé, OpenClaw définit par défaut `serve.path` à `/` afin que
Tailscale puisse proxy `/gmail-pubsub` correctement (il supprime le préfixe set-path).
Si vous avez besoin du backend pour recevoir le chemin préfixé, définissez
`hooks.gmail.tailscale.target` sur une URL complète (et alignez `serve.path`).

### `canvasHost` (LAN/tailnet Canvas file server + reload)

La passerelle sert un répertoire de HTML/CSS/JS via HTTP, donc les nœuds iOS/Android peuvent simplement `canvas.navigate` vers lui.

Racine par défaut: `~/. penclaw/workspace/canvas`  
Port par défaut: `18793` (choisi pour éviter le port CDP du navigateur openclaw `18792`)  
Le serveur écoute sur le **gateway bind host** (LAN ou Tailnet) afin que les nœuds puissent l'atteindre.

Le serveur:

- sert des fichiers dans `canvasHost.root`
- injecte un minuscule client de rechargement en HTML servi
- surveille le répertoire et les diffusions se rechargent sur un point de terminaison WebSocket à `/__openclaw__/ws`
- auto-crée un démarrage `index.html` lorsque le répertoire est vide (donc vous voyez quelque chose immédiatement)
- sert également A2UI à `/__openclaw__/a2ui/` et est annoncé aux nœuds comme `canvasHostUrl`
  (toujours utilisé par les nœuds pour Canvas/A2UI)

Désactiver le rechargement en direct (et la surveillance des fichiers) si le répertoire est volumineux ou si vous appuyez sur `EMFILE`:

- config: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

Les modifications apportées à `canvasHost.*` nécessitent un redémarrage de la passerelle (le rechargement de la configuration va redémarrer).

Désactiver avec :

- config: `canvasHost: { enabled: false }`
- env: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (pont TCP hérité, supprimé)

Les versions actuelles n'incluent plus l'écouteur du pont TCP ; les clés de configuration `bridge.*` sont ignorées.
Les nœuds se connectent sur la passerelle WebSocket. Cette section est conservée pour référence historique.

Comportement hérité :

- La passerelle pourrait exposer un pont TCP simple pour les nœuds (iOS/Android), généralement sur le port `18790`.

Paramètres :

- activé: `true`
- port : `18790`
- bind: `lan` (se lie à `0.0.0.0`)

Bind modes:

- `lan`: `0.0.0.0` (accessible sur n'importe quelle interface, incluant LAN/Wi‐Fi et Tailscale)
- `tailnet`: se lier uniquement à l'IP Tailscale de la machine (recommandé pour Vienne <unk> Londres)
- `loopback`: `127.0.0.1` (local seulement)
- `auto`: préfère tailnet IP si présent, sinon `lan`

TLS:

- `bridge.tls.enabled`: active TLS pour les connexions de passerelles (TLS-only quand activé).
- `bridge.tls.autoGenerate`: génère un certificat auto-signé quand aucune clé n'est présente (par défaut: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: chemins PEM pour le certificat de pont + clé privée.
- `bridge.tls.caPath`: bundle PEM CA optionnel (racines personnalisées ou futur mTLS).

Lorsque TLS est activé, la passerelle annonce `bridgeTls=1` et `bridgeTlsSha256` lors de la découverte des enregistrements TXT
afin que les nœuds puissent épingler le certificat. Les connexions manuelles utilisent une utilisation de confiance en première utilisation si aucune empreinte
n'est encore enregistrée.
Les certificats générés automatiquement nécessitent `openssl` sur PATH; si la génération échoue, le pont de connexion ne démarrera pas.

```json5
{
  pont: {
    activé: vrai,
    port : 18790,
    liaison : "tailnet",
    tls : {
      activé : vrai,
      // Utilise ~/. penclaw/bridge/tls/bridge-{cert,key}. em quand omis.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/. penclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (mode diffusion Bonjour / mDNS)

Contrôle les diffusions de découverte de LAN mDNS (`_openclaw-gw._tcp`).

- `minimal` (par défaut) : omettre `cliPath` + `sshPort` des enregistrements TXT
- `full`: inclure `cliPath` + `sshPort` dans les enregistrements TXT
- `off`: désactiver entièrement les diffusions mDNS
- Nom d'hôte : `openclaw` par défaut (annonce `openclaw.local`). Remplacer par `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  découverte: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‐SD)

Lorsqu'elle est activée, la passerelle écrit une zone DNS-SD unicast pour `_openclaw-gw._tcp` dans `~/.openclaw/dns/` en utilisant le domaine de découverte configuré (exemple: `openclaw.internal.`).

Pour faire découvrir iOS/Android à travers les réseaux (Vienne <unk> Londres), associez ceci avec :

- un serveur DNS sur l'hôte passerelle servant le domaine choisi (CoreDNS est recommandé)
- Facile à **diviser les DNS** pour que les clients résolvent ce domaine via le serveur DNS de passerelle

Assistant de configuration unique (hôte de passerelle):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## Variables de modèle de média

Les espaces réservés au modèle sont étendus dans `tools.media.*.models[].args` et `tools.media.models[].args` (et dans tous les champs d'arguments modèles futurs).

\| Variable | Description |
\| ------------------------------------------------------------------------------- | -------- | ------- | ---------- | ----- | ----- | ------ | -------- | ------- | ------- | | --- |
\| `{{Body}}` | Corps du message entrant |
\| `{{RawBody}}` | Raw corps du message entrant (pas de enveloppe de l'historique/expéditeur; best for command parsing) |
\| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents) |
\| `{{From}}` | Sender identifiant (E. 64 pour WhatsApp ; peut différer par canal) |
\| `{{To}}` | Identifiant de destination |
\| `{{MessageSid}}` | ID de message de canal (lorsque disponible) |
\| `{{SessionId}}` | UUID de la session actuelle |
\| `{{IsNewSession}}` | `"true"` quand une nouvelle session a été créée |
\| `{{MediaUrl}}` | pseudo-URL du média entrant (si présent) |
\| `{{MediaPath}}` | Chemin du média local (si téléchargé) |
\| `{{MediaType}}` | Type de média (image/audio/document/…)                                             |
\| `{{Transcript}}`   | Transcription audio (lorsque activée)                                             |
\| `{{Prompt}}`       | Prompt média résolu pour les entrées CLI                                          |
\| `{{MaxChars}}`     | Nombre maximal de caractères de sortie résolu pour les entrées CLI               |
\| `{{ChatType}}`     | `"direct"` ou `"group"`                                                         |
\| `{{GroupSubject}}` | Sujet du groupe (meilleur effort)                                                 |
\| `{{GroupMembers}}` | Aperçu des membres du groupe (meilleur effort)                                   |
\| `{{SenderName}}`   | Nom d’affichage de l’expéditeur (meilleur effort)                                 |
\| `{{SenderE164}}`   | Numéro de téléphone de l’expéditeur (meilleur effort)                             |
\| `{{Provider}}`     | Indication du fournisseur (whatsapp | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …)
|

## Cron (Planificateur de Gateway)

Cron est un planificateur appartenant à la passerelle pour les réveils et les tâches planifiées. Voir [Tâches Cron](/automation/cron-jobs) pour la vue d'ensemble des fonctionnalités et les exemples de CLI.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_Suivant : [Agent Runtime](/concepts/agent)_ 🦞
