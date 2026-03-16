---
summary: "Backends CLI : fallback texte-uniquement via CLIs AI locaux"
read_when:
  - Vous voulez un fallback fiable quand les fournisseurs API échouent
  - Vous exécutez Claude Code CLI ou autres CLIs AI locaux et voulez les réutiliser
  - Vous avez besoin d'un chemin texte-uniquement, sans outil qui supporte toujours les sessions et images
title: "Backends CLI"
---

# Backends CLI (runtime fallback)

OpenClaw peut exécuter **des CLIs AI locaux** comme **fallback texte-uniquement** lorsque les fournisseurs API sont en panne, limités en taux ou temporairement mal comportés. C'est intentionnellement conservateur :

- **Les outils sont désactivés** (pas d'appels d'outils).
- **Texte entrant → texte sortant** (fiable).
- **Les sessions sont supportées** (donc les tours de suivi restent cohérents).
- **Les images peuvent être transférées** si le CLI accepte les chemins d'image.

C'est conçu comme un **filet de sécurité** plutôt qu'un chemin primaire. Utilisez-le lorsque vous voulez des réponses texte "fonctionne toujours" sans dépendre d'APIs externes.

## Démarrage rapide convivial débutant

Vous pouvez utiliser Claude Code CLI **sans aucune config** (OpenClaw inclut un défaut intégré) :

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI fonctionne aussi immédiatement :

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Si votre passerelle s'exécute sous launchd/systemd et le PATH est minimal, ajoutez juste le chemin de commande :

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

C'est tout. Pas de clés, pas de config auth supplémentaire nécessaire au-delà du CLI lui-même.

## L'utiliser comme fallback

Ajoutez un backend CLI à votre liste de fallback pour qu'il ne s'exécute que lorsque les modèles primaires échouent :

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Notes :

- Si vous utilisez `agents.defaults.models` (liste autorisée), vous devez inclure `claude-cli/...`.
- Si le fournisseur primaire échoue (auth, limites de taux, timeouts), OpenClaw essaiera le backend CLI ensuite.

## Aperçu de configuration

Tous les backends CLI vivent sous :

```
agents.defaults.cliBackends
```

Chaque entrée est indexée par un **id fournisseur** (ex. `claude-cli`, `my-cli`). L'id fournisseur devient le côté gauche de votre réf modèle :

```
<provider>/<model>
```

### Exemple de configuration

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Comment ça fonctionne

1. **Sélectionne un backend** basé sur le préfixe fournisseur (`claude-cli/...`).
2. **Construit un prompt système** utilisant le même prompt OpenClaw + contexte workspace.
3. **Exécute le CLI** avec un id session (si supporté) pour que l'historique reste cohérent.
4. **Parse la sortie** (JSON ou texte brut) et retourne le texte final.
5. **Persiste les ids session** par backend, donc les suivis réutilisent la même session CLI.

## Sessions

- Si le CLI supporte les sessions, définissez `sessionArg` (ex. `--session-id`) ou `sessionArgs` (placeholder `{sessionId}`) lorsque l'ID doit être inséré dans plusieurs drapeaux.
- Si le CLI utilise une **sous-commande resume** avec différents drapeaux, définissez `resumeArgs` (remplace `args` lors du resume) et optionnellement `resumeOutput` (pour les resumes non-JSON).
- `sessionMode` :
  - `always` : envoie toujours un id session (nouveau UUID si aucun stocké).
  - `existing` : envoie seulement un id session si un a été stocké avant.
  - `none` : n'envoie jamais d'id session.

## Images (pass-through)

Si votre CLI accepte les chemins d'image, définissez `imageArg` :

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw écrira les images base64 vers des fichiers temp. Si `imageArg` est défini, ces chemins sont passés comme args CLI. Si `imageArg` est manquant, OpenClaw ajoute les chemins de fichier au prompt (injection de chemin), ce qui est suffisant pour les CLIs qui chargent automatiquement les fichiers locaux depuis des chemins bruts (comportement Claude Code CLI).

## Entrées / sorties

- `output: "json"` (défaut) essaie de parser JSON et extraire texte + id session.
- `output: "jsonl"` parse les flux JSONL (Codex CLI `--json`) et extrait le dernier message agent plus `thread_id` lorsque présent.
- `output: "text"` traite stdout comme la réponse finale.

Modes d'entrée :

- `input: "arg"` (défaut) passe le prompt comme dernier arg CLI.
- `input: "stdin"` envoie le prompt via stdin.
- Si le prompt est très long et `maxPromptArgChars` est défini, stdin est utilisé.

## Défauts (intégrés)

OpenClaw inclut un défaut pour `claude-cli` :

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw inclut aussi un défaut pour `codex-cli` :

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Remplacez seulement si nécessaire (courant : chemin `command` absolu).

## Limitations

- **Pas d'outils OpenClaw** (le backend CLI ne reçoit jamais d'appels d'outils). Certains CLIs peuvent toujours exécuter leur propre outillage agent.
- **Pas de streaming** (la sortie CLI est collectée puis retournée).
- **Les sorties structurées** dépendent du format JSON du CLI.
- **Les sessions Codex CLI** reprennent via sortie texte (pas de JSONL), qui est moins structuré que l'exécution initiale `--json`. Les sessions OpenClaw fonctionnent toujours normalement.

## Dépannage

- **CLI non trouvé** : définissez `command` vers un chemin complet.
- **Mauvais nom de modèle** : utilisez `modelAliases` pour mapper `provider/model` → modèle CLI.
- **Pas de continuité de session** : assurez-vous que `sessionArg` est défini et `sessionMode` n'est pas `none` (Codex CLI ne peut actuellement pas reprendre avec sortie JSON).
- **Images ignorées** : définissez `imageArg` (et vérifiez que le CLI supporte les chemins de fichier).
