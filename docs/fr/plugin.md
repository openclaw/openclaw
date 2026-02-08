---
summary: "Plugins/extensions OpenClaw : decouverte, configuration et securite"
read_when:
  - Ajout ou modification de plugins/extensions
  - Documentation des regles d’installation ou de chargement des plugins
title: "Plugins"
x-i18n:
  source_path: plugin.md
  source_hash: b36ca6b90ca03eaa
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:03:00Z
---

# Plugins (Extensions)

## Demarrage rapide (nouveau avec les plugins ?)

Un plugin est simplement un **petit module de code** qui etend OpenClaw avec des
fonctionnalites supplementaires (commandes, outils et RPC de la Gateway).

La plupart du temps, vous utiliserez des plugins lorsque vous voulez une
fonctionnalite qui n’est pas encore integree au noyau d’OpenClaw (ou lorsque vous
souhaitez garder des fonctionnalites optionnelles hors de votre installation
principale).

Chemin rapide :

1. Voir ce qui est deja charge :

```bash
openclaw plugins list
```

2. Installer un plugin officiel (exemple : Voice Call) :

```bash
openclaw plugins install @openclaw/voice-call
```

3. Redemarrez la Gateway, puis configurez sous `plugins.entries.<id>.config`.

Voir [Voice Call](/plugins/voice-call) pour un exemple concret de plugin.

## Plugins disponibles (officiels)

- Microsoft Teams est disponible uniquement via plugin depuis le 2026.1.15 ; installez `@openclaw/msteams` si vous utilisez Teams.
- Memory (Core) — plugin de recherche de memoire integre (active par defaut via `plugins.slots.memory`)
- Memory (LanceDB) — plugin de memoire long terme integre (rappel/capture automatiques ; definir `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (authentification fournisseur) — integre sous forme de `google-antigravity-auth` (desactive par defaut)
- Gemini CLI OAuth (authentification fournisseur) — integre sous forme de `google-gemini-cli-auth` (desactive par defaut)
- Qwen OAuth (authentification fournisseur) — integre sous forme de `qwen-portal-auth` (desactive par defaut)
- Copilot Proxy (authentification fournisseur) — pont local VS Code Copilot Proxy ; distinct de la connexion d’appareil `github-copilot` integree (integre, desactive par defaut)

Les plugins OpenClaw sont des **modules TypeScript** charges a l’execution via jiti. **La validation de configuration n’execute pas le code du plugin** ; elle utilise le manifeste du plugin et le schema JSON a la place. Voir [Plugin manifest](/plugins/manifest).

Les plugins peuvent enregistrer :

- Des methodes RPC de la Gateway
- Des gestionnaires HTTP de la Gateway
- Des outils d’agent
- Des commandes CLI
- Des services en arriere-plan
- Une validation de configuration optionnelle
- Des **Skills** (en listant des repertoires `skills` dans le manifeste du plugin)
- Des **commandes de reponse automatique** (executees sans invoquer l’agent IA)

Les plugins s’executent **dans le meme processus** que la Gateway ; traitez-les donc comme du code de confiance.
Guide d’authoring d’outils : [Plugin agent tools](/plugins/agent-tools).

## Assistants d’execution

Les plugins peuvent acceder a certains assistants du noyau via `api.runtime`. Pour le TTS telephonique :

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Notes :

- Utilise la configuration de base `messages.tts` (OpenAI ou ElevenLabs).
- Retourne un tampon audio PCM + un taux d’echantillonnage. Les plugins doivent reechantillonner/encoder pour les fournisseurs.
- Edge TTS n’est pas pris en charge pour la telephonie.

## Decouverte et priorite

OpenClaw analyse, dans l’ordre :

1. Chemins de configuration

- `plugins.load.paths` (fichier ou repertoire)

2. Extensions de l’espace de travail

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extensions globales

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extensions integrees (livrees avec OpenClaw, **desactivees par defaut**)

- `<openclaw>/extensions/*`

Les plugins integres doivent etre actives explicitement via `plugins.entries.<id>.enabled`
ou `openclaw plugins enable <id>`. Les plugins installes sont actives par defaut,
mais peuvent etre desactives de la meme maniere.

Chaque plugin doit inclure un fichier `openclaw.plugin.json` a sa racine. Si un chemin
pointe vers un fichier, la racine du plugin est le repertoire du fichier et doit
contenir le manifeste.

Si plusieurs plugins correspondent au meme id, la premiere correspondance selon
l’ordre ci-dessus l’emporte et les copies de priorite inferieure sont ignorees.

### Lots de packages

Un repertoire de plugin peut inclure un `package.json` avec `openclaw.extensions` :

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Chaque entree devient un plugin. Si le lot liste plusieurs extensions, l’id du
plugin devient `name/<fileBase>`.

Si votre plugin importe des dependances npm, installez-les dans ce repertoire afin
que `node_modules` soit disponible (`npm install` / `pnpm install`).

### Metadonnees du catalogue de canaux

Les plugins de canal peuvent annoncer des metadonnees de prise en main via
`openclaw.channel` et des indications d’installation via `openclaw.install`. Cela
permet de garder le catalogue principal sans donnees.

Exemple :

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

OpenClaw peut egalement fusionner des **catalogues de canaux externes** (par
exemple, une exportation de registre MPM). Deposez un fichier JSON a l’un des
emplacements suivants :

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Ou pointez `OPENCLAW_PLUGIN_CATALOG_PATHS` (ou `OPENCLAW_MPM_CATALOG_PATHS`) vers un ou plusieurs fichiers
JSON (separes par des virgules/points-virgules/`PATH`). Chaque fichier
doit contenir `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDs de plugin

IDs de plugin par defaut :

- Lots de packages : `package.json` `name`
- Fichier autonome : nom de base du fichier (`~/.../voice-call.ts` → `voice-call`)

Si un plugin exporte `id`, OpenClaw l’utilise mais emet un avertissement
lorsqu’il ne correspond pas a l’id configure.

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

Champs :

- `enabled` : interrupteur principal (defaut : true)
- `allow` : liste d’autorisation (optionnelle)
- `deny` : liste de refus (optionnelle ; le refus l’emporte)
- `load.paths` : fichiers/repertoires de plugins supplementaires
- `entries.<id>` : interrupteurs par plugin + configuration

Les changements de configuration **necessitent un redemarrage de la gateway**.

Regles de validation (strictes) :

- Les ids de plugin inconnus dans `entries`, `allow`, `deny`
  ou `slots` sont des **erreurs**.
- Les cles `channels.<id>` inconnues sont des **erreurs** sauf si un manifeste de
  plugin declare l’id de canal.
- La configuration du plugin est validee a l’aide du schema JSON integre dans
  `openclaw.plugin.json` (`configSchema`).
- Si un plugin est desactive, sa configuration est conservee et un **avertissement**
  est emis.

## Emplacements de plugin (categories exclusives)

Certaines categories de plugins sont **exclusives** (un seul actif a la fois).
Utilisez `plugins.slots` pour selectionner le plugin qui possede l’emplacement :

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Si plusieurs plugins declarent `kind: "memory"`, seul celui selectionne est charge.
Les autres sont desactives avec des diagnostics.

## UI de controle (schema + libelles)

L’UI de controle utilise `config.schema` (schema JSON + `uiHints`) pour
rendre de meilleurs formulaires.

OpenClaw enrichit `uiHints` a l’execution en fonction des plugins decouverts :

- Ajoute des libelles par plugin pour `plugins.entries.<id>` / `.enabled` /
  `.config`
- Fusionne les indications de champs de configuration optionnelles fournies par
  les plugins sous :
  `plugins.entries.<id>.config.<field>`

Si vous souhaitez que les champs de configuration de votre plugin affichent de
bons libelles/placeholders (et que les secrets soient marques comme sensibles),
fournissez `uiHints` a cote de votre schema JSON dans le manifeste du plugin.

Exemple :

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

`plugins update` fonctionne uniquement pour les installations npm suivies sous
`plugins.installs`.

Les plugins peuvent egalement enregistrer leurs propres commandes de premier
niveau (exemple : `openclaw voicecall`).

## API de plugin (vue d’ensemble)

Les plugins exportent soit :

- Une fonction : `(api) => { ... }`
- Un objet : `{ id, name, configSchema, register(api) { ... } }`

## Hooks de plugin

Les plugins peuvent fournir des hooks et les enregistrer a l’execution. Cela
permet a un plugin d’embarquer une automatisation evenementielle sans installer
un pack de hooks separe.

### Exemple

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notes :

- Les repertoires de hooks suivent la structure normale des hooks
  (`HOOK.md` + `handler.ts`).
- Les regles d’eligibilite des hooks s’appliquent toujours (OS/bins/env/exigences
  de configuration).
- Les hooks geres par des plugins apparaissent dans `openclaw hooks list` avec
  `plugin:<id>`.
- Vous ne pouvez pas activer/desactiver les hooks geres par des plugins via
  `openclaw hooks` ; activez/desactivez plutot le plugin.

## Plugins de fournisseur (authentification de modele)

Les plugins peuvent enregistrer des flux **d’authentification de fournisseur de
modele** afin que les utilisateurs puissent executer la configuration OAuth ou
par cle API directement dans OpenClaw (aucun script externe requis).

Enregistrez un fournisseur via `api.registerProvider(...)`. Chaque fournisseur expose une ou
plusieurs methodes d’authentification (OAuth, cle API, code d’appareil, etc.).
Ces methodes alimentent :

- `openclaw models auth login --provider <id> [--method <id>]`

Exemple :

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

Notes :

- `run` recoit un `ProviderAuthContext` avec les assistants `prompter`,
  `runtime`, `openUrl` et `oauth.createVpsAwareHandlers`.
- Retournez `configPatch` lorsque vous devez ajouter des modeles par defaut ou
  une configuration de fournisseur.
- Retournez `defaultModel` afin que `--set-default` puisse mettre a jour les
  valeurs par defaut de l’agent.

### Enregistrer un canal de messagerie

Les plugins peuvent enregistrer des **plugins de canal** qui se comportent comme
des canaux integres (WhatsApp, Telegram, etc.). La configuration du canal se trouve
sous `channels.<id>` et est validee par le code de votre plugin de canal.

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

Notes :

- Placez la configuration sous `channels.<id>` (et non `plugins.entries`).
- `meta.label` est utilise pour les libelles dans les listes CLI/UI.
- `meta.aliases` ajoute des ids alternatifs pour la normalisation et les entrees
  CLI.
- `meta.preferOver` liste les ids de canal a ignorer pour l’auto-activation lorsque
  les deux sont configures.
- `meta.detailLabel` et `meta.systemImage` permettent aux UI d’afficher des libelles/
  icones de canal plus riches.

### Ecrire un nouveau canal de messagerie (pas a pas)

Utilisez ceci lorsque vous souhaitez une **nouvelle surface de chat** (un
« canal de messagerie »), et non un fournisseur de modele. La documentation sur
les fournisseurs de modele se trouve sous `/providers/*`.

1. Choisir un id + une forme de configuration

- Toute la configuration de canal se trouve sous `channels.<id>`.
- Preferez `channels.<id>.accounts.<accountId>` pour les configurations multi-comptes.

2. Definir les metadonnees du canal

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` controlent
  les listes CLI/UI.
- `meta.docsPath` doit pointer vers une page de documentation comme
  `/channels/<id>`.
- `meta.preferOver` permet a un plugin de remplacer un autre canal (l’auto-activation
  le privilegie).
- `meta.detailLabel` et `meta.systemImage` sont utilises par les UI pour le texte de
  detail et les icones.

3. Implementer les adaptateurs requis

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (types de chat, medias, fils, etc.)
- `outbound.deliveryMode` + `outbound.sendText` (pour l’envoi de base)

4. Ajouter des adaptateurs optionnels selon les besoins

- `setup` (assistant), `security` (politique de DM),
  `status` (sante/diagnostics)
- `gateway` (demarrage/arret/connexion), `mentions`,
  `threading`, `streaming`
- `actions` (actions sur les messages), `commands`
  (comportement des commandes natives)

5. Enregistrer le canal dans votre plugin

- `api.registerChannel({ plugin })`

Exemple de configuration minimale :

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

Plugin de canal minimal (sortant uniquement) :

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

Chargez le plugin (repertoire d’extensions ou `plugins.load.paths`), redemarrez la
gateway, puis configurez `channels.<id>` dans votre configuration.

### Outils d’agent

Voir le guide dedie : [Plugin agent tools](/plugins/agent-tools).

### Enregistrer une methode RPC de la gateway

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

### Enregistrer des commandes de reponse automatique

Les plugins peuvent enregistrer des commandes slash personnalisees qui s’executent
**sans invoquer l’agent IA**. C’est utile pour des commandes de bascule, des
verifications d’etat ou des actions rapides qui ne necessitent pas de traitement
LLM.

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

Contexte du gestionnaire de commandes :

- `senderId` : l’id de l’expediteur (si disponible)
- `channel` : le canal ou la commande a ete envoyee
- `isAuthorizedSender` : si l’expediteur est un utilisateur autorise
- `args` : les arguments passes apres la commande (si `acceptsArgs: true`)
- `commandBody` : le texte complet de la commande
- `config` : la configuration OpenClaw actuelle

Options de commande :

- `name` : nom de la commande (sans le prefixe `/`)
- `description` : texte d’aide affiche dans les listes de commandes
- `acceptsArgs` : si la commande accepte des arguments (defaut : false). Si false
  et que des arguments sont fournis, la commande ne correspond pas et le message
  est transmis aux autres gestionnaires
- `requireAuth` : si l’expediteur autorise est requis (defaut : true)
- `handler` : fonction qui retourne `{ text: string }` (peut etre async)

Exemple avec autorisation et arguments :

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

Notes :

- Les commandes de plugin sont traitees **avant** les commandes integrees et
  l’agent IA
- Les commandes sont enregistrees globalement et fonctionnent sur tous les canaux
- Les noms de commande sont insensibles a la casse (`/MyStatus` correspond a
  `/mystatus`)
- Les noms de commande doivent commencer par une lettre et ne contenir que des
  lettres, chiffres, tirets et underscores
- Les noms de commande reserves (comme `help`, `status`,
  `reset`, etc.) ne peuvent pas etre remplaces par des plugins
- L’enregistrement de commandes en double entre plugins echouera avec une erreur
  de diagnostic

### Enregistrer des services en arriere-plan

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

- Methodes de la Gateway : `pluginId.action` (exemple : `voicecall.status`)
- Outils : `snake_case` (exemple : `voice_call`)
- Commandes CLI : kebab ou camel, mais evitez les collisions avec les commandes du
  noyau

## Skills

Les plugins peuvent fournir une skill dans le repo (`skills/<name>/SKILL.md`).
Activez-la avec `plugins.entries.<id>.enabled` (ou d’autres portes de configuration) et assurez-
vous qu’elle est presente dans vos emplacements de skills de l’espace de travail/
geres.

## Distribution (npm)

Packaging recommande :

- Package principal : `openclaw` (ce repo)
- Plugins : packages npm separes sous `@openclaw/*` (exemple : `@openclaw/voice-call`)

Contrat de publication :

- Le `package.json` du plugin doit inclure `openclaw.extensions` avec un ou plusieurs
  fichiers d’entree.
- Les fichiers d’entree peuvent etre `.js` ou `.ts` (jiti
  charge le TS a l’execution).
- `openclaw plugins install <npm-spec>` utilise `npm pack`, extrait dans `~/.openclaw/extensions/<id>/` et
  l’active dans la configuration.
- Stabilite des cles de configuration : les packages scopes sont normalises vers
  l’id **non scope** pour `plugins.entries.*`.

## Exemple de plugin : Voice Call

Ce repo inclut un plugin d’appel vocal (Twilio ou fallback de journalisation) :

- Source : `extensions/voice-call`
- Skill : `skills/voice-call`
- CLI : `openclaw voicecall start|status`
- Outil : `voice_call`
- RPC : `voicecall.start`, `voicecall.status`
- Configuration (twilio) : `provider: "twilio"` + `twilio.accountSid/authToken/from` (optionnel :
  `statusCallbackUrl`, `twimlUrl`)
- Configuration (dev) : `provider: "log"` (pas de reseau)

Voir [Voice Call](/plugins/voice-call) et `extensions/voice-call/README.md` pour l’installation et
l’utilisation.

## Notes de securite

Les plugins s’executent dans le meme processus que la Gateway. Traitez-les comme
du code de confiance :

- N’installez que des plugins auxquels vous faites confiance.
- Preferez les listes d’autorisation `plugins.allow`.
- Redemarrez la Gateway apres les changements.

## Tester les plugins

Les plugins peuvent (et devraient) fournir des tests :

- Les plugins dans le repo peuvent conserver des tests Vitest sous
  `src/**` (exemple : `src/plugins/voice-call.plugin.test.ts`).
- Les plugins publies separement devraient executer leur propre CI
  (lint/build/test) et valider que `openclaw.extensions` pointe vers le point d’entree
  construit (`dist/index.js`).
