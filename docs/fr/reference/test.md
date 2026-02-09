---
summary: "Comment exécuter les tests localement (vitest) et quand utiliser les modes force/couverture"
read_when:
  - Exécution ou correction des tests
title: "Tests"
---

# Tests

- Kit de tests complet (suites, live, Docker) : [Tests](/testing)

- `pnpm test:force` : Tue tout processus de gateway résiduel occupant le port de contrôle par défaut, puis exécute l’intégralité de la suite Vitest avec un port de gateway isolé afin d’éviter les collisions des tests serveur avec une instance en cours d’exécution. À utiliser lorsqu’une exécution précédente de la gateway a laissé le port 18789 occupé.

- `pnpm test:coverage` : Exécute Vitest avec la couverture V8. Les seuils globaux sont de 70 % pour les lignes/branches/fonctions/instructions. La couverture exclut les points d’entrée fortement orientés intégration (câblage CLI, passerelles gateway/telegram, serveur statique webchat) afin de concentrer l’objectif sur la logique testable unitairement.

- `pnpm test:e2e` : Exécute des tests de fumée de bout en bout de la gateway (appariement multi‑instances WS/HTTP/node).

- `pnpm test:live` : Exécute les tests live des fournisseurs (minimax/zai). Nécessite des clés API et `LIVE=1` (ou `*_LIVE_TEST=1` spécifique au fournisseur) pour lever le saut des tests.

## Benchmark de latence des modèles (clés locales)

Script : [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Utilisation :

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Variables d’environnement optionnelles : `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Invite par défaut : « Répondez avec un seul mot : ok. Sans ponctuation ni texte supplémentaire.

Dernière exécution (2025‑12‑31, 20 exécutions) :

- minimax médiane 1279 ms (min 1114, max 2431)
- opus médiane 2454 ms (min 1224, max 3170)

## Onboarding E2E (Docker)

Docker est facultatif ; requis uniquement pour les tests de fumée d’onboarding conteneurisés.

Flux complet de démarrage à froid dans un conteneur Linux propre :

```bash
scripts/e2e/onboard-docker.sh
```

Ce script pilote l’assistant interactif via un pseudo‑TTY, vérifie les fichiers de configuration/espace de travail/session, puis démarre la gateway et exécute `openclaw health`.

## Import QR — tests de fumée (Docker)

Vérifie que `qrcode-terminal` se charge sous Node 22+ dans Docker :

```bash
pnpm test:docker:qr
```
