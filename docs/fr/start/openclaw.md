---
summary: "Guide de bout en bout pour exécuter OpenClaw comme assistant personnel avec des précautions de sécurité"
read_when:
  - Prise en main d’une nouvelle instance d’assistant
  - Revue des implications de sécurité et de permissions
title: "Configuration d’un assistant personnel"
---

# Créer un assistant personnel avec OpenClaw

OpenClaw est une passerelle WhatsApp + Telegram + Discord + iMessage pour les agents **Pi**. Des plugins ajoutent Mattermost. Ce guide correspond à la configuration « assistant personnel » : un numéro WhatsApp dédié qui se comporte comme votre agent toujours actif.

## ⚠️ La sécurité avant tout

Vous placez un agent en position de :

- exécuter des commandes sur votre machine (selon la configuration de vos outils Pi)
- lire/écrire des fichiers dans votre espace de travail
- envoyer des messages vers WhatsApp/Telegram/Discord/Mattermost (plugin)

Commencez de manière conservatrice :

- Définissez toujours `channels.whatsapp.allowFrom` (ne faites jamais fonctionner ouvert sur Internet sur votre Mac personnel).
- Utilisez un numéro WhatsApp dédié pour l’assistant.
- Les heartbeats sont désormais définis par défaut toutes les 30 minutes. Désactivez-les jusqu’à ce que vous fassiez confiance à la configuration en définissant `agents.defaults.heartbeat.every: "0m"`.

## Prérequis

- OpenClaw installé et pris en main — voir [Premiers pas](/start/getting-started) si ce n’est pas encore fait
- Un second numéro de téléphone (SIM/eSIM/prépayé) pour l’assistant

## La configuration à deux téléphones (recommandée)

Voici ce que vous voulez :

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Si vous liez votre WhatsApp personnel à OpenClaw, chaque message qui vous est adressé devient une « entrée agent ». C’est rarement ce que vous souhaitez.

## Démarrage rapide en 5 minutes

1. Associez WhatsApp Web (affiche un QR ; scannez-le avec le téléphone de l’assistant) :

```bash
openclaw channels login
```

2. Démarrez la Gateway (passerelle) (laissez-la en cours d’exécution) :

```bash
openclaw gateway --port 18789
```

3. Placez une configuration minimale dans `~/.openclaw/openclaw.json` :

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Envoyez maintenant un message au numéro de l’assistant depuis votre téléphone autorisé.

Lorsque la prise en main est terminée, nous ouvrons automatiquement le tableau de bord et affichons un lien propre (sans jeton). S’il demande une authentification, collez le jeton depuis `gateway.auth.token` dans les paramètres de l’UI de contrôle. Pour rouvrir plus tard : `openclaw dashboard`.

## Donner un espace de travail à l’agent (AGENTS)

OpenClaw lit les instructions de fonctionnement et la « mémoire » depuis le répertoire de l’espace de travail.

Par défaut, OpenClaw utilise `~/.openclaw/workspace` comme espace de travail de l’agent, et le crée (ainsi que les fichiers de démarrage `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`) automatiquement lors de la configuration ou du premier lancement de l’agent. `BOOTSTRAP.md` n’est créé que lorsque l’espace de travail est entièrement nouveau (il ne doit pas réapparaître après suppression). `MEMORY.md` est facultatif (pas créé automatiquement) ; lorsqu'il est présent, il est chargé pour les sessions normales. Les sessions de sous-agents n'injectent que `AGENTS.md` et `TOOLS.md`.

Astuce : traitez ce dossier comme la « mémoire » d’OpenClaw et faites-en un dépôt git (idéalement privé) afin que vos `AGENTS.md` + fichiers de mémoire soient sauvegardés. Si git est installé, les espaces de travail tout neufs sont initialisés automatiquement.

```bash
openclaw setup
```

Disposition complète de l’espace de travail + guide de sauvegarde : [Espace de travail de l’agent](/concepts/agent-workspace)
Flux de travail de la mémoire : [Mémoire](/concepts/memory)

Optionnel : choisissez un autre espace de travail avec `agents.defaults.workspace` (prend en charge `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Si vous livrez déjà vos propres fichiers d’espace de travail depuis un dépôt, vous pouvez désactiver entièrement la création des fichiers de démarrage :

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## La configuration qui en fait « un assistant »

OpenClaw propose par défaut une bonne configuration d’assistant, mais vous voudrez généralement ajuster :

- la persona / les instructions dans `SOUL.md`
- les paramètres de raisonnement par défaut (si souhaité)
- les heartbeats (une fois que vous lui faites confiance)

Exemple :

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Sessions et mémoire

- Fichiers de session : `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Métadonnées de session (utilisation des jetons, dernier routage, etc.) : `~/.openclaw/agents/<agentId>/sessions/sessions.json` (hérité : `~/.openclaw/sessions/sessions.json`)
- `/new` ou `/reset` démarre une nouvelle session pour ce chat (configurable via `resetTriggers`). S’il est envoyé seul, l’agent répond par un bref message de confirmation.
- `/compact [instructions]` compacte le contexte de la session et indique le budget de contexte restant.

## Heartbeats (mode proactif)

Par défaut, OpenClaw exécute un heartbeat toutes les 30 minutes avec l’invite :
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Définissez `agents.defaults.heartbeat.every: "0m"` pour désactiver.

- Si `HEARTBEAT.md` existe mais est effectivement vide (seulement des lignes vides et des en-têtes markdown comme `# Heading`), OpenClaw ignore l’exécution du heartbeat afin d’économiser des appels API.
- Si le fichier est manquant, le heartbeat s’exécute quand même et le modèle décide quoi faire.
- Si l’agent répond avec `HEARTBEAT_OK` (éventuellement avec un court remplissage ; voir `agents.defaults.heartbeat.ackMaxChars`), OpenClaw supprime l’envoi sortant pour ce heartbeat.
- Les heartbeats exécutent des tours complets de l’agent — des intervalles plus courts consomment plus de jetons.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Médias entrants et sortants

Les pièces jointes entrantes (images/audio/documents) peuvent être exposées à votre commande via des modèles :

- `{{MediaPath}}` (chemin de fichier temporaire local)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (si la transcription audio est activée)

Pièces jointes sortantes depuis l’agent : incluez `MEDIA:<path-or-url>` sur sa propre ligne (sans espaces). Exemple :

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw les extrait et les envoie comme médias en plus du texte.

## Liste de contrôle opérationnelle

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Les journaux se trouvent sous `/tmp/openclaw/` (par défaut : `openclaw-YYYY-MM-DD.log`).

## Prochaines étapes

- WebChat : [WebChat](/web/webchat)
- Opérations de la Gateway (passerelle) : [Manuel d’exploitation de la Gateway](/gateway)
- Cron + réveils : [Tâches cron](/automation/cron-jobs)
- Application compagnon de la barre de menus macOS : [Application macOS OpenClaw](/platforms/macos)
- Application node iOS : [Application iOS](/platforms/ios)
- Application node Android : [Application Android](/platforms/android)
- Statut Windows : [Windows (WSL2)](/platforms/windows)
- Statut Linux : [Application Linux](/platforms/linux)
- Sécurité : [Sécurité](/gateway/security)
