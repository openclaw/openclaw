---
title: "Architecture Intégration Pi"
---

# Architecture Intégration Pi

Ce document décrit comment OpenClaw intègre avec [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) et packages sibling (`pi-ai`, `pi-agent-core`, `pi-tui`) pour propulser capacités agent AI.

## Overview

OpenClaw utilise SDK pi pour embarquer agent coding AI dans architecture passerelle messaging. Au lieu spawner pi comme subprocess ou utiliser mode RPC, OpenClaw importe directement et instancie `AgentSession` pi via `createAgentSession()`. Approche embarquée fournit :

- Contrôle complet sur lifecycle session et handling événement
- Injection tool custom (messaging, sandbox, actions spécifiques canal)
- Customisation system prompt per canal/contexte
- Persistance session avec support branching/compaction
- Rotation profil auth multi-compte avec failover
- Switching modèle agnostique provider

## Dépendances Package

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package           | Purpose                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `pi-ai`           | Abstractions LLM core : `Model`, `streamSimple`, types message, APIs provider                           |
| `pi-agent-core`   | Boucle agent, exécution tool, types `AgentMessage`                                                      |
| `pi-coding-agent` | SDK haut niveau : `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, tools builtin |
| `pi-tui`          | Composants UI terminal (utilisé dans mode TUI local OpenClaw)                                           |

## Structure Fichier

```
src/agents/
├── pi-embedded-runner.ts          # Re-exports depuis pi-embedded-runner/
├── pi-embedded-runner/
│   ├── run.ts                     # Entrée main : runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # Logique attempt unique avec setup session
│   │   ├── params.ts              # Type RunEmbeddedPiAgentParams
│   │   ├── payloads.ts            # Build payloads réponse depuis résultats run
│   │   ├── images.ts              # Injection image modèle vision
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # Détection erreur abort
│   ├── cache-ttl.ts               # Tracking TTL cache pour pruning contexte
│   ├── compact.ts                 # Logique compaction manuelle/auto
│   ├── extensions.ts              # Charger extensions pi pour runs embarqués
│   ├── extra-params.ts            # Params stream spécifiques provider
│   ├── google.ts                  # Fixes ordering turn Google/Gemini
│   ├── history.ts                 # Limiting historique (DM vs groupe)
│   ├── lanes.ts                   # Lanes commande session/globale
│   ├── logger.ts                  # Logger subsystème
│   ├── model.ts                   # Résolution modèle via ModelRegistry
│   ├── runs.ts                    # Tracking run actif, abort, queue
│   ├── sandbox-info.ts            # Info sandbox pour system prompt
│   ├── session-manager-cache.ts   # Cache instance SessionManager
│   ├── session-manager-init.ts    # Initialisation fichier session
│   ├── system-prompt.ts           # Builder system prompt
│   ├── tool-split.ts              # Split tools dans builtIn vs custom
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # Mapping ThinkLevel, description erreur
├── pi-embedded-subscribe.ts       # Subscription/dispatch événement session
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-extensions/                 # Extensions pi custom
│   ├── compaction-safeguard.ts    # Extension safeguard
│   └── context-pruning.ts         # Extension pruning contexte cache-TTL
├── model-auth.ts                  # Résolution profil auth
├── auth-profiles.ts               # Store profil, cooldown, failover
├── model-selection.ts             # Résolution modèle défaut
└── system-prompt.ts               # buildAgentSystemPrompt()
```

## Flow Integration

1. **Message inbound** → Passerelle OpenClaw
2. **Routing** → Session agent appropriée
3. **Run Pi** → `runEmbeddedPiAgent()` instancie `AgentSession`
4. **Tools** → Pi appelle tools OpenClaw custom (messaging, sandbox, etc.)
5. **Streaming** → Réponses streamées back vers canal
6. **Persistance** → Session sauvegardée vers `~/.openclaw/agents/<agentId>/sessions/`

## Custom Tools

OpenClaw injecte tools custom dans Pi :

- **Messaging** : `agent_send`, `reactions`
- **Sandbox** : `exec`, `browser`, `elevated`
- **Sessions** : `sessions_spawn`, `sessions_list`
- **System** : `process_list`, `process_kill`

Voir [Tools](/fr-FR/tools/index) pour détails.

## System Prompt

System prompt construit depuis :

- **Profil agent** : workspace files (`IDENTITY.md`, `SOUL.md`, etc.)
- **Context canal** : type (DM/groupe), permissions
- **Sandbox info** : mode, capabilities
- **Skills** : compétences disponibles

## Auth & Failover

OpenClaw gère :

- **Profils multiples** : rotation provider quand rate limits
- **Cooldowns** : empêche retry immédiat profils échoués
- **Fallbacks** : switch automatique vers profils alternatifs

## Persistance Session

Sessions stockées comme transcripts JSONL :

```
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

Supporte :

- **Branching** : sessions multiples per conversation
- **Compaction** : résumé automatique historique ancien
- **Pruning** : suppression cache-expired turns

Voir aussi :

- [Sessions](/fr-FR/concepts/session)
- [Boucle Agent](/fr-FR/concepts/agent-loop)
- [Tools](/fr-FR/tools/index)
- [Compaction](/fr-FR/concepts/compaction)
