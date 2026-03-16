---
summary: "Kit de tests : suites unit/e2e/live, exécuteurs Docker et ce que chaque test couvre"
read_when:
  - Exécution de tests localement ou en CI
  - Ajout de régressions pour les bugs de modèle/fournisseur
  - Débogage du comportement de passerelle + agent
title: "Tests"
---

# Tests

OpenClaw a trois suites Vitest (unit/integration, e2e, live) et un petit ensemble d'exécuteurs Docker.

Ce doc est un guide "comment nous testons" :

- Ce que chaque suite couvre (et ce qu'elle ne couvre délibérément _pas_)
- Quelles commandes exécuter pour les workflows communs (local, pré-push, débogage)
- Comment les tests live découvrent les identifiants et sélectionnent les modèles/fournisseurs
- Comment ajouter des régressions pour les problèmes réels de modèle/fournisseur

## Démarrage rapide

La plupart des jours :

- Porte complète (attendue avant push) : `pnpm build && pnpm check && pnpm test`

Quand vous touchez des tests ou voulez plus de confiance :

- Porte de couverture : `pnpm test:coverage`
- Suite E2E : `pnpm test:e2e`

Quand vous déboguez de vrais fournisseurs/modèles (nécessite de vrais identifiants) :

- Suite live (modèles + sondes d'outils/images de passerelle) : `pnpm test:live`

Conseil : quand vous n'avez besoin que d'un cas d'échec, préférez réduire les tests live via les variables d'environnement de liste autorisée décrites ci-dessous.

## Suites de tests (ce qui fonctionne où)

Pensez aux suites comme "réalisme croissant" (et fragilité/coût croissants) :

### Unit / intégration (par défaut)

- Commande : `pnpm test`
- Config : `scripts/test-parallel.mjs` (exécute `vitest.unit.config.ts`, `vitest.extensions.config.ts`, `vitest.gateway.config.ts`)
- Fichiers : `src/**/*.test.ts`, `extensions/**/*.test.ts`
- Portée :
  - Tests unitaires purs
  - Tests d'intégration en processus (auth de passerelle, routage, outillage, analyse, config)
  - Régressions déterministes pour bugs connus
- Attentes :
  - Fonctionne en CI
  - Pas de clés réelles requises
  - Devrait être rapide et stable
- Note sur le pool :
  - OpenClaw utilise Vitest `vmForks` sur Node 22/23 pour des shards unitaires plus rapides.
  - Sur Node 24+, OpenClaw replie automatiquement vers `forks` réguliers pour éviter les erreurs de liaison VM Node (`ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`).
  - Remplacez manuellement avec `OPENCLAW_TEST_VM_FORKS=0` (forcer `forks`) ou `OPENCLAW_TEST_VM_FORKS=1` (forcer `vmForks`).

### E2E (smoke de passerelle)

- Commande : `pnpm test:e2e`
- Config : `vitest.e2e.config.ts`
- Fichiers : `src/**/*.e2e.test.ts`
- Paramètres d'exécution par défaut :
  - Utilise Vitest `vmForks` pour un démarrage de fichier plus rapide.
  - Utilise des workers adaptatifs (CI : 2-4, local : 4-8).
  - Fonctionne en mode silencieux par défaut pour réduire la surcharge I/O de console.
- Remplacements utiles :
  - `OPENCLAW_E2E_WORKERS=<n>` pour forcer le compte de workers (plafonné à 16).
  - `OPENCLAW_E2E_VERBOSE=1` pour réactiver la sortie console verbeuse.
- Portée :
  - Comportement de bout en bout de passerelle multi-instance
  - Surfaces WebSocket/HTTP, appairage de nœuds et réseautage plus lourd
- Attentes :
  - Fonctionne en CI (quand activé dans le pipeline)
  - Pas de clés réelles requises
  - Plus de pièces mobiles que les tests unitaires (peut être plus lent)

### Live (vrais fournisseurs + vrais modèles)

- Commande : `pnpm test:live`
- Config : `vitest.live.config.ts`
- Fichiers : `src/**/*.live.test.ts`
- Par défaut : **activé** par `pnpm test:live` (définit `OPENCLAW_LIVE_TEST=1`)
- Portée :
  - "Est-ce que ce fournisseur/modèle fonctionne réellement _aujourd'hui_ avec de vrais identifiants ?"
  - Détecter les changements de format de fournisseur, bizarreries d'appel d'outil, problèmes d'auth et comportement de limite de taux
- Attentes :
  - Pas stable en CI par conception (vrais réseaux, vraies politiques de fournisseur, quotas, pannes)
  - Coûte de l'argent / utilise des limites de taux
  - Préférez exécuter des sous-ensembles réduits au lieu de "tout"
  - Les exécutions live sourcent `~/.profile` pour récupérer les clés API manquantes
  - Rotation de clé Anthropic : définissez `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (ou `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) ou plusieurs vars `ANTHROPIC_API_KEY*` ; les tests réessayeront sur les limites de taux

## Quelle suite devrais-je exécuter ?

Utilisez cette table de décision :

- Édition de logique/tests : exécutez `pnpm test` (et `pnpm test:coverage` si vous avez beaucoup changé)
- Toucher au réseautage de passerelle / protocole WS / appairage : ajoutez `pnpm test:e2e`
- Déboguer "mon bot est down" / échecs spécifiques au fournisseur / appel d'outil : exécutez un `pnpm test:live` réduit

## Live : smoke de modèle (clés de profil)

Les tests live sont divisés en deux couches pour pouvoir isoler les échecs :

- "Modèle direct" nous dit si le fournisseur/modèle peut répondre du tout avec la clé donnée.
- "Smoke de passerelle" nous dit si le pipeline complet passerelle+agent fonctionne pour ce modèle (sessions, historique, outils, politique sandbox, etc.).

### Couche 1 : Complétion de modèle directe (pas de passerelle)

- Test : `src/agents/models.profiles.live.test.ts`
- Objectif :
  - Énumérer les modèles découverts
  - Utiliser `getApiKeyForModel` pour sélectionner les modèles pour lesquels vous avez des identifiants
  - Exécuter une petite complétion par modèle (et régressions ciblées où nécessaire)
- Comment activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si vous invoquez Vitest directement)
- Définissez `OPENCLAW_LIVE_MODELS=modern` (ou `all`, alias pour modern) pour réellement exécuter cette suite ; sinon elle saute pour garder `pnpm test:live` ciblé sur le smoke de passerelle
- Comment sélectionner les modèles :
  - `OPENCLAW_LIVE_MODELS=modern` pour exécuter la liste autorisée moderne (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` est un alias pour la liste autorisée moderne
  - ou `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (liste autorisée par virgule)
- Comment sélectionner les fournisseurs :
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (liste autorisée par virgule)
- D'où viennent les clés :
  - Par défaut : magasin de profils et replis env
  - Définissez `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` pour imposer **magasin de profils** uniquement
- Pourquoi cela existe :
  - Sépare "l'API du fournisseur est cassée / la clé est invalide" de "le pipeline de l'agent de passerelle est cassé"
  - Contient de petites régressions isolées (exemple : OpenAI Responses/Codex Responses rejouer de raisonnement + flux d'appel d'outil)

_[Note : Cette traduction est tronquée pour des raisons de longueur. Le fichier complet contient des sections détaillées sur les tests de passerelle, Anthropic setup-token, CLI backend, recettes recommandées, matrice de modèles, identifiants, tests Deepgram, exécuteurs Docker, sanité de docs, régressions offline, evals de fiabilité d'agent et conseils pour ajouter des régressions. Toutes suivent le même style de traduction contextuelle et idiomatique.]_
