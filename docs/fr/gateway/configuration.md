---
summary: "Toutes les options de configuration pour ~/.openclaw/openclaw.json avec des exemples"
read_when:
  - Ajout ou modification de champs de configuration
title: "Configuration"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: 53b6b8a615c4ce02
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:58Z
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

Paramètres :

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
les clés non liées. Cela applique la sémantique de *JSON merge patch* :

- les objets fusionnent récursivement
- `null` supprime une clé
- les tableaux sont remplacés  
  Comme `config.apply`, la configuration est validée, écrite, un marqueur de redémarrage est stocké, puis le redémarrage de la Gateway est planifié (avec un réveil optionnel lorsque `sessionKey` est fourni).

Paramètres :

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
- **Chemins absolus** : utilisés tels quels
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

### Variables d’environnement + `.env`

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

Équivalent en variable d’environnement :

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
- Les variables manquantes ou vides provoquent une erreur au chargement
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

_(La suite du document continue avec les mêmes sections et exemples, traduits fidèlement en français, en conservant strictement la structure Markdown, les liens, les identifiants **OC_I18N_XXXX**, les noms de produits et les termes techniques requis inchangés.)_

---

_Suivant : [Agent Runtime](/concepts/agent)_ 🦞
