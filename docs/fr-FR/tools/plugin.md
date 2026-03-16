---
summary: "Plugins/extensions OpenClaw : découverte, config et sécurité"
read_when:
  - Ajout ou modification plugins/extensions
  - Documentation installation plugin ou règles chargement
title: "Plugins"
---

# Plugins (Extensions)

## Démarrage rapide (nouveau aux plugins ?)

Un plugin est juste un **petit module code** qui étend OpenClaw avec des fonctionnalités supplémentaires (commandes, outils et RPC Passerelle).

La plupart du temps, vous utiliserez des plugins quand vous voulez une fonctionnalité qui n'est pas encore intégrée au cœur OpenClaw (ou vous voulez garder des fonctionnalités optionnelles hors de votre installation principale).

Chemin rapide :

1. Voir ce qui est déjà chargé :

```bash
openclaw plugins list
```

2. Installer un plugin officiel (exemple : Voice Call) :

```bash
openclaw plugins install @openclaw/voice-call
```

Les specs npm sont **registry-only** (nom package + version/tag optionnel). Les specs Git/URL/file sont rejetées.

3. Redémarrer la Passerelle, puis configurer sous `plugins.entries.<id>.config`.

Voir [Voice Call](/fr-FR/plugins/voice-call) pour un exemple de plugin concret.

## Plugins disponibles (officiels)

- Microsoft Teams est plugin-only depuis 2026.1.15; installez `@openclaw/msteams` si vous utilisez Teams.
- Memory (Core) — plugin mémoire bundled (activé par défaut via `plugins.slots.memory`)
- Memory (LanceDB) — plugin mémoire long-terme bundled (auto-rappel/capture; définir `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/fr-FR/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personnel](/fr-FR/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/fr-FR/channels/matrix) — `@openclaw/matrix`
- [Nostr](/fr-FR/channels/nostr) — `@openclaw/nostr`
- [Zalo](/fr-FR/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/fr-FR/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (auth fournisseur) — bundled comme `google-antigravity-auth` (désactivé par défaut)
- Gemini CLI OAuth (auth fournisseur) — bundled comme `google-gemini-cli-auth` (désactivé par défaut)
- Qwen OAuth (auth fournisseur) — bundled comme `qwen-portal-auth` (désactivé par défaut)
- Copilot Proxy (auth fournisseur) — pont VS Code Copilot Proxy local; distinct du login device `github-copilot` intégré (bundled, désactivé par défaut)

Les plugins OpenClaw sont des **modules TypeScript** chargés à l'exécution via jiti. **La validation config n'exécute pas le code plugin** ; elle utilise le manifeste plugin et JSON Schema à la place. Voir [Manifeste Plugin](/fr-FR/plugins/manifest).

Les plugins peuvent enregistrer :

- Méthodes RPC Passerelle
- Gestionnaires HTTP Passerelle
- Outils Agent
- Commandes CLI
- Services background
- Validation config optionnelle
- **Compétences** (en listant les répertoires `skills` dans le manifeste plugin)
- **Commandes auto-reply** (exécuter sans invoquer l'agent IA)

Les plugins s'exécutent **in-process** avec la Passerelle, donc traitez-les comme du code fiable.
Guide création outils : [Outils agent Plugin](/fr-FR/plugins/agent-tools).

## Helpers runtime

Les plugins peuvent accéder aux helpers core sélectionnés via `api.runtime`. Pour TTS téléphonie :

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Bonjour d'OpenClaw",
  cfg: api.config,
});
```

Notes :

- Utilise la configuration core `messages.tts` (OpenAI ou ElevenLabs).
- Retourne buffer audio PCM + taux échantillonnage. Les plugins doivent rééchantillonner/encoder pour les fournisseurs.
- Edge TTS n'est pas supporté pour téléphonie.

## Découverte & précédence

OpenClaw scanne, dans l'ordre :

1. Chemins config

- `plugins.load.paths` (fichier ou répertoire)

2. Extensions workspace

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extensions globales

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extensions bundled (livrées avec OpenClaw, **désactivées par défaut**)

- `<openclaw>/extensions/*`

Les plugins bundled doivent être activés explicitement via `plugins.entries.<id>.enabled`
ou `openclaw plugins enable <id>`. Les plugins installés sont activés par défaut,
mais peuvent être désactivés de la même manière.

Chaque plugin doit inclure un fichier `openclaw.plugin.json` dans sa racine. Si un chemin
pointe vers un fichier, la racine plugin est le répertoire du fichier et doit contenir le
manifeste.

Si plusieurs plugins résolvent vers le même id, la première correspondance dans l'ordre ci-dessus
gagne et les copies à précédence inférieure sont ignorées.

### Packs package

Un répertoire plugin peut inclure un `package.json` avec `openclaw.extensions` :

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Chaque entrée devient un plugin. Si le pack liste plusieurs extensions, l'id plugin
devient `name/<fileBase>`.

Si votre plugin importe des deps npm, installez-les dans ce répertoire donc
`node_modules` est disponible (`npm install` / `pnpm install`).

Note sécurité : `openclaw plugins install` installe les dépendances plugin avec
`npm install --ignore-scripts` (pas de scripts lifecycle). Gardez l'arbre dépendances plugin
"pur JS/TS" et évitez les packages qui nécessitent des builds `postinstall`.

### Métadonnées catalogue canal

Les plugins canal peuvent annoncer des métadonnées onboarding via `openclaw.channel` et
des hints installation via `openclaw.install`. Cela garde le catalogue core sans données.

Exemple :

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (auto-hébergé)",
      "docsPath": "/fr-FR/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Chat auto-hébergé via bots webhook Nextcloud Talk.",
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

OpenClaw peut aussi fusionner des **catalogues canaux externes** (par exemple, un
export registre MPM). Déposez un fichier JSON à l'un de :

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Ou pointez `OPENCLAW_PLUGIN_CATALOG_PATHS` (ou `OPENCLAW_MPM_CATALOG_PATHS`) vers
un ou plusieurs fichiers JSON (délimités comma/semicolon/`PATH`). Chaque fichier devrait
contenir `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDs Plugin

IDs plugin par défaut :

- Packs package : `name` du `package.json`
- Fichier standalone : nom base fichier (`~/.../voice-call.ts` → `voice-call`)

Si un plugin exporte `id`, OpenClaw l'utilise mais avertit quand il ne correspond pas à l'id
configuré.

## Config

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

- `enabled` : bascule master (défaut : true)
- `allow` : allowlist (optionnel)
- `deny` : denylist (optionnel ; deny gagne)
- `load.paths` : fichiers/dirs plugins supplémentaires
- `entries.<id>` : bascules par plugin + config

Les changements config **nécessitent un redémarrage passerelle**.

Règles validation (strictes) :

- Les ids plugin inconnus dans `entries`, `allow`, `deny` ou `slots` sont des **erreurs**.
- Les clés `channels.<id>` inconnues sont des **erreurs** sauf si un manifeste plugin déclare
  l'id canal.
- La config plugin est validée en utilisant le JSON Schema embarqué dans
  `openclaw.plugin.json` (`configSchema`).
- Si un plugin est désactivé, sa config est préservée et un **avertissement** est émis.

## Slots plugin (catégories exclusives)

Certaines catégories plugin sont **exclusives** (une seule active à la fois). Utilisez
`plugins.slots` pour sélectionner quel plugin possède le slot :

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // ou "none" pour désactiver les plugins mémoire
    },
  },
}
```

Si plusieurs plugins déclarent `kind: "memory"`, seul celui sélectionné charge. Les autres
sont désactivés avec diagnostics.

## Control UI (schéma + labels)

Le Control UI utilise `config.schema` (JSON Schema + `uiHints`) pour rendre de meilleurs formulaires.

OpenClaw augmente `uiHints` à l'exécution basé sur les plugins découverts :

- Ajoute des labels par plugin pour `plugins.entries.<id>` / `.enabled` / `.config`
- Fusionne les hints champ config optionnels fournis par plugin sous :
  `plugins.entries.<id>.config.<field>`

Si vous voulez que vos champs config plugin montrent de bons labels/placeholders (et marquent les secrets comme sensibles),
fournissez `uiHints` à côté de votre JSON Schema dans le manifeste plugin.

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
    "apiKey": { "label": "Clé API", "sensitive": true },
    "region": { "label": "Région", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copier un fichier/dir local dans ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # chemin relatif ok
openclaw plugins install ./plugin.tgz           # installer depuis un tarball local
openclaw plugins install ./plugin.zip           # installer depuis un zip local
openclaw plugins install -l ./extensions/voice-call # link (pas de copie) pour dev
openclaw plugins install @openclaw/voice-call # installer depuis npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` fonctionne uniquement pour les installations npm trackées sous `plugins.installs`.

Les plugins peuvent aussi enregistrer leurs propres commandes top-level (exemple : `openclaw voicecall`).

## API Plugin (aperçu)

Les plugins exportent soit :

- Une fonction : `(api) => { ... }`
- Un objet : `{ id, name, configSchema, register(api) { ... } }`

## Hooks plugin

Les plugins peuvent livrer des hooks et les enregistrer à l'exécution. Cela permet à un plugin d'embarquer
l'automation événementielle sans installation pack hook séparée.

### Exemple

```ts
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notes :

- Les répertoires hook suivent la structure hook normale (`HOOK.md` + `handler.ts`).
- Les règles éligibilité hook s'appliquent toujours (exigences OS/bins/env/config).
- Les hooks gérés par plugin apparaissent dans `openclaw hooks list` avec `plugin:<id>`.
- Vous ne pouvez pas activer/désactiver les hooks gérés par plugin via `openclaw hooks` ; activez/désactivez le plugin à la place.

## Plugins fournisseur (auth modèle)

Les plugins peuvent enregistrer des flux **auth fournisseur modèle** donc les utilisateurs peuvent exécuter OAuth ou
la config clé API à l'intérieur d'OpenClaw (pas de scripts externes nécessaires).

Enregistrez un fournisseur via `api.registerProvider(...)`. Chaque fournisseur expose une
ou plusieurs méthodes auth (OAuth, clé API, code device, etc.). Ces méthodes alimentent :

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
        // Exécuter flux OAuth et retourner profils auth.
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

Notes :

- `run` reçoit un `ProviderAuthContext` avec helpers `prompter`, `runtime`,
  `openUrl` et `oauth.createVpsAwareHandlers`.
- Retournez `configPatch` quand vous avez besoin d'ajouter des modèles par défaut ou config fournisseur.
- Retournez `defaultModel` donc `--set-default` peut mettre à jour les défauts agent.

### Enregistrer un canal messagerie

Les plugins peuvent enregistrer des **plugins canal** qui se comportent comme des canaux intégrés
(WhatsApp, Telegram, etc.). La config canal vit sous `channels.<id>` et est
validée par votre code plugin canal.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/fr-FR/channels/acmechat",
    blurb: "plugin canal démo.",
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

Notes :

- Mettez config sous `channels.<id>` (pas `plugins.entries`).
- `meta.label` est utilisé pour les labels dans les listes CLI/UI.
- `meta.aliases` ajoute des ids alternés pour normalisation et entrées CLI.
- `meta.preferOver` liste les ids canal à sauter auto-enable quand les deux sont configurés.
- `meta.detailLabel` et `meta.systemImage` permettent aux UIs de montrer des labels/icônes canal plus riches.

### Écrire un nouveau canal messagerie (étape par étape)

Utilisez ceci quand vous voulez une **nouvelle surface chat** (un "canal messagerie"), pas un fournisseur modèle.
Les docs fournisseur modèle vivent sous `/fr-FR/providers/*`.

1. Choisir un id + forme config

- Toute config canal vit sous `channels.<id>`.
- Préférez `channels.<id>.accounts.<accountId>` pour setups multi-comptes.

2. Définir les métadonnées canal

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` contrôlent les listes CLI/UI.
- `meta.docsPath` devrait pointer vers une page docs comme `/fr-FR/channels/<id>`.
- `meta.preferOver` permet à un plugin de remplacer un autre canal (auto-enable le préfère).
- `meta.detailLabel` et `meta.systemImage` sont utilisés par les UIs pour texte/icônes détail.

3. Implémenter les adaptateurs requis

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (types chat, média, threads, etc.)
- `outbound.deliveryMode` + `outbound.sendText` (pour envoi basique)

4. Ajouter des adaptateurs optionnels selon besoin

- `setup` (wizard), `security` (politique DM), `status` (santé/diagnostics)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (actions message), `commands` (comportement commande native)

5. Enregistrer le canal dans votre plugin

- `api.registerChannel({ plugin })`

Exemple config minimal :

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

Plugin canal minimal (sortant uniquement) :

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/fr-FR/channels/acmechat",
    blurb: "Canal messagerie AcmeChat.",
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
      // livrer `text` à votre canal ici
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Chargez le plugin (dir extensions ou `plugins.load.paths`), redémarrez la passerelle,
puis configurez `channels.<id>` dans votre config.

### Outils agent

Voir le guide dédié : [Outils agent Plugin](/fr-FR/plugins/agent-tools).

### Enregistrer une méthode RPC passerelle

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
        console.log("Bonjour");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Enregistrer des commandes auto-reply

Les plugins peuvent enregistrer des commandes slash personnalisées qui s'exécutent **sans invoquer l'agent IA**. C'est utile pour les commandes toggle, vérifications statut ou actions rapides qui n'ont pas besoin de traitement LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Afficher statut plugin",
    handler: (ctx) => ({
      text: `Plugin en cours d'exécution ! Canal : ${ctx.channel}`,
    }),
  });
}
```

Contexte handler commande :

- `senderId` : L'ID de l'expéditeur (si disponible)
- `channel` : Le canal où la commande a été envoyée
- `isAuthorizedSender` : Si l'expéditeur est un utilisateur autorisé
- `args` : Arguments passés après la commande (si `acceptsArgs: true`)
- `commandBody` : Le texte commande complet
- `config` : La config OpenClaw actuelle

Options commande :

- `name` : Nom commande (sans le `/` initial)
- `description` : Texte aide affiché dans les listes commandes
- `acceptsArgs` : Si la commande accepte des arguments (défaut : false). Si false et des arguments sont fournis, la commande ne correspondra pas et le message passe à d'autres gestionnaires
- `requireAuth` : Si nécessite expéditeur autorisé (défaut : true)
- `handler` : Fonction qui retourne `{ text: string }` (peut être async)

Exemple avec autorisation et arguments :

```ts
api.registerCommand({
  name: "setmode",
  description: "Définir mode plugin",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode défini à : ${mode}` };
  },
});
```

Notes :

- Les commandes plugin sont traitées **avant** les commandes intégrées et l'agent IA
- Les commandes sont enregistrées globalement et fonctionnent à travers tous les canaux
- Les noms commande sont insensibles à la casse (`/MyStatus` correspond à `/mystatus`)
- Les noms commande doivent commencer par une lettre et contenir uniquement lettres, chiffres, tirets et underscores
- Les noms commande réservés (comme `help`, `status`, `reset`, etc.) ne peuvent pas être remplacés par les plugins
- L'enregistrement commande dupliqué à travers plugins échouera avec une erreur diagnostic

### Enregistrer des services background

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("prêt"),
    stop: () => api.logger.info("au revoir"),
  });
}
```

## Conventions nommage

- Méthodes passerelle : `pluginId.action` (exemple : `voicecall.status`)
- Outils : `snake_case` (exemple : `voice_call`)
- Commandes CLI : kebab ou camel, mais évitez de clasher avec commandes core

## Compétences

Les plugins peuvent livrer une compétence dans le repo (`skills/<name>/SKILL.md`).
Activez-la avec `plugins.entries.<id>.enabled` (ou autres gates config) et assurez-vous
qu'elle est présente dans vos emplacements compétences workspace/gérées.

## Distribution (npm)

Packaging recommandé :

- Package principal : `openclaw` (ce repo)
- Plugins : packages npm séparés sous `@openclaw/*` (exemple : `@openclaw/voice-call`)

Contrat publication :

- Le `package.json` plugin doit inclure `openclaw.extensions` avec un ou plusieurs fichiers entrée.
- Les fichiers entrée peuvent être `.js` ou `.ts` (jiti charge TS à l'exécution).
- `openclaw plugins install <npm-spec>` utilise `npm pack`, extrait dans `~/.openclaw/extensions/<id>/`, et l'active dans config.
- Stabilité clé config : les packages scopés sont normalisés vers l'id **non scopé** pour `plugins.entries.*`.

## Exemple plugin : Voice Call

Ce repo inclut un plugin voice-call (Twilio ou fallback log) :

- Source : `extensions/voice-call`
- Compétence : `skills/voice-call`
- CLI : `openclaw voicecall start|status`
- Outil : `voice_call`
- RPC : `voicecall.start`, `voicecall.status`
- Config (twilio) : `provider: "twilio"` + `twilio.accountSid/authToken/from` (optionnel `statusCallbackUrl`, `twimlUrl`)
- Config (dev) : `provider: "log"` (pas de réseau)

Voir [Voice Call](/fr-FR/plugins/voice-call) et `extensions/voice-call/README.md` pour setup et usage.

## Notes sécurité

Les plugins s'exécutent in-process avec la Passerelle. Traitez-les comme du code fiable :

- Installez uniquement des plugins de confiance.
- Préférez les allowlists `plugins.allow`.
- Redémarrez la Passerelle après changements.

## Tester les plugins

Les plugins peuvent (et devraient) livrer des tests :

- Les plugins in-repo peuvent garder des tests Vitest sous `src/**` (exemple : `src/plugins/voice-call.plugin.test.ts`).
- Les plugins publiés séparément devraient exécuter leur propre CI (lint/build/test) et valider que `openclaw.extensions` pointe vers l'entrypoint built (`dist/index.js`).
