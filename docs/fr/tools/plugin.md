---
summary: "Plugins/extensions OpenClaw : découverte, configuration et sécurité"
read_when:
  - Ajout ou modification de plugins/extensions
  - Documentation des règles d’installation ou de chargement des plugins
title: "Plugins"
---

# Plugins (Extensions)

## Démarrage rapide (nouveau sur les plugins ?)

Un plugin est simplement un **petit module de code** qui étend OpenClaw avec des
fonctionnalités supplémentaires (commandes, outils et RPC de la Gateway (passerelle)).

La plupart du temps, vous utiliserez des plugins lorsque vous souhaitez une fonctionnalité
qui n’est pas encore intégrée au cœur d’OpenClaw (ou lorsque vous voulez conserver des
fonctionnalités optionnelles hors de votre installation principale).

Chemin rapide :

1. Voir ce qui est déjà chargé :

```bash
openclaw plugins list
```

2. Installer un plugin officiel (exemple : Voice Call) :

```bash
openclaw plugins install @openclaw/voice-call
```

3. Redémarrez la Gateway (passerelle), puis configurez sous `plugins.entries.<id>.config`.

Voir [Voice Call](/plugins/voice-call) pour un exemple concret de plugin.

## Plugins disponibles (officiels)

- Microsoft Teams est uniquement disponible via plugin depuis le 15/01/2026 ; installez `@openclaw/msteams` si vous utilisez Teams.
- Memory (Core) — plugin de recherche de mémoire groupé (activé par défaut via `plugins.slots.memory`)
- Memory (LanceDB) — plugin de mémoire long terme groupé (rappel/capture automatiques ; définir `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (authentification fournisseur) — groupé en tant que `google-antigravity-auth` (désactivé par défaut)
- Gemini CLI OAuth (authentification fournisseur) — groupé en tant que `google-gemini-cli-auth` (désactivé par défaut)
- Qwen OAuth (authentification fournisseur) — groupé en tant que `qwen-portal-auth` (désactivé par défaut)
- Copilot Proxy (authentification fournisseur) — pont local VS Code Copilot Proxy ; distinct de la connexion intégrée `github-copilot` par appareil (groupé, désactivé par défaut)

Les plugins OpenClaw sont des **modules TypeScript** chargés à l’exécution via jiti. La **validation de configuration n’exécute pas le code du plugin** ; elle utilise le manifeste du plugin et le schéma JSON à la place. Voir [Plugin manifest](/plugins/manifest).

Les plugins peuvent enregistrer :

- Des méthodes RPC de la Gateway (passerelle)
- Des gestionnaires HTTP de la Gateway (passerelle)
- Des outils d’agent
- Des commandes CLI
- Des services en arrière-plan
- Une validation de configuration optionnelle
- Des **Skills** (en listant des répertoires `skills` dans le manifeste du plugin)
- Des **commandes de réponse automatique** (exécutées sans invoquer l’agent IA)

Les plugins s’exécutent **dans le même processus** que la Gateway (passerelle) ; traitez-les donc comme du code de confiance.
Guide de création d’outils : [Plugin agent tools](/plugins/agent-tools).

## Aides à l’exécution

Les plugins peuvent accéder à certaines aides du cœur via `api.runtime`. Pour la synthèse vocale (TTS) téléphonique :

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Remarques :

- Utilise la configuration centrale `messages.tts` (OpenAI ou ElevenLabs).
- Retourne un tampon audio PCM + un taux d’échantillonnage. Les plugins doivent rééchantillonner/encoder pour les fournisseurs.
- Edge TTS n’est pas pris en charge pour la téléphonie.

## Découverte et priorité

OpenClaw analyse, dans l’ordre :

1. Chemins de configuration

- `plugins.load.paths` (fichier ou répertoire)

2. Extensions de l’espace de travail

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extensions globales

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extensions groupées (livrées avec OpenClaw, **désactivées par défaut**)

- `<openclaw>/extensions/*`

Les plugins groupés doivent être activés explicitement via `plugins.entries.<id>.enabled`
ou `openclaw plugins enable <id>`. Les plugins installés sont activés par défaut,
mais peuvent être désactivés de la même manière.

Chaque plugin doit inclure un fichier `openclaw.plugin.json` à sa racine. Si un chemin
pointe vers un fichier, la racine du plugin est le répertoire du fichier et doit
contenir le manifeste.

Si plusieurs plugins se résolvent vers le même id, la première correspondance
selon l’ordre ci-dessus l’emporte et les copies de priorité inférieure sont ignorées.

### Package packs

Un répertoire de plugin peut inclure un `package.json` avec `openclaw.extensions` :

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Chaque entrée devient un plugin. Si le pack liste plusieurs extensions, l’id du plugin
devient `name/<fileBase>`.

Si votre plugin importe des dépendances npm, installez-les dans ce répertoire afin que
`node_modules` soit disponible (`npm install` / `pnpm install`).

### Métadonnées du catalogue de canaux

Les plugins de canal peuvent annoncer des métadonnées de prise en main via `openclaw.channel` et
des indications d’installation via `openclaw.install`. Cela permet de garder le catalogue central sans données.

Exemple :

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw peut également fusionner des **catalogues de canaux externes** (par exemple, un export de registre MPM). Déposez un fichier JSON à l’un des emplacements suivants :

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Ou pointez `OPENCLAW_PLUGIN_CATALOG_PATHS` (ou `OPENCLAW_MPM_CATALOG_PATHS`) vers
un ou plusieurs fichiers JSON (délimités par des virgules/points-virgules/`PATH`). Chaque fichier doit
contenir `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDs de plugin

IDs de plugin par défaut :

- Package packs : `package.json` `name`
- Fichier autonome : nom de base du fichier (`~/.../voice-call.ts` → `voice-call`)

Si un plugin exporte `id`, OpenClaw l’utilise mais avertit lorsqu’il ne correspond pas à l’id configuré.

## Configuration

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Champs :

- `enabled` : interrupteur principal (par défaut : true)
- `allow` : liste d’autorisation (optionnelle)
- `deny` : liste de refus (optionnelle ; le refus l’emporte)
- `load.paths` : fichiers/répertoires de plugins supplémentaires
- `entries.<id>` : interrupteurs par plugin + configuration

Les modifications de configuration **nécessitent un redémarrage de la gateway (passerelle)**.

Règles de validation (strictes) :

- Les ids de plugin inconnus dans `entries`, `allow`, `deny` ou `slots` sont des **erreurs**.
- Les clés `channels.<id>` inconnues sont des **erreurs**, sauf si un manifeste de plugin déclare
  l’id de canal.
- La configuration du plugin est validée à l’aide du schéma JSON intégré dans
  `openclaw.plugin.json` (`configSchema`).
- Si un plugin est désactivé, sa configuration est conservée et un **avertissement** est émis.

## Emplacements de plugin (catégories exclusives)

Certaines catégories de plugins sont **exclusives** (une seule active à la fois). Utilisez
`plugins.slots` pour sélectionner quel plugin possède l’emplacement :

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Si plusieurs plugins déclarent `kind: "memory"`, seul celui sélectionné est chargé. Les autres
sont désactivés avec des diagnostics.

## Interface de contrôle (schéma + libellés)

L’interface de contrôle utilise `config.schema` (schéma JSON + `uiHints`) pour afficher de meilleurs formulaires.

OpenClaw enrichit `uiHints` à l’exécution en fonction des plugins découverts :

- Ajoute des libellés par plugin pour `plugins.entries.<id>` / `.enabled` / `.config`
- Fusionne des indications de champs de configuration optionnelles fournies par les plugins sous :
  `plugins.entries.<id>.config.<field>`

Si vous souhaitez que les champs de configuration de votre plugin affichent de bons libellés/espaces réservés
(et marquent les secrets comme sensibles), fournissez `uiHints` à côté de votre schéma JSON
dans le manifeste du plugin.

Exemple :

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` fonctionne uniquement pour les installations npm suivies sous `plugins.installs`.

Les plugins peuvent également enregistrer leurs propres commandes de premier niveau (exemple : `openclaw voicecall`).

## API de plugin (aperçu)

Les plugins exportent soit :

- Une fonction : `(api) => { ... }`
- Un objet : `{ id, name, configSchema, register(api) { ... } }`

## Hooks de plugin

Les plugins peuvent fournir des hooks et les enregistrer à l’exécution. Cela permet à un plugin
d’intégrer une automatisation pilotée par événements sans installation séparée de pack de hooks.

### Exemple

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Remarques :

- Les répertoires de hooks suivent la structure normale des hooks (`HOOK.md` + `handler.ts`).
- Les règles d’éligibilité des hooks s’appliquent toujours (OS/binaires/variables d'environnement/exigences de configuration).
- Les hooks gérés par des plugins apparaissent dans `openclaw hooks list` avec `plugin:<id>`.
- Vous ne pouvez pas activer/désactiver les hooks gérés par des plugins via `openclaw hooks` ; activez/désactivez le plugin à la place.

## Plugins de fournisseur (authentification de modèle)

Les plugins peuvent enregistrer des flux **d’authentification de fournisseur de modèle** afin que les utilisateurs puissent exécuter
la configuration OAuth ou par clé API dans OpenClaw (sans scripts externes).

Enregistrez un fournisseur via `api.registerProvider(...)`. Chaque fournisseur expose une
ou plusieurs méthodes d’authentification (OAuth, clé API, code appareil, etc.). Ces méthodes alimentent :

- `openclaw models auth login --provider <id> [--method <id>]`

Exemple :

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

Remarques :

- `run` reçoit un `ProviderAuthContext` avec des aides `prompter`, `runtime`,
  `openUrl` et `oauth.createVpsAwareHandlers`.
- Retournez `configPatch` lorsque vous devez ajouter des modèles par défaut ou une configuration de fournisseur.
- Retournez `defaultModel` afin que `--set-default` puisse mettre à jour les valeurs par défaut de l’agent.

### Enregistrer un canal de messagerie

Les plugins peuvent enregistrer des **plugins de canal** qui se comportent comme des canaux intégrés
(WhatsApp, Telegram, etc.). La configuration du canal se trouve sous `channels.<id>` et est
validée par le code de votre plugin de canal.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Remarques :

- Placez la configuration sous `channels.<id>` (pas `plugins.entries`).
- `meta.label` est utilisé pour les libellés dans les listes CLI/UI.
- `meta.aliases` ajoute des ids alternatifs pour la normalisation et les entrées CLI.
- `meta.preferOver` liste les ids de canal à ignorer pour l’activation automatique lorsque les deux sont configurés.
- `meta.detailLabel` et `meta.systemImage` permettent aux interfaces d’afficher des libellés/icônes de canal plus riches.

### Écrire un nouveau canal de messagerie (étape par étape)

Utilisez ceci lorsque vous souhaitez une **nouvelle surface de discussion** (un « canal de messagerie »), et non un fournisseur de modèle.
La documentation des fournisseurs de modèle se trouve sous `/providers/*`.

1. Choisir un id + une forme de configuration

- Toute la configuration du canal se trouve sous `channels.<id>`.
- Préférez `channels.<id>.accounts.<accountId>` pour les configurations multi‑comptes.

2. Définir les métadonnées du canal

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` contrôlent les listes CLI/UI.
- `meta.docsPath` doit pointer vers une page de documentation comme `/channels/<id>`.
- `meta.preferOver` permet à un plugin de remplacer un autre canal (l’activation automatique le privilégie).
- `meta.detailLabel` et `meta.systemImage` sont utilisés par les interfaces pour le texte/icônes de détail.

3. Implémenter les adaptateurs requis

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (types de chat, médias, fils, etc.)
- `outbound.deliveryMode` + `outbound.sendText` (pour l’envoi de base)

4. Ajouter des adaptateurs optionnels selon les besoins

- `setup` (assistant), `security` (politique de message privé), `status` (santé/diagnostics)
- `gateway` (démarrer/arrêter/connexion), `mentions`, `threading`, `streaming`
- `actions` (actions sur les messages), `commands` (comportement des commandes natives)

5. Enregistrer le canal dans votre plugin

- `api.registerChannel({ plugin })`

Exemple de configuration minimale :

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Plugin de canal minimal (sortant uniquement) :

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Chargez le plugin (répertoire d’extensions ou `plugins.load.paths`), redémarrez la gateway (passerelle),
puis configurez `channels.<id>` dans votre configuration.

### Outils d’agent

Voir le guide dédié : [Plugin agent tools](/plugins/agent-tools).

### Enregistrer une méthode RPC de la gateway (passerelle)

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Enregistrer des commandes CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Enregistrer des commandes de réponse automatique

Les plugins peuvent enregistrer des commandes slash personnalisées qui s’exécutent **sans invoquer l’agent IA**. C’est utile pour les commandes de bascule, les vérifications d’état ou les actions rapides qui ne nécessitent pas de traitement par LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Contexte du gestionnaire de commande :

- `senderId` : l’id de l’expéditeur (si disponible)
- `channel` : le canal où la commande a été envoyée
- `isAuthorizedSender` : si l’expéditeur est un utilisateur autorisé
- `args` : arguments passés après la commande (si `acceptsArgs: true`)
- `commandBody` : le texte complet de la commande
- `config` : la configuration OpenClaw actuelle

Options de commande :

- `name` : nom de la commande (sans le `/` initial)
- `description` : texte d’aide affiché dans les listes de commandes
- `acceptsArgs` : indique si la commande accepte des arguments (par défaut : false). Si false et que des arguments sont fournis, la commande ne correspondra pas et le message sera transmis aux autres gestionnaires
- `requireAuth` : indique s’il faut exiger un expéditeur autorisé (par défaut : true)
- `handler` : fonction qui retourne `{ text: string }` (peut être async)

Exemple avec autorisation et arguments :

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Remarques :

- Les commandes de plugin sont traitées **avant** les commandes intégrées et l’agent IA
- Les commandes sont enregistrées globalement et fonctionnent sur tous les canaux
- Les noms de commande sont insensibles à la casse (`/MyStatus` correspond à `/mystatus`)
- Les noms de commande doivent commencer par une lettre et ne contenir que des lettres, chiffres, tirets et underscores
- Les noms de commande réservés (comme `help`, `status`, `reset`, etc.) ne peuvent pas être redéfinis par des plugins
- L’enregistrement de commandes en double entre plugins échouera avec une erreur de diagnostic

### Enregistrer des services en arrière-plan

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Conventions de nommage

- Méthodes de la Gateway (passerelle) : `pluginId.action` (exemple : `voicecall.status`)
- Outils : `snake_case` (exemple : `voice_call`)
- Commandes CLI : kebab ou camel, mais évitez les conflits avec les commandes du cœur

## Skills

Les plugins peuvent fournir un skill dans le dépôt (`skills/<name>/SKILL.md`).
Activez-le avec `plugins.entries.<id>.enabled` (ou d’autres verrous de configuration) et assurez-vous
qu’il est présent dans les emplacements de skills de votre espace de travail/skills gérés.

## Distribution (npm)

Conditionnement recommandé :

- Paquet principal : `openclaw` (ce dépôt)
- Plugins : paquets npm séparés sous `@openclaw/*` (exemple : `@openclaw/voice-call`)

Contrat de publication :

- Le `package.json` du plugin doit inclure `openclaw.extensions` avec un ou plusieurs fichiers d’entrée.
- Les fichiers d’entrée peuvent être `.js` ou `.ts` (jiti charge TS à l’exécution).
- `openclaw plugins install <npm-spec>` utilise `npm pack`, extrait dans `~/.openclaw/extensions/<id>/` et l’active dans la configuration.
- Stabilité des clés de configuration : les paquets scopés sont normalisés vers l’id **non scopé** pour `plugins.entries.*`.

## Exemple de plugin : Voice Call

Ce dépôt inclut un plugin d’appel vocal (Twilio ou repli sur journalisation) :

- Source : `extensions/voice-call`
- Skill : `skills/voice-call`
- CLI : `openclaw voicecall start|status`
- Outil : `voice_call`
- RPC : `voicecall.start`, `voicecall.status`
- Configuration (twilio) : `provider: "twilio"` + `twilio.accountSid/authToken/from` (`statusCallbackUrl`, `twimlUrl` optionnels)
- Configuration (dev) : `provider: "log"` (sans réseau)

Voir [Voice Call](/plugins/voice-call) et `extensions/voice-call/README.md` pour l’installation et l’utilisation.

## Remarques de sécurité

Les plugins s’exécutent dans le même processus que la Gateway (passerelle). Traitez-les comme du code de confiance :

- N’installez que des plugins de confiance.
- Préférez les listes d’autorisation `plugins.allow`.
- Redémarrez la Gateway (passerelle) après les modifications.

## Tester les plugins

Les plugins peuvent (et doivent) fournir des tests :

- Les plugins dans le dépôt peuvent conserver des tests Vitest sous `src/**` (exemple : `src/plugins/voice-call.plugin.test.ts`).
- Les plugins publiés séparément doivent exécuter leur propre CI (lint/build/test) et valider que `openclaw.extensions` pointe vers le point d’entrée compilé (`dist/index.js`).
