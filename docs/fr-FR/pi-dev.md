---
title: "Flux de Travail Développement Pi"
---

# Flux de Travail Développement Pi

Ce guide résume un flux de travail sain pour travailler sur l'intégration pi dans OpenClaw.

## Vérification de Type et Lint

- Vérification de type et build : `pnpm build`
- Lint : `pnpm lint`
- Vérification format : `pnpm format`
- Porte complète avant push : `pnpm lint && pnpm build && pnpm test`

## Exécution Tests Pi

Utilisez le script dédié pour l'ensemble de tests d'intégration pi :

```bash
scripts/pi/run-tests.sh
```

Pour inclure le test en direct qui exerce le comportement de fournisseur réel :

```bash
scripts/pi/run-tests.sh --live
```

Le script exécute tous les tests unitaires liés à pi via ces globs :

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Tests Manuels

Flux recommandé :

- Exécutez la passerelle en mode dev :
  - `pnpm gateway:dev`
- Déclenchez l'agent directement :
  - `pnpm openclaw agent --message "Bonjour" --thinking low`
- Utilisez la TUI pour le débogage interactif :
  - `pnpm tui`

Pour le comportement d'appel d'outil, demandez une action `read` ou `exec` pour que vous puissiez voir le streaming d'outil et la gestion de charge utile.

## Réinitialisation Table Rase

L'état vit sous le répertoire d'état OpenClaw. Par défaut c'est `~/.openclaw`. Si `OPENCLAW_STATE_DIR` est défini, utilisez ce répertoire à la place.

Pour tout réinitialiser :

- `openclaw.json` pour la config
- `credentials/` pour les profils auth et tokens
- `agents/<agentId>/sessions/` pour l'historique de session d'agent
- `agents/<agentId>/sessions.json` pour l'index de session
- `sessions/` si des chemins hérités existent
- `workspace/` si vous voulez un espace de travail vierge

Si vous voulez seulement réinitialiser les sessions, supprimez `agents/<agentId>/sessions/` et `agents/<agentId>/sessions.json` pour cet agent. Gardez `credentials/` si vous ne voulez pas réauthentifier.

## Références

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
