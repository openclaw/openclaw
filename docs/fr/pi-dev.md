---
title: "Flux de travail de developpement Pi"
---

# Flux de travail de developpement Pi

Ce guide résume un flux de travail raisonnable pour travailler sur l’intégration Pi dans OpenClaw.

## Verification des types et linting

- Verification des types et build : `pnpm build`
- Lint : `pnpm lint`
- Verification du formatage : `pnpm format`
- Validation complete avant push : `pnpm lint && pnpm build && pnpm test`

## Execution des tests Pi

Utilisez le script dedie pour l’ensemble de tests d’integration Pi :

```bash
scripts/pi/run-tests.sh
```

Pour inclure le test en conditions reelles qui exerce le comportement du fournisseur :

```bash
scripts/pi/run-tests.sh --live
```

Le script execute tous les tests unitaires lies a Pi via ces globs :

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Tests manuels

Flux recommande :

- Lancer la Gateway (passerelle) en mode dev :
  - `pnpm gateway:dev`
- Declencher l’agent directement :
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Utiliser la TUI pour le debogage interactif :
  - `pnpm tui`

Pour le comportement des appels d’outils, demandez une action `read` ou `exec` afin de pouvoir observer le streaming des outils et la gestion des charges utiles.

## Nettoyer la réinitialisation de Slate

L’etat est stocke dans le repertoire d’etat OpenClaw. La valeur par defaut est `~/.openclaw`. Si `OPENCLAW_STATE_DIR` est defini, utilisez ce repertoire a la place.

Pour tout reinitialiser :

- `openclaw.json` pour la configuration
- `credentials/` pour les profils d’authentification et les jetons
- `agents/<agentId>/sessions/` pour l’historique des sessions de l’agent
- `agents/<agentId>/sessions.json` pour l’index des sessions
- `sessions/` si des chemins herites existent
- `workspace/` si vous souhaitez un espace de travail vierge

Si vous souhaitez uniquement reinitialiser les sessions, supprimez `agents/<agentId>/sessions/` et `agents/<agentId>/sessions.json` pour cet agent. Conservez `credentials/` si vous ne souhaitez pas vous reauthentifier.

## References

- https://docs.openclaw.ai/testing
- https://docs.openclaw.ai/start/getting-started
