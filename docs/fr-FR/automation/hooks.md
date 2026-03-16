---
summary: "Hooks : automatisation événementielle pour les commandes et événements de cycle de vie"
read_when:
  - Vous voulez une automatisation événementielle pour /new, /reset, /stop, et les événements de cycle de vie d'agent
  - Vous voulez construire, installer ou déboguer des hooks
title: "Hooks"
---

# Hooks

Les Hooks fournissent un système événementiel extensible pour automatiser des actions en réponse aux commandes et événements d'agent. Les hooks sont automatiquement découverts depuis les répertoires et peuvent être gérés via les commandes CLI, de manière similaire aux compétences dans OpenClaw.

## S'orienter

Les hooks sont de petits scripts qui s'exécutent quand quelque chose se produit. Il existe deux types :

- **Hooks** (cette page) : s'exécutent à l'intérieur de la Passerelle quand des événements d'agent se déclenchent, comme `/new`, `/reset`, `/stop`, ou des événements de cycle de vie.
- **Webhooks** : webhooks HTTP externes qui permettent à d'autres systèmes de déclencher du travail dans OpenClaw. Voir [Webhooks](/fr-FR/automation/webhook) ou utilisez `openclaw webhooks` pour les commandes d'aide Gmail.

Les hooks peuvent aussi être regroupés à l'intérieur de plugins ; voir [Plugins](/fr-FR/tools/plugin#plugin-hooks).

Usages courants :

- Sauvegarder un instantané de mémoire quand vous réinitialisez une session
- Conserver une piste d'audit des commandes pour le dépannage ou la conformité
- Déclencher une automatisation de suivi quand une session démarre ou se termine
- Écrire des fichiers dans l'espace de travail de l'agent ou appeler des APIs externes quand des événements se déclenchent

Si vous pouvez écrire une petite fonction TypeScript, vous pouvez écrire un hook. Les hooks sont découverts automatiquement, et vous les activez ou désactivez via la CLI.

## Vue d'ensemble

Le système de hooks vous permet de :

- Sauvegarder le contexte de session en mémoire quand `/new` est émis
- Journaliser toutes les commandes pour l'audit
- Déclencher des automatisations personnalisées sur les événements de cycle de vie d'agent
- Étendre le comportement d'OpenClaw sans modifier le code principal

## Démarrage

### Hooks intégrés

OpenClaw est livré avec quatre hooks intégrés qui sont automatiquement découverts :

- **💾 session-memory** : Sauvegarde le contexte de session dans votre espace de travail d'agent (par défaut `~/.openclaw/workspace/memory/`) quand vous émettez `/new`
- **📎 bootstrap-extra-files** : Injecte des fichiers de bootstrap d'espace de travail supplémentaires depuis des motifs glob/chemin configurés pendant `agent:bootstrap`
- **📝 command-logger** : Journalise tous les événements de commande dans `~/.openclaw/logs/commands.log`
- **🚀 boot-md** : Exécute `BOOT.md` quand la passerelle démarre (nécessite les hooks internes activés)

Lister les hooks disponibles :

```bash
openclaw hooks list
```

Activer un hook :

```bash
openclaw hooks enable session-memory
```

Vérifier le statut des hooks :

```bash
openclaw hooks check
```

Obtenir des informations détaillées :

```bash
openclaw hooks info session-memory
```

### Onboarding

Pendant l'onboarding (`openclaw onboard`), vous serez invité à activer les hooks recommandés. L'assistant découvre automatiquement les hooks éligibles et les présente pour sélection.

## Découverte de hooks

Les hooks sont automatiquement découverts depuis trois répertoires (par ordre de précédence) :

1. **Hooks d'espace de travail** : `<workspace>/hooks/` (par agent, précédence la plus haute)
2. **Hooks gérés** : `~/.openclaw/hooks/` (installés par l'utilisateur, partagés entre espaces de travail)
3. **Hooks intégrés** : `<openclaw>/dist/hooks/bundled/` (livrés avec OpenClaw)

Les répertoires de hooks gérés peuvent être soit un **hook unique** soit un **pack de hooks** (répertoire de package).

Chaque hook est un répertoire contenant :

```
my-hook/
├── HOOK.md          # Métadonnées + documentation
└── handler.ts       # Implémentation du gestionnaire
```

## Packs de hooks (npm/archives)

Les packs de hooks sont des packages npm standard qui exportent un ou plusieurs hooks via `openclaw.hooks` dans
`package.json`. Installez-les avec :

```bash
openclaw hooks install <path-or-spec>
```

Les specs npm sont uniquement pour le registre (nom de package + version/tag optionnel). Les specs Git/URL/fichier sont rejetées.

Exemple `package.json` :

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
Les packs de hooks peuvent livrer des dépendances ; elles seront installées sous `~/.openclaw/hooks/<id>`.

Note de sécurité : `openclaw hooks install` installe les dépendances avec `npm install --ignore-scripts`
(pas de scripts de cycle de vie). Gardez les arbres de dépendances des packs de hooks "pur JS/TS" et évitez les packages qui dépendent
de builds `postinstall`.

## Structure de hook

### Format HOOK.md

Le fichier `HOOK.md` contient des métadonnées en frontmatter YAML plus de la documentation Markdown :

```markdown
---
name: my-hook
description: "Brève description de ce que fait ce hook"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# Mon Hook

La documentation détaillée va ici...

## Ce qu'il fait

- Écoute les commandes `/new`
- Effectue une action
- Journalise le résultat

## Prérequis

- Node.js doit être installé

## Configuration

Aucune configuration nécessaire.
```

### Champs de métadonnées

L'objet `metadata.openclaw` supporte :

- **`emoji`** : Emoji d'affichage pour la CLI (ex., `"💾"`)
- **`events`** : Tableau d'événements à écouter (ex., `["command:new", "command:reset"]`)
- **`export`** : Export nommé à utiliser (par défaut `"default"`)
- **`homepage`** : URL de documentation
- **`requires`** : Prérequis optionnels
  - **`bins`** : Binaires requis dans PATH (ex., `["git", "node"]`)
  - **`anyBins`** : Au moins un de ces binaires doit être présent
  - **`env`** : Variables d'environnement requises
  - **`config`** : Chemins de config requis (ex., `["workspace.dir"]`)
  - **`os`** : Plateformes requises (ex., `["darwin", "linux"]`)
- **`always`** : Contourne les vérifications d'éligibilité (booléen)
- **`install`** : Méthodes d'installation (pour les hooks intégrés : `[{"id":"bundled","kind":"bundled"}]`)

### Implémentation du gestionnaire

Le fichier `handler.ts` exporte une fonction `HookHandler` :

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Ne se déclenche que sur la commande 'new'
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] Commande new déclenchée`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Horodatage: ${event.timestamp.toISOString()}`);

  // Votre logique personnalisée ici

  // Optionnel : envoyer un message à l'utilisateur
  event.messages.push("✨ Mon hook s'est exécuté !");
};

export default myHandler;
```

#### Contexte d'événement

Chaque événement inclut :

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // ex., 'new', 'reset', 'stop'
  sessionKey: string,          // Identifiant de session
  timestamp: Date,             // Quand l'événement s'est produit
  messages: string[],          // Poussez les messages ici pour envoyer à l'utilisateur
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // ex., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Types d'événements

### Événements de commande

Déclenchés quand des commandes d'agent sont émises :

- **`command`** : Tous les événements de commande (écouteur général)
- **`command:new`** : Quand la commande `/new` est émise
- **`command:reset`** : Quand la commande `/reset` est émise
- **`command:stop`** : Quand la commande `/stop` est émise

### Événements d'agent

- **`agent:bootstrap`** : Avant que les fichiers de bootstrap d'espace de travail ne soient injectés (les hooks peuvent muter `context.bootstrapFiles`)

### Événements de passerelle

Déclenchés quand la passerelle démarre :

- **`gateway:startup`** : Après le démarrage des canaux et le chargement des hooks

### Hooks de résultat d'outil (API de plugin)

Ces hooks ne sont pas des écouteurs de flux d'événements ; ils permettent aux plugins d'ajuster de manière synchrone les résultats d'outils avant qu'OpenClaw ne les persiste.

- **`tool_result_persist`** : transforme les résultats d'outils avant qu'ils ne soient écrits dans la transcription de session. Doit être synchrone ; retournez la charge utile de résultat d'outil mise à jour ou `undefined` pour la garder telle quelle. Voir [Boucle d'agent](/fr-FR/concepts/agent-loop).

### Événements futurs

Types d'événements planifiés :

- **`session:start`** : Quand une nouvelle session commence
- **`session:end`** : Quand une session se termine
- **`agent:error`** : Quand un agent rencontre une erreur
- **`message:sent`** : Quand un message est envoyé
- **`message:received`** : Quand un message est reçu

## Créer des hooks personnalisés

### 1. Choisir l'emplacement

- **Hooks d'espace de travail** (`<workspace>/hooks/`) : Par agent, précédence la plus haute
- **Hooks gérés** (`~/.openclaw/hooks/`) : Partagés entre espaces de travail

### 2. Créer la structure de répertoire

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Créer HOOK.md

```markdown
---
name: my-hook
description: "Fait quelque chose d'utile"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# Mon Hook personnalisé

Ce hook fait quelque chose d'utile quand vous émettez `/new`.
```

### 4. Créer handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] En cours d'exécution !");
  // Votre logique ici
};

export default handler;
```

### 5. Activer et tester

```bash
# Vérifier que le hook est découvert
openclaw hooks list

# L'activer
openclaw hooks enable my-hook

# Redémarrer votre processus de passerelle (redémarrage de l'app de barre de menu sur macOS, ou redémarrer votre processus de dev)

# Déclencher l'événement
# Envoyer /new via votre canal de messagerie
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

Charger les hooks depuis des répertoires supplémentaires :

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

### Format de configuration hérité (toujours supporté)

L'ancien format de config fonctionne toujours pour la rétrocompatibilité :

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

Note : `module` doit être un chemin relatif à l'espace de travail. Les chemins absolus et la traversée en dehors de l'espace de travail sont rejetés.

**Migration** : Utilisez le nouveau système basé sur la découverte pour les nouveaux hooks. Les gestionnaires hérités sont chargés après les hooks basés sur des répertoires.

## Commandes CLI

### Lister les hooks

```bash
# Lister tous les hooks
openclaw hooks list

# Montrer uniquement les hooks éligibles
openclaw hooks list --eligible

# Sortie verbeuse (montrer les prérequis manquants)
openclaw hooks list --verbose

# Sortie JSON
openclaw hooks list --json
```

### Informations sur un hook

```bash
# Montrer des infos détaillées sur un hook
openclaw hooks info session-memory

# Sortie JSON
openclaw hooks info session-memory --json
```

### Vérifier l'éligibilité

```bash
# Montrer le résumé d'éligibilité
openclaw hooks check

# Sortie JSON
openclaw hooks check --json
```

### Activer/Désactiver

```bash
# Activer un hook
openclaw hooks enable session-memory

# Désactiver un hook
openclaw hooks disable command-logger
```

## Référence des hooks intégrés

### session-memory

Sauvegarde le contexte de session en mémoire quand vous émettez `/new`.

**Événements** : `command:new`

**Prérequis** : `workspace.dir` doit être configuré

**Sortie** : `<workspace>/memory/YYYY-MM-DD-slug.md` (par défaut `~/.openclaw/workspace`)

**Ce qu'il fait** :

1. Utilise l'entrée de session pré-réinitialisation pour localiser la transcription correcte
2. Extrait les 15 dernières lignes de conversation
3. Utilise le LLM pour générer un slug de nom de fichier descriptif
4. Sauvegarde les métadonnées de session dans un fichier de mémoire daté

**Exemple de sortie** :

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Clé de session** : agent:main:main
- **ID de session** : abc123def456
- **Source** : telegram
```

**Exemples de noms de fichiers** :

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (horodatage de secours si la génération de slug échoue)

**Activer** :

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

Injecte des fichiers de bootstrap supplémentaires (par exemple `AGENTS.md` / `TOOLS.md` locaux au monorepo) pendant `agent:bootstrap`.

**Événements** : `agent:bootstrap`

**Prérequis** : `workspace.dir` doit être configuré

**Sortie** : Aucun fichier écrit ; le contexte de bootstrap est modifié en mémoire uniquement.

**Config** :

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

**Notes** :

- Les chemins sont résolus relativement à l'espace de travail.
- Les fichiers doivent rester à l'intérieur de l'espace de travail (vérification realpath).
- Seuls les noms de base de bootstrap reconnus sont chargés.
- La liste blanche de sous-agent est préservée (`AGENTS.md` et `TOOLS.md` uniquement).

**Activer** :

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

Journalise tous les événements de commande dans un fichier d'audit centralisé.

**Événements** : `command`

**Prérequis** : Aucun

**Sortie** : `~/.openclaw/logs/commands.log`

**Ce qu'il fait** :

1. Capture les détails d'événement (action de commande, horodatage, clé de session, ID d'expéditeur, source)
2. Ajoute au fichier journal en format JSONL
3. S'exécute silencieusement en arrière-plan

**Exemples d'entrées de journal** :

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Voir les journaux** :

```bash
# Voir les commandes récentes
tail -n 20 ~/.openclaw/logs/commands.log

# Affichage joli avec jq
cat ~/.openclaw/logs/commands.log | jq .

# Filtrer par action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Activer** :

```bash
openclaw hooks enable command-logger
```

### boot-md

Exécute `BOOT.md` quand la passerelle démarre (après le démarrage des canaux).
Les hooks internes doivent être activés pour que cela s'exécute.

**Événements** : `gateway:startup`

**Prérequis** : `workspace.dir` doit être configuré

**Ce qu'il fait** :

1. Lit `BOOT.md` depuis votre espace de travail
2. Exécute les instructions via le runner d'agent
3. Envoie tous les messages sortants demandés via l'outil de message

**Activer** :

```bash
openclaw hooks enable boot-md
```

## Bonnes pratiques

### Garder les gestionnaires rapides

Les hooks s'exécutent pendant le traitement des commandes. Gardez-les légers :

```typescript
// ✓ Bon - travail async, retourne immédiatement
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Mauvais - bloque le traitement des commandes
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Gérer les erreurs gracieusement

Enveloppez toujours les opérations risquées :

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Échec:", err instanceof Error ? err.message : String(err));
    // Ne pas lever d'erreur - laisser les autres gestionnaires s'exécuter
  }
};
```

### Filtrer les événements tôt

Retournez tôt si l'événement n'est pas pertinent :

```typescript
const handler: HookHandler = async (event) => {
  // Gérer uniquement les commandes 'new'
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Votre logique ici
};
```

### Utiliser des clés d'événement spécifiques

Spécifiez les événements exacts dans les métadonnées quand possible :

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Spécifique
```

Plutôt que :

```yaml
metadata: { "openclaw": { "events": ["command"] } } # Général - plus de surcharge
```

## Débogage

### Activer la journalisation des hooks

La passerelle journalise le chargement des hooks au démarrage :

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Vérifier la découverte

Lister tous les hooks découverts :

```bash
openclaw hooks list --verbose
```

### Vérifier l'enregistrement

Dans votre gestionnaire, journalisez quand il est appelé :

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Déclenché:", event.type, event.action);
  // Votre logique
};
```

### Vérifier pourquoi un hook n'est pas éligible

Vérifiez pourquoi un hook n'est pas éligible :

```bash
openclaw hooks info my-hook
```

Recherchez les prérequis manquants dans la sortie.

## Tests

### Journaux de passerelle

Surveillez les journaux de passerelle pour voir l'exécution des hooks :

```bash
# macOS
./scripts/clawlog.sh -f

# Autres plateformes
tail -f ~/.openclaw/gateway.log
```

### Tester les hooks directement

Testez vos gestionnaires de manière isolée :

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("mon gestionnaire fonctionne", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Affirmer les effets secondaires
});
```

## Architecture

### Composants principaux

- **`src/hooks/types.ts`** : Définitions de types
- **`src/hooks/workspace.ts`** : Scan et chargement de répertoires
- **`src/hooks/frontmatter.ts`** : Analyse des métadonnées HOOK.md
- **`src/hooks/config.ts`** : Vérification d'éligibilité
- **`src/hooks/hooks-status.ts`** : Rapports de statut
- **`src/hooks/loader.ts`** : Chargeur de modules dynamique
- **`src/cli/hooks-cli.ts`** : Commandes CLI
- **`src/gateway/server-startup.ts`** : Charge les hooks au démarrage de la passerelle
- **`src/auto-reply/reply/commands-core.ts`** : Déclenche les événements de commande

### Flux de découverte

```
Démarrage de la passerelle
    ↓
Scanner les répertoires (workspace → géré → intégré)
    ↓
Analyser les fichiers HOOK.md
    ↓
Vérifier l'éligibilité (bins, env, config, os)
    ↓
Charger les gestionnaires des hooks éligibles
    ↓
Enregistrer les gestionnaires pour les événements
```

### Flux d'événement

```
L'utilisateur envoie /new
    ↓
Validation de commande
    ↓
Créer un événement de hook
    ↓
Déclencher le hook (tous les gestionnaires enregistrés)
    ↓
Le traitement de la commande continue
    ↓
Réinitialisation de session
```

## Dépannage

### Hook non découvert

1. Vérifier la structure de répertoire :

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Devrait montrer : HOOK.md, handler.ts
   ```

2. Vérifier le format HOOK.md :

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Devrait avoir du frontmatter YAML avec name et metadata
   ```

3. Lister tous les hooks découverts :

   ```bash
   openclaw hooks list
   ```

### Hook non éligible

Vérifier les prérequis :

```bash
openclaw hooks info my-hook
```

Rechercher ce qui manque :

- Binaires (vérifier PATH)
- Variables d'environnement
- Valeurs de configuration
- Compatibilité OS

### Hook ne s'exécute pas

1. Vérifier que le hook est activé :

   ```bash
   openclaw hooks list
   # Devrait montrer ✓ à côté des hooks activés
   ```

2. Redémarrer votre processus de passerelle pour que les hooks se rechargent.

3. Vérifier les journaux de passerelle pour les erreurs :

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Erreurs de gestionnaire

Vérifier les erreurs TypeScript/import :

```bash
# Tester l'import directement
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Guide de migration

### De la configuration héritée à la découverte

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

1. Créer le répertoire de hook :

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Créer HOOK.md :

   ```markdown
   ---
   name: my-hook
   description: "Mon hook personnalisé"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # Mon Hook

   Fait quelque chose d'utile.
   ```

3. Mettre à jour la config :

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

4. Vérifier et redémarrer votre processus de passerelle :

   ```bash
   openclaw hooks list
   # Devrait montrer : 🎯 my-hook ✓
   ```

**Avantages de la migration** :

- Découverte automatique
- Gestion CLI
- Vérification d'éligibilité
- Meilleure documentation
- Structure cohérente

## Voir aussi

- [Référence CLI : hooks](/fr-FR/cli/hooks)
- [README des hooks intégrés](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhooks](/fr-FR/automation/webhook)
- [Configuration](/fr-FR/gateway/configuration#hooks)
