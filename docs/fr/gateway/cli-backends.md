---
summary: "Backends CLI : solution de repli texte seul via des CLI d’IA locales"
read_when:
  - Vous souhaitez un repli fiable lorsque les fournisseurs d’API échouent
  - Vous exécutez Claude Code CLI ou d’autres CLI d’IA locales et souhaitez les réutiliser
  - Vous avez besoin d’un chemin texte seul, sans outils, qui prend néanmoins en charge les sessions et les images
title: "Backends CLI"
---

# Backends CLI (runtime de repli)

OpenClaw peut exécuter des **CLI d’IA locales** comme **solution de repli texte seul** lorsque les fournisseurs d’API sont indisponibles,
soumis à des limites de débit, ou se comportent temporairement mal. Cette approche est volontairement conservative :

- **Les outils sont désactivés** (aucun appel d’outil).
- **Texte entrant → texte sortant** (fiable).
- **Les sessions sont prises en charge** (les tours de suivi restent cohérents).
- **Les images peuvent être transmises** si la CLI accepte des chemins d’image.

Ceci est conçu comme un **filet de sécurité** plutôt que comme un chemin principal. Utilisez‑le lorsque vous
souhaitez des réponses textuelles « qui fonctionnent toujours » sans dépendre d’API externes.

## Demarrage rapide pour debutants

Vous pouvez utiliser Claude Code CLI **sans aucune configuration** (OpenClaw fournit une valeur par défaut intégrée) :

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI fonctionne également immédiatement :

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Si votre Gateway (passerelle) s’exécute sous launchd/systemd et que le PATH est minimal, ajoutez simplement le
chemin de la commande :

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

C’est tout. Aucune clé, aucune configuration d’authentification supplémentaire au‑delà de la CLI elle‑même.

## L’utiliser comme repli

Ajoutez un backend CLI à votre liste de repli afin qu’il ne s’exécute que lorsque les modèles principaux échouent :

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

Remarques :

- Si vous utilisez `agents.defaults.models` (allowlist), vous devez inclure `claude-cli/...`.
- Si le fournisseur principal échoue (authentification, limites de débit, délais), OpenClaw
  essaiera ensuite le backend CLI.

## Vue d’ensemble de la configuration

Tous les backends CLI se trouvent sous :

```
agents.defaults.cliBackends
```

Chaque entrée est identifiée par un **identifiant de fournisseur** (par ex. `claude-cli`, `my-cli`).
L’identifiant de fournisseur devient la partie gauche de votre référence de modèle :

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

## Fonctionnement

1. **Sélectionne un backend** en fonction du préfixe de fournisseur (`claude-cli/...`).
2. **Construit un prompt système** en utilisant le même prompt OpenClaw + le contexte de l’espace de travail.
3. **Exécute la CLI** avec un identifiant de session (si pris en charge) afin que l’historique reste cohérent.
4. **Analyse la sortie** (JSON ou texte brut) et renvoie le texte final.
5. **Conserve les identifiants de session** par backend, afin que les suivis réutilisent la même session CLI.

## Sessions

- Si la CLI prend en charge les sessions, définissez `sessionArg` (par ex. `--session-id`) ou
  `sessionArgs` (placeholder `{sessionId}`) lorsque l’identifiant doit être inséré
  dans plusieurs options.
- Si la CLI utilise une **sous‑commande de reprise** avec des options différentes, définissez
  `resumeArgs` (remplace `args` lors de la reprise) et éventuellement `resumeOutput`
  (pour les reprises non‑JSON).
- `sessionMode` :
  - `always` : toujours envoyer un identifiant de session (nouvel UUID s’il n’en existe pas).
  - `existing` : n’envoyer un identifiant de session que s’il a été stocké auparavant.
  - `none` : ne jamais envoyer d’identifiant de session.

## Images (pass‑through)

Si votre CLI accepte des chemins d’image, définissez `imageArg` :

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw écrira les images base64 dans des fichiers temporaires. Si `imageArg` est défini, ces
chemins sont passés comme arguments de la CLI. Si `imageArg` est absent, OpenClaw ajoute les
chemins de fichiers au prompt (injection de chemin), ce qui suffit pour les CLI qui chargent automatiquement
les fichiers locaux à partir de chemins simples (comportement de Claude Code CLI).

## Entrées / sorties

- `output: "json"` (par défaut) tente d’analyser le JSON et d’extraire le texte + l’identifiant de session.
- `output: "jsonl"` analyse des flux JSONL (Codex CLI `--json`) et extrait le
  dernier message de l’agent ainsi que `thread_id` lorsqu’il est présent.
- `output: "text"` traite stdout comme la réponse finale.

Modes d’entrée :

- `input: "arg"` (par défaut) transmet le prompt comme dernier argument de la CLI.
- `input: "stdin"` envoie le prompt via stdin.
- Si le prompt est très long et que `maxPromptArgChars` est défini, stdin est utilisé.

## Par défaut (intégré)

OpenClaw fournit une valeur par défaut pour `claude-cli` :

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw fournit également une valeur par défaut pour `codex-cli` :

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Ne surchargez que si nécessaire (courant : chemin `command` absolu).

## Limitations

- **Aucun outil OpenClaw** (le backend CLI ne reçoit jamais d’appels d’outils). Certaines CLI
  peuvent néanmoins exécuter leurs propres outils d’agent.
- **Pas de streaming** (la sortie de la CLI est collectée puis renvoyée).
- **Les sorties structurées** dépendent du format JSON de la CLI.
- **Les sessions Codex CLI** reprennent via une sortie texte (pas de JSONL), ce qui est moins
  structuré que l’exécution initiale `--json`. Les sessions OpenClaw fonctionnent
  néanmoins normalement.

## Problemes courants

- **CLI introuvable** : définissez `command` vers un chemin complet.
- **Nom de modèle incorrect** : utilisez `modelAliases` pour mapper `provider/model` → modèle CLI.
- **Pas de continuité de session** : assurez‑vous que `sessionArg` est défini et que `sessionMode` n’est pas
  `none` (Codex CLI ne peut actuellement pas reprendre avec une sortie JSON).
- **Images ignorées** : définissez `imageArg` (et vérifiez que la CLI prend en charge les chemins de fichiers).
