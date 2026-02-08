---
summary: "Hooks : automatisation pilotée par événements pour les commandes et les événements du cycle de vie"
read_when:
  - Vous souhaitez une automatisation pilotée par événements pour /new, /reset, /stop et les événements du cycle de vie des agents
  - Vous souhaitez créer, installer ou déboguer des hooks
title: "Hooks"
x-i18n:
  source_path: hooks.md
  source_hash: 853227a0f1abd207
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:09Z
---

# Hooks

Les hooks fournissent un système extensible, piloté par événements, pour automatiser des actions en réponse aux commandes et aux événements des agents. Les hooks sont automatiquement découverts à partir de répertoires et peuvent être gérés via des commandes CLI, de la même manière que les Skills dans OpenClaw.

## Pour bien démarrer

Les hooks sont de petits scripts qui s’exécutent lorsqu’un événement se produit. Il en existe deux types :

- **Hooks** (cette page) : s’exécutent à l’intérieur du Gateway (passerelle) lorsque des événements d’agent se déclenchent, comme `/new`, `/reset`, `/stop`, ou des événements du cycle de vie.
- **Webhooks** : webhooks HTTP externes qui permettent à d’autres systèmes de déclencher du travail dans OpenClaw. Voir [Webhook Hooks](/automation/webhook) ou utiliser `openclaw webhooks` pour les commandes d’assistance Gmail.

Les hooks peuvent également être regroupés dans des plugins ; voir [Plugins](/plugin#plugin-hooks).

Cas d’usage courants :

- Enregistrer un instantané de mémoire lorsque vous réinitialisez une session
- Conserver une piste d’audit des commandes pour le dépannage ou la conformité
- Déclencher des automatisations de suivi lorsqu’une session commence ou se termine
- Écrire des fichiers dans l’espace de travail de l’agent ou appeler des API externes lorsque des événements se produisent

Si vous savez écrire une petite fonction TypeScript, vous pouvez écrire un hook. Les hooks sont découverts automatiquement, et vous les activez ou désactivez via la CLI.

## Vue d’ensemble

Le système de hooks vous permet de :

- Enregistrer le contexte de session en mémoire lorsque `/new` est émis
- Journaliser toutes les commandes à des fins d’audit
- Déclencher des automatisations personnalisées lors des événements du cycle de vie des agents
- Étendre le comportement d’OpenClaw sans modifier le code principal

## Premiers pas

### Hooks intégrés

OpenClaw est livré avec quatre hooks intégrés qui sont automatiquement découverts :

- **💾 session-memory** : enregistre le contexte de session dans l’espace de travail de votre agent (par défaut `~/.openclaw/workspace/memory/`) lorsque vous émettez `/new`
- **📝 command-logger** : journalise tous les événements de commande dans `~/.openclaw/logs/commands.log`
- **🚀 boot-md** : exécute `BOOT.md` lorsque le gateway démarre (nécessite l’activation des hooks internes)
- **😈 soul-evil** : remplace le contenu injecté `SOUL.md` par `SOUL_EVIL.md` pendant une fenêtre de purge ou de manière aléatoire

Lister les hooks disponibles :

```bash
openclaw hooks list
```

Activer un hook :

```bash
openclaw hooks enable session-memory
```

Vérifier l’état d’un hook :

```bash
openclaw hooks check
```

Obtenir des informations détaillées :

```bash
openclaw hooks info session-memory
```

### Prise en main

Pendant la prise en main (`openclaw onboard`), il vous sera proposé d’activer des hooks recommandés. L’assistant découvre automatiquement les hooks éligibles et les présente pour sélection.

## Découverte des hooks

Les hooks sont automatiquement découverts à partir de trois répertoires (par ordre de priorité) :

1. **Hooks d’espace de travail** : `<workspace>/hooks/` (par agent, priorité la plus élevée)
2. **Hooks gérés** : `~/.openclaw/hooks/` (installés par l’utilisateur, partagés entre les espaces de travail)
3. **Hooks intégrés** : `<openclaw>/dist/hooks/bundled/` (fournis avec OpenClaw)

Les répertoires de hooks gérés peuvent être soit un **hook unique**, soit un **pack de hooks** (répertoire de package).

Chaque hook est un répertoire contenant :

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Packs de hooks (npm/archives)

Les packs de hooks sont des packages npm standards qui exportent un ou plusieurs hooks via `openclaw.hooks` dans
`package.json`. Installez-les avec :

```bash
openclaw hooks install <path-or-spec>
```

Exemple de `package.json` :

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Chaque entrée pointe vers un répertoire de hook contenant `HOOK.md` et `handler.ts` (ou `index.ts`).
Les packs de hooks peuvent inclure des dépendances ; elles seront installées sous `~/.openclaw/hooks/<id>`.

## Structure d’un hook

### Format HOOK.md

Le fichier `HOOK.md` contient des métadonnées en frontmatter YAML ainsi qu’une documentation Markdown :

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Champs de métadonnées

L’objet `metadata.openclaw` prend en charge :

- **`emoji`** : emoji d’affichage pour la CLI (par ex. `"💾"`)
- **`events`** : tableau des événements à écouter (par ex. `["command:new", "command:reset"]`)
- **`export`** : export nommé à utiliser (par défaut `"default"`)
- **`homepage`** : URL de documentation
- **`requires`** : exigences optionnelles
  - **`bins`** : binaires requis dans le PATH (par ex. `["git", "node"]`)
  - **`anyBins`** : au moins un de ces binaires doit être présent
  - **`env`** : variables d'environnement requises
  - **`config`** : chemins de configuration requis (par ex. `["workspace.dir"]`)
  - **`os`** : plateformes requises (par ex. `["darwin", "linux"]`)
- **`always`** : contourner les vérifications d’éligibilité (booléen)
- **`install`** : méthodes d’installation (pour les hooks intégrés : `[{"id":"bundled","kind":"bundled"}]`)

### Implémentation du handler

Le fichier `handler.ts` exporte une fonction `HookHandler` :

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### Contexte d’événement

Chaque événement inclut :

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Types d’événements

### Événements de commande

Déclenchés lorsque des commandes d’agent sont émises :

- **`command`** : tous les événements de commande (écouteur général)
- **`command:new`** : lorsque la commande `/new` est émise
- **`command:reset`** : lorsque la commande `/reset` est émise
- **`command:stop`** : lorsque la commande `/stop` est émise

### Événements d’agent

- **`agent:bootstrap`** : avant l’injection des fichiers de bootstrap de l’espace de travail (les hooks peuvent modifier `context.bootstrapFiles`)

### Événements du Gateway

Déclenchés lorsque le gateway démarre :

- **`gateway:startup`** : après le démarrage des canaux et le chargement des hooks

### Hooks de résultat d’outil (API de plugin)

Ces hooks ne sont pas des écouteurs de flux d’événements ; ils permettent aux plugins d’ajuster de manière synchrone les résultats des outils avant qu’OpenClaw ne les persiste.

- **`tool_result_persist`** : transformer les résultats d’outil avant qu’ils ne soient écrits dans la transcription de session. Doit être synchrone ; retourner la charge utile de résultat d’outil mise à jour ou `undefined` pour la conserver telle quelle. Voir [Agent Loop](/concepts/agent-loop).

### Événements futurs

Types d’événements prévus :

- **`session:start`** : lorsqu’une nouvelle session commence
- **`session:end`** : lorsqu’une session se termine
- **`agent:error`** : lorsqu’un agent rencontre une erreur
- **`message:sent`** : lorsqu’un message est envoyé
- **`message:received`** : lorsqu’un message est reçu

## Création de hooks personnalisés

### 1. Choisir l’emplacement

- **Hooks d’espace de travail** (`<workspace>/hooks/`) : par agent, priorité la plus élevée
- **Hooks gérés** (`~/.openclaw/hooks/`) : partagés entre les espaces de travail

### 2. Créer la structure de répertoires

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Créer HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Créer handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 5. Activer et tester

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Configuration

### Nouveau format de configuration (recommandé)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Configuration par hook

Les hooks peuvent avoir une configuration personnalisée :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Répertoires supplémentaires

Charger des hooks à partir de répertoires supplémentaires :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Ancien format de configuration (toujours pris en charge)

L’ancien format de configuration fonctionne toujours pour assurer la rétrocompatibilité :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**Migration** : utilisez le nouveau système basé sur la découverte pour les nouveaux hooks. Les handlers hérités sont chargés après les hooks basés sur des répertoires.

## Commandes CLI

### Lister les hooks

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Informations sur un hook

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Vérifier l’éligibilité

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Activer/Désactiver

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Hooks intégrés

### session-memory

Enregistre le contexte de session en mémoire lorsque vous émettez `/new`.

**Événements** : `command:new`

**Exigences** : `workspace.dir` doit être configuré

**Sortie** : `<workspace>/memory/YYYY-MM-DD-slug.md` (par défaut `~/.openclaw/workspace`)

**Ce qu’il fait** :

1. Utilise l’entrée de session pré-réinitialisation pour localiser la transcription correcte
2. Extrait les 15 dernières lignes de la conversation
3. Utilise un LLM pour générer un slug de nom de fichier descriptif
4. Enregistre les métadonnées de session dans un fichier de mémoire daté

**Exemple de sortie** :

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Exemples de noms de fichiers** :

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (horodatage de secours si la génération du slug échoue)

**Activer** :

```bash
openclaw hooks enable session-memory
```

### command-logger

Journalise tous les événements de commande dans un fichier d’audit centralisé.

**Événements** : `command`

**Exigences** : aucune

**Sortie** : `~/.openclaw/logs/commands.log`

**Ce qu’il fait** :

1. Capture les détails de l’événement (action de commande, horodatage, clé de session, ID de l’expéditeur, source)
2. Ajoute les entrées au fichier de log au format JSONL
3. S’exécute silencieusement en arrière-plan

**Exemples d’entrées de log** :

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Consulter les logs** :

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Activer** :

```bash
openclaw hooks enable command-logger
```

### soul-evil

Remplace le contenu injecté `SOUL.md` par `SOUL_EVIL.md` pendant une fenêtre de purge ou de manière aléatoire.

**Événements** : `agent:bootstrap`

**Docs** : [SOUL Evil Hook](/hooks/soul-evil)

**Sortie** : aucun fichier écrit ; les remplacements se produisent uniquement en mémoire.

**Activer** :

```bash
openclaw hooks enable soul-evil
```

**Configuration** :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

Exécute `BOOT.md` lorsque le gateway démarre (après le démarrage des canaux).
Les hooks internes doivent être activés pour que cela s’exécute.

**Événements** : `gateway:startup`

**Exigences** : `workspace.dir` doit être configuré

**Ce qu’il fait** :

1. Lit `BOOT.md` depuis votre espace de travail
2. Exécute les instructions via l’exécuteur d’agent
3. Envoie tous les messages sortants demandés via l’outil de messagerie

**Activer** :

```bash
openclaw hooks enable boot-md
```

## Bonnes pratiques

### Garder les handlers rapides

Les hooks s’exécutent pendant le traitement des commandes. Gardez-les légers :

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Gérer les erreurs avec élégance

Encapsulez toujours les opérations risquées :

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Filtrer les événements tôt

Retournez immédiatement si l’événement n’est pas pertinent :

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Utiliser des clés d’événement spécifiques

Spécifiez des événements exacts dans les métadonnées lorsque c’est possible :

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

Plutôt que :

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Débogage

### Activer la journalisation des hooks

Le gateway journalise le chargement des hooks au démarrage :

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Vérifier la découverte

Lister tous les hooks découverts :

```bash
openclaw hooks list --verbose
```

### Vérifier l’enregistrement

Dans votre handler, journalisez lorsqu’il est appelé :

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Vérifier l’éligibilité

Vérifiez pourquoi un hook n’est pas éligible :

```bash
openclaw hooks info my-hook
```

Recherchez les exigences manquantes dans la sortie.

## Tests

### Logs du Gateway

Surveillez les logs du gateway pour voir l’exécution des hooks :

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Tester les hooks directement

Testez vos handlers de manière isolée :

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## Architecture

### Composants principaux

- **`src/hooks/types.ts`** : définitions de types
- **`src/hooks/workspace.ts`** : analyse et chargement des répertoires
- **`src/hooks/frontmatter.ts`** : analyse des métadonnées HOOK.md
- **`src/hooks/config.ts`** : vérification de l’éligibilité
- **`src/hooks/hooks-status.ts`** : rapport d’état
- **`src/hooks/loader.ts`** : chargeur de modules dynamique
- **`src/cli/hooks-cli.ts`** : commandes CLI
- **`src/gateway/server-startup.ts`** : charge les hooks au démarrage du gateway
- **`src/auto-reply/reply/commands-core.ts`** : déclenche les événements de commande

### Flux de découverte

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Flux d’événements

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Dépannage

### Hook non découvert

1. Vérifiez la structure des répertoires :

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Vérifiez le format de HOOK.md :

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Listez tous les hooks découverts :
   ```bash
   openclaw hooks list
   ```

### Hook non éligible

Vérifiez les exigences :

```bash
openclaw hooks info my-hook
```

Recherchez les éléments manquants :

- Binaires (vérifiez le PATH)
- Variables d'environnement
- Valeurs de configuration
- Compatibilité du système d’exploitation

### Hook non exécuté

1. Vérifiez que le hook est activé :

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Redémarrez votre processus de gateway afin que les hooks se rechargent.

3. Vérifiez les logs du gateway pour les erreurs :
   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Erreurs de handler

Vérifiez les erreurs TypeScript/d’import :

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Guide de migration

### De l’ancienne configuration à la découverte

**Avant** :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**Après** :

1. Créez le répertoire du hook :

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Créez HOOK.md :

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Mettez à jour la configuration :

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Vérifiez et redémarrez votre processus de gateway :
   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Avantages de la migration** :

- Découverte automatique
- Gestion via la CLI
- Vérification de l’éligibilité
- Meilleure documentation
- Structure cohérente

## Voir aussi

- [Référence CLI : hooks](/cli/hooks)
- [README des hooks intégrés](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
