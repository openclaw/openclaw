---
summary: "Hooks : automatisation pilotée par événements pour les commandes et les événements du cycle de vie"
read_when:
  - Vous voulez une automatisation pilotée par événements pour /new, /reset, /stop et les événements du cycle de vie de l’agent
  - Vous voulez créer, installer ou déboguer des hooks
title: "Hooks"
---

# Hooks

Les hooks fournissent un système extensible piloté par événements pour automatiser des actions en réponse aux commandes et aux événements de l’agent. Les hooks sont automatiquement découverts à partir de répertoires et peuvent être gérés via des commandes CLI, de manière similaire au fonctionnement des Skills dans OpenClaw.

## Getting Oriented

Les hooks sont de petits scripts qui s’exécutent lorsqu’un événement se produit. Il en existe deux types :

- **Hooks** (cette page) : s’exécutent à l’intérieur de la Gateway (passerelle) lorsque des événements d’agent se déclenchent, comme `/new`, `/reset`, `/stop`, ou des événements du cycle de vie.
- **Webhooks** : webhooks HTTP externes permettant à d’autres systèmes de déclencher du travail dans OpenClaw. Voir [Webhook Hooks](/automation/webhook) ou utiliser `openclaw webhooks` pour les commandes d’assistance Gmail.

Les hooks peuvent également être regroupés dans des plugins ; voir [Plugins](/tools/plugin#plugin-hooks).

Utilisations courantes :

- Enregistrer un instantané de mémoire lorsque vous réinitialisez une session
- Conserver une piste d’audit des commandes pour le dépannage ou la conformité
- Déclencher des automatisations de suivi lorsqu’une session démarre ou se termine
- Écrire des fichiers dans l’espace de travail de l’agent ou appeler des API externes lorsque des événements se produisent

Si vous savez écrire une petite fonction TypeScript, vous pouvez écrire un hook. Les hooks sont découverts automatiquement, et vous les activez ou désactivez via la CLI.

## Overview

Le système de hooks vous permet de :

- Enregistrer le contexte de session en mémoire lorsque `/new` est émis
- Journaliser toutes les commandes à des fins d’audit
- Déclencher des automatisations personnalisées lors des événements du cycle de vie de l’agent
- Étendre le comportement d’OpenClaw sans modifier le code cœur

## Getting Started

### Bundled Hooks

OpenClaw est livré avec quatre hooks intégrés qui sont automatiquement découverts :

- **💾 session-memory** : enregistre le contexte de session dans l’espace de travail de votre agent (par défaut `~/.openclaw/workspace/memory/`) lorsque vous émettez `/new`
- **📝 command-logger** : journalise tous les événements de commande dans `~/.openclaw/logs/commands.log`
- **🚀 boot-md** : exécute `BOOT.md` lorsque la gateway (passerelle) démarre (nécessite l’activation des hooks internes)
- **😈 soul-evil** : remplace le contenu injecté `SOUL.md` par `SOUL_EVIL.md` pendant une fenêtre de purge ou de manière aléatoire

Lister les hooks disponibles :

```bash
openclaw hooks list
```

Activer un hook :

```bash
openclaw hooks enable session-memory
```

Vérifier l’état d’un hook :

```bash
openclaw hooks check
```

Obtenir des informations détaillées :

```bash
openclaw hooks info session-memory
```

### Onboarding

Lors de la prise en main (`openclaw onboard`), il vous sera proposé d’activer les hooks recommandés. L’assistant découvre automatiquement les hooks éligibles et vous les présente pour sélection.

## Hook Discovery

Les hooks sont automatiquement découverts à partir de trois répertoires (par ordre de priorité) :

1. **Hooks d’espace de travail** : `<workspace>/hooks/` (par agent, priorité la plus élevée)
2. **Hooks gérés** : `~/.openclaw/hooks/` (installés par l’utilisateur, partagés entre les espaces de travail)
3. **Hooks intégrés** : `<openclaw>/dist/hooks/bundled/` (fournis avec OpenClaw)

Les répertoires de hooks gérés peuvent être soit un **hook unique**, soit un **pack de hooks** (répertoire de package).

Chaque hook est un répertoire contenant :

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

Les packs de hooks sont des packages npm standards qui exportent un ou plusieurs hooks via `openclaw.hooks` dans
`package.json`. Installez-les avec :

```bash
openclaw hooks install <path-or-spec>
```

Exemple de `package.json` :

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
Les packs de hooks peuvent inclure des dépendances ; elles seront installées sous `~/.openclaw/hooks/<id>`.

## Hook Structure

### HOOK.md Format

Le fichier `HOOK.md` contient des métadonnées en frontmatter YAML ainsi que de la documentation Markdown :

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

### Metadata Fields

L’objet `metadata.openclaw` prend en charge :

- **`emoji`** : emoji d’affichage pour la CLI (par ex. `"💾"`)
- **`events`** : tableau d’événements à écouter (par ex. `["command:new", "command:reset"]`)
- **`export`** : export nommé à utiliser (par défaut `"default"`)
- **`homepage`** : URL de documentation
- **`requires`** : exigences optionnelles
  - **`bins`** : binaires requis sur le PATH (par ex. `["git", "node"]`)
  - **`anyBins`** : au moins un de ces binaires doit être présent
  - **`env`** : variables d’environnement requises
  - **`config`** : chemins de configuration requis (par ex. `["workspace.dir"]`)
  - **`os`** : plateformes requises (par ex. `["darwin", "linux"]`)
- **`always`** : contourner les vérifications d’éligibilité (booléen)
- **`install`** : méthodes d’installation (pour les hooks intégrés : `[{"id":"bundled","kind":"bundled"}]`)

### Handler Implementation

Le fichier `handler.ts` exporte une fonction `HookHandler` :

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

#### Event Context

Chaque événement inclut :

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

## Event Types

### Command Events

Déclenchés lorsque des commandes de l’agent sont émises :

- **`command`** : tous les événements de commande (écouteur général)
- **`command:new`** : lorsque la commande `/new` est émise
- **`command:reset`** : lorsque la commande `/reset` est émise
- **`command:stop`** : lorsque la commande `/stop` est émise

### Agent Events

- **`agent:bootstrap`** : avant que les fichiers de bootstrap de l’espace de travail ne soient injectés (les hooks peuvent modifier `context.bootstrapFiles`)

### Gateway Events

Déclenchés lorsque la gateway (passerelle) démarre :

- **`gateway:startup`** : après le démarrage des canaux et le chargement des hooks

### Tool Result Hooks (Plugin API)

Ces hooks ne sont pas des écouteurs de flux d’événements ; ils permettent aux plugins d’ajuster de manière synchrone les résultats des outils avant qu’OpenClaw ne les persiste.

- **`tool_result_persist`** : transformer les résultats des outils avant qu’ils ne soient écrits dans la transcription de session. Doit être synchrone ; retourner la charge utile du résultat d’outil mise à jour ou `undefined` pour la conserver telle quelle. Voir [Agent Loop](/concepts/agent-loop).

### Future Events

Types d’événements planifiés :

- **`session:start`** : lorsqu’une nouvelle session commence
- **`session:end`** : lorsqu’une session se termine
- **`agent:error`** : lorsqu’un agent rencontre une erreur
- **`message:sent`** : lorsqu’un message est envoyé
- **`message:received`** : lorsqu’un message est reçu

## Creating Custom Hooks

### 1. Choose Location

- **Hooks d’espace de travail** (`<workspace>/hooks/`) : par agent, priorité la plus élevée
- **Hooks gérés** (`~/.openclaw/hooks/`) : partagés entre les espaces de travail

### 2. Create Directory Structure

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Create HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Create handler.ts

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

### 5. Enable and Test

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

### New Config Format (Recommended)

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

### Per-Hook Configuration

Les hooks peuvent avoir une configuration personnalisée :

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

### Extra Directories

Charger des hooks depuis des répertoires supplémentaires :

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

### Legacy Config Format (Still Supported)

L’ancien format de configuration fonctionne toujours pour assurer la rétrocompatibilité :

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

**Migration** : utilisez le nouveau système basé sur la découverte pour les nouveaux hooks. Les handlers hérités sont chargés après les hooks basés sur des répertoires.

## CLI Commands

### List Hooks

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

### Hook Information

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Check Eligibility

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Enable/Disable

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Bundled hook reference

### session-memory

Enregistre le contexte de session en mémoire lorsque vous émettez `/new`.

**Events** : `command:new`

**Requirements** : `workspace.dir` doit être configuré

**Output** : `<workspace>/memory/YYYY-MM-DD-slug.md` (par défaut `~/.openclaw/workspace`)

**What it does** :

1. Utilise l’entrée de session pré-réinitialisation pour localiser la transcription correcte
2. Extrait les 15 dernières lignes de la conversation
3. Utilise un LLM pour générer un slug de nom de fichier descriptif
4. Enregistre les métadonnées de session dans un fichier de mémoire daté

**Example output** :

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Filename examples** :

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (horodatage de secours si la génération du slug échoue)

**Enable** :

```bash
openclaw hooks enable session-memory
```

### command-logger

Journalise tous les événements de commande dans un fichier d’audit centralisé.

**Events** : `command`

**Requirements** : Aucun

**Output** : `~/.openclaw/logs/commands.log`

**What it does** :

1. Capture les détails de l’événement (action de commande, horodatage, clé de session, ID de l’expéditeur, source)
2. Ajoute au fichier de log au format JSONL
3. S’exécute silencieusement en arrière-plan

**Example log entries** :

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**View logs** :

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Enable** :

```bash
openclaw hooks enable command-logger
```

### soul-evil

Remplace le contenu injecté `SOUL.md` par `SOUL_EVIL.md` pendant une fenêtre de purge ou de manière aléatoire.

**Events** : `agent:bootstrap`

**Docs** : [SOUL Evil Hook](/hooks/soul-evil)

**Output** : Aucun fichier écrit ; les échanges se font uniquement en mémoire.

**Enable** :

```bash
openclaw hooks enable soul-evil
```

**Config** :

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

Exécute `BOOT.md` lorsque la gateway (passerelle) démarre (après le démarrage des canaux).
Les hooks internes doivent être activés pour que cela s’exécute.

**Events** : `gateway:startup`

**Requirements** : `workspace.dir` doit être configuré

**What it does** :

1. Lit `BOOT.md` depuis votre espace de travail
2. Exécute les instructions via l’agent runner
3. Envoie tout message sortant demandé via l’outil de messagerie

**Enable** :

```bash
openclaw hooks enable boot-md
```

## Best Practices

### Keep Handlers Fast

Les hooks s’exécutent pendant le traitement des commandes. Gardez-les légers :

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

### Handle Errors Gracefully

Encapsulez toujours les opérations risquées :

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

### Filter Events Early

Retournez tôt si l’événement n’est pas pertinent :

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Use Specific Event Keys

Spécifiez des événements précis dans les métadonnées lorsque c’est possible :

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

Plutôt que :

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugging

### Enable Hook Logging

La gateway (passerelle) journalise le chargement des hooks au démarrage :

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Check Discovery

Lister tous les hooks découverts :

```bash
openclaw hooks list --verbose
```

### Check Registration

Dans votre handler, journalisez lorsqu’il est appelé :

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Verify Eligibility

Vérifiez pourquoi un hook n’est pas éligible :

```bash
openclaw hooks info my-hook
```

Recherchez les exigences manquantes dans la sortie.

## Testing

### Gateway Logs

Surveillez les logs de la gateway pour voir l’exécution des hooks :

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Test Hooks Directly

Testez vos handlers de manière isolée :

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

### Core Components

- **`src/hooks/types.ts`** : définitions de types
- **`src/hooks/workspace.ts`** : analyse et chargement des répertoires
- **`src/hooks/frontmatter.ts`** : analyse des métadonnées HOOK.md
- **`src/hooks/config.ts`** : vérification de l’éligibilité
- **`src/hooks/hooks-status.ts`** : reporting de statut
- **`src/hooks/loader.ts`** : chargeur de modules dynamique
- **`src/cli/hooks-cli.ts`** : commandes CLI
- **`src/gateway/server-startup.ts`** : charge les hooks au démarrage de la gateway
- **`src/auto-reply/reply/commands-core.ts`** : déclenche les événements de commande

### Discovery Flow

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

### Event Flow

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

## Troubleshooting

### Hook Not Discovered

1. Vérifiez la structure des répertoires :

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Vérifiez le format de HOOK.md :

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Listez tous les hooks découverts :

   ```bash
   openclaw hooks list
   ```

### Hook Not Eligible

Vérifiez les exigences :

```bash
openclaw hooks info my-hook
```

Recherche manquante :

- Binaires (vérifiez le PATH)
- Variables d’environnement
- Valeurs de configuration
- Compatibilité du système d’exploitation

### Hook Not Executing

1. Vérifiez que le hook est activé :

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Redémarrez le processus de la gateway afin que les hooks soient rechargés.

3. Vérifiez les logs de la gateway pour des erreurs :

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handler Errors

Vérifiez les erreurs TypeScript/import :

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migration Guide

### From Legacy Config to Discovery

**Avant** :

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

**Après** :

1. Créez le répertoire du hook :

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Créez HOOK.md :

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Mettez à jour la configuration :

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

4. Vérifiez et redémarrez le processus de la gateway :

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Avantages de la migration** :

- Découverte automatique
- Gestion via la CLI
- Vérification de l’éligibilité
- Meilleure documentation
- Structure cohérente

## See Also

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
