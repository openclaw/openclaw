---
summary: "Kit de test : suites unit/e2e/live, runners Docker et ce que couvre chaque test"
read_when:
  - Exécuter les tests en local ou en CI
  - Ajouter des régressions pour des bugs de modèle/fournisseur
  - Déboguer le comportement de la gateway (passerelle) et de l’agent
title: "Tests"
---

# Tests

OpenClaw dispose de trois suites Vitest (unitaire/intégration, e2e, live) et d’un petit ensemble de runners Docker.

Ce document est un guide « comment nous testons » :

- Ce que couvre chaque suite (et ce qu’elle ne couvre délibérément _pas_)
- Quelles commandes exécuter pour les workflows courants (local, avant push, débogage)
- Comment les tests live découvrent les identifiants et sélectionnent les modèles/fournisseurs
- Comment ajouter des régressions pour des problèmes réels de modèles/fournisseurs

## Démarrage rapide

La plupart des jours :

- Garde complète (attendue avant push) : `pnpm build && pnpm check && pnpm test`

Quand vous modifiez des tests ou voulez plus de confiance :

- Garde de couverture : `pnpm test:coverage`
- Suite E2E : `pnpm test:e2e`

Pour déboguer des fournisseurs/modèles réels (nécessite de vrais identifiants) :

- Suite live (modèles + sondes d’outils/images de la gateway) : `pnpm test:live`

Astuce : quand vous n’avez besoin que d’un seul cas en échec, préférez restreindre les tests live via les variables d’environnement d’allowlist décrites ci-dessous.

## Suites de test (où s’exécute quoi)

Considérez les suites comme une « augmentation du réalisme » (et de la fragilité/coût) :

### Unitaire / intégration (par défaut)

- Commande : `pnpm test`
- Config : `vitest.config.ts`
- Fichiers : `src/**/*.test.ts`
- Portée :
  - Tests unitaires purs
  - Tests d’intégration en processus (authentification de la gateway, routage, outillage, parsing, configuration)
  - Régressions déterministes pour des bugs connus
- Attentes :
  - S’exécute en CI
  - Aucune clé réelle requise
  - Doit être rapide et stable

### E2E (smoke de la gateway)

- Commande : `pnpm test:e2e`
- Config : `vitest.e2e.config.ts`
- Fichiers : `src/**/*.e2e.test.ts`
- Portée :
  - Comportement end-to-end de la gateway multi‑instances
  - Surfaces WebSocket/HTTP, appairage de nœuds et réseau plus lourd
- Attentes :
  - S’exécute en CI (lorsqu’activée dans le pipeline)
  - Aucune clé réelle requise
  - Plus d’éléments mobiles que les tests unitaires (peut être plus lent)

### Live (fournisseurs réels + modèles réels)

- Commande : `pnpm test:live`
- Config : `vitest.live.config.ts`
- Fichiers : `src/**/*.live.test.ts`
- Par défaut : **activée** par `pnpm test:live` (définit `OPENCLAW_LIVE_TEST=1`)
- Portée :
  - « Ce fournisseur/modèle fonctionne‑t‑il vraiment _aujourd’hui_ avec de vrais identifiants ? »
  - Détecter les changements de format des fournisseurs, les particularités d’appel d’outils, les problèmes d’authentification et le comportement des limites de débit
- Attentes :
  - Non stable en CI par conception (réseaux réels, politiques fournisseurs réelles, quotas, pannes)
  - Coûte de l’argent / consomme des quotas
  - Préférez exécuter des sous‑ensembles ciblés plutôt que « tout »
  - Les exécutions live sourcent `~/.profile` pour récupérer les clés API manquantes
  - Rotation des clés Anthropic : définissez `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (ou `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) ou plusieurs variables `ANTHROPIC_API_KEY*` ; les tests réessaieront en cas de limite de débit

## Quelle suite dois‑je exécuter ?

Utilisez ce tableau de décision :

- Édition de logique/tests : exécutez `pnpm test` (et `pnpm test:coverage` si vous avez beaucoup modifié)
- Toucher au réseau de la gateway / protocole WS / appairage : ajoutez `pnpm test:e2e`
- Déboguer « mon bot est en panne » / échecs spécifiques à un fournisseur / appels d’outils : exécutez un `pnpm test:live` restreint

## Live : smoke de modèles (clés de profil)

Les tests live sont scindés en deux couches pour isoler les pannes :

- « Modèle direct » indique si le fournisseur/modèle peut répondre avec la clé donnée.
- « Smoke de la gateway » indique si tout le pipeline gateway+agent fonctionne pour ce modèle (sessions, historique, outils, politique de sandbox, etc.).

### Couche 1 : complétion directe du modèle (sans gateway)

- Test : `src/agents/models.profiles.live.test.ts`
- Objectif :
  - Énumérer les modèles découverts
  - Utiliser `getApiKeyForModel` pour sélectionner les modèles pour lesquels vous avez des identifiants
  - Exécuter une petite complétion par modèle (et des régressions ciblées si nécessaire)
- Comment activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si Vitest est invoqué directement)
- Définissez `OPENCLAW_LIVE_MODELS=modern` (ou `all`, alias moderne) pour réellement exécuter cette suite ; sinon elle est ignorée afin de garder `pnpm test:live` focalisé sur le smoke de la gateway
- Sélection des modèles :
  - `OPENCLAW_LIVE_MODELS=modern` pour exécuter l’allowlist moderne (Opus/Sonnet/Haiku 4.5, GPT‑5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` est un alias de l’allowlist moderne
  - ou `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (allowlist séparée par des virgules)
- Sélection des fournisseurs :
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (allowlist séparée par des virgules)
- Origine des clés :
  - Par défaut : magasin de profils et secours via variables d’environnement
  - Définissez `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` pour imposer **uniquement le magasin de profils**
- Pourquoi cela existe :
  - Sépare « l’API du fournisseur est cassée / la clé est invalide » de « le pipeline d’agent de la gateway est cassé »
  - Contient de petites régressions isolées (exemple : relecture du raisonnement OpenAI Responses/Codex Responses + flux d’appel d’outils)

### Couche 2 : smoke Gateway + agent de dev (ce que « @openclaw » fait réellement)

- Test : `src/gateway/gateway-models.profiles.live.test.ts`
- Objectif :
  - Démarrer une gateway en processus
  - Créer/modifier une session `agent:dev:*` (override de modèle par exécution)
  - Parcourir les modèles‑avec‑clés et vérifier :
    - une réponse « significative » (sans outils)
    - qu’un véritable appel d’outil fonctionne (sonde de lecture)
    - des sondes d’outils supplémentaires optionnelles (sonde exec+read)
    - que les chemins de régression OpenAI (outil‑seul → suivi) continuent de fonctionner
- Détails des sondes (pour expliquer rapidement les échecs) :
  - Sonde `read` : le test écrit un fichier nonce dans l’espace de travail et demande à l’agent de le `read` et de renvoyer le nonce.
  - Sonde `exec+read` : le test demande à l’agent d’`exec`‑écrire un nonce dans un fichier temporaire, puis de le `read`.
  - Sonde image : le test joint un PNG généré (chat + code aléatoire) et attend que le modèle renvoie `cat <CODE>`.
  - Référence d’implémentation : `src/gateway/gateway-models.profiles.live.test.ts` et `src/gateway/live-image-probe.ts`.
- Comment activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si Vitest est invoqué directement)
- Sélection des modèles :
  - Par défaut : allowlist moderne (Opus/Sonnet/Haiku 4.5, GPT‑5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` est un alias de l’allowlist moderne
  - Ou définissez `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (ou une liste séparée par des virgules) pour restreindre
- Sélection des fournisseurs (évitez « OpenRouter tout ») :
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (allowlist séparée par des virgules)
- Les sondes d’outils + image sont toujours actives dans ce test live :
  - Sonde `read` + sonde `exec+read` (stress d’outils)
  - La sonde image s’exécute lorsque le modèle annonce le support des entrées image
  - Flux (haut niveau):
    - Le test génère un petit PNG avec « CAT » + code aléatoire (`src/gateway/live-image-probe.ts`)
    - L’envoie via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - La gateway analyse les pièces jointes en `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - L’agent embarqué transmet un message utilisateur multimodal au modèle
    - Assertion : la réponse contient `cat` + le code (tolérance OCR : erreurs mineures autorisées)

Astuce : pour voir ce que vous pouvez tester sur votre machine (et les identifiants `provider/model` exacts), exécutez :

```bash
openclaw models list
openclaw models list --json
```

## Live : smoke du setup-token Anthropic

- Test : `src/agents/anthropic.setup-token.live.test.ts`
- Objectif : vérifier que le setup-token de Claude Code CLI (ou un profil de setup-token collé) peut compléter une invite Anthropic.
- Activation :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si Vitest est invoqué directement)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Sources de jeton (choisissez une) :
  - Profil : `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Jeton brut : `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Override de modèle (optionnel) :
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Exemple de configuration :

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live : smoke du backend CLI (Claude Code CLI ou autres CLIs locaux)

- Test : `src/gateway/gateway-cli-backend.live.test.ts`
- Objectif : valider le pipeline Gateway + agent en utilisant un backend CLI local, sans toucher à votre configuration par défaut.
- Activation :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si Vitest est invoqué directement)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Valeurs par défaut :
  - Modèle : `claude-cli/claude-sonnet-4-5`
  - Commande : `claude`
  - Arguments : `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (optionnels) :
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` pour envoyer une véritable pièce jointe image (les chemins sont injectés dans l’invite).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` pour passer les chemins des fichiers image comme arguments CLI au lieu d’une injection dans l’invite.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (ou `"list"`) pour contrôler la manière dont les arguments image sont passés lorsque `IMAGE_ARG` est défini.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` pour envoyer un second tour et valider le flux de reprise.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` pour conserver la configuration MCP de Claude Code CLI activée (par défaut, la configuration MCP est désactivée via un fichier vide temporaire).

Exemple :

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Recettes live recommandées

Des allowlists étroites et explicites sont les plus rapides et les moins fragiles :

- Modèle unique, direct (sans gateway) :
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Modèle unique, smoke de la gateway :
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Appels d’outils sur plusieurs fournisseurs :
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Focus Google (clé API Gemini + Antigravity) :
  - Gemini (clé API) : `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth) : `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Remarques :

- `google/...` utilise l’API Gemini (clé API).
- `google-antigravity/...` utilise le pont OAuth Antigravity (endpoint d’agent de type Cloud Code Assist).
- `google-gemini-cli/...` utilise la CLI Gemini locale sur votre machine (authentification distincte + particularités d’outillage).
- API Gemini vs CLI Gemini :
  - API : OpenClaw appelle l’API Gemini hébergée de Google via HTTP (clé API / authentification de profil) ; c’est ce que la plupart des utilisateurs entendent par « Gemini ».
  - CLI : OpenClaw appelle un binaire local `gemini` ; il a sa propre authentification et peut se comporter différemment (streaming/support des outils/décalage de version).

## Live : matrice de modèles (ce que nous couvrons)

Il n’existe pas de « liste de modèles CI » fixe (le live est opt‑in), mais voici les modèles **recommandés** à couvrir régulièrement sur une machine de dev avec des clés.

### Ensemble smoke moderne (appels d’outils + image)

C’est l’exécution « modèles courants » que nous attendons comme fonctionnelle :

- OpenAI (hors Codex) : `openai/gpt-5.2` (optionnel : `openai/gpt-5.1`)
- OpenAI Codex : `openai-codex/gpt-5.3-codex` (optionnel : `openai-codex/gpt-5.3-codex-codex`)
- Anthropic : `anthropic/claude-opus-4-6` (ou `anthropic/claude-sonnet-4-5`)
- Google (API Gemini) : `google/gemini-3-pro-preview` et `google/gemini-3-flash-preview` (évitez les anciens modèles Gemini 2.x)
- Google (Antigravity) : `google-antigravity/claude-opus-4-6-thinking` et `google-antigravity/gemini-3-flash`
- Z.AI (GLM) : `zai/glm-4.7`
- MiniMax : `minimax/minimax-m2.1`

Exécuter le smoke de la gateway avec outils + image :
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Base : appels d’outils (Read + Exec optionnel)

Choisissez au moins un par famille de fournisseurs :

- OpenAI : `openai/gpt-5.2` (ou `openai/gpt-5-mini`)
- Anthropic : `anthropic/claude-opus-4-6` (ou `anthropic/claude-sonnet-4-5`)
- Google : `google/gemini-3-flash-preview` (ou `google/gemini-3-pro-preview`)
- Z.AI (GLM) : `zai/glm-4.7`
- MiniMax : `minimax/minimax-m2.1`

Couverture additionnelle optionnelle (agréable à avoir) :

- xAI : `xai/grok-4` (ou la plus récente disponible)
- Mistral : `mistral/`… (choisissez un modèle « tools » que vous avez activé)
- Cerebras : `cerebras/`… (si vous y avez accès)
- LM Studio : `lmstudio/`… (local ; l’appel d’outils dépend du mode API)

### Vision : envoi d’image (pièce jointe → message multimodal)

Incluez au moins un modèle capable d’images dans `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI avec vision, etc.) pour exercer la sonde image.

### Agrégateurs / gateways alternatives

Si vous avez des clés activées, nous prenons aussi en charge les tests via :

- OpenRouter : `openrouter/...` (des centaines de modèles ; utilisez `openclaw models scan` pour trouver des candidats capables d’outils+image)
- OpenCode Zen : `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Autres fournisseurs que vous pouvez inclure dans la matrice live (si vous avez des identifiants/configuration) :

- Intégrés : `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (endpoints personnalisés) : `minimax` (cloud/API), plus tout proxy compatible OpenAI/Anthropic (LM Studio, vLLM, LiteLLM, etc.)

Astuce : n’essayez pas de coder en dur « tous les modèles » dans la documentation. La liste faisant autorité est celle que `discoverModels(...)` renvoie sur votre machine + les clés disponibles.

## Identifiants (ne jamais committer)

Les tests live découvrent les identifiants de la même manière que la CLI. Implications pratiques :

- Si la CLI fonctionne, les tests live devraient trouver les mêmes clés.

- Si un test live indique « pas d’identifiants », déboguez comme vous le feriez pour `openclaw models list` / la sélection de modèle.

- Magasin de profils : `~/.openclaw/credentials/` (préféré ; c’est ce que signifient les « clés de profil » dans les tests)

- Configuration : `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)

Si vous souhaitez vous appuyer sur des clés via variables d’environnement (p. ex. exportées dans votre `~/.profile`), exécutez les tests locaux après `source ~/.profile`, ou utilisez les runners Docker ci‑dessous (ils peuvent monter `~/.profile` dans le conteneur).

## Live Deepgram (transcription audio)

- Test : `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Activation : `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Runners Docker (vérifications optionnelles « fonctionne sous Linux »)

Ils exécutent `pnpm test:live` dans l’image Docker du dépôt, en montant votre répertoire de configuration local et l’espace de travail (et en sourçant `~/.profile` s’il est monté) :

- Modèles directs : `pnpm test:docker:live-models` (script : `scripts/test-live-models-docker.sh`)
- Gateway + agent de dev : `pnpm test:docker:live-gateway` (script : `scripts/test-live-gateway-models-docker.sh`)
- Assistant de prise en main (TTY, scaffolding complet) : `pnpm test:docker:onboard` (script : `scripts/e2e/onboard-docker.sh`)
- Réseau de la gateway (deux conteneurs, auth WS + santé) : `pnpm test:docker:gateway-network` (script : `scripts/e2e/gateway-network-docker.sh`)
- Plugins (chargement d’extensions personnalisées + smoke du registre) : `pnpm test:docker:plugins` (script : `scripts/e2e/plugins-docker.sh`)

Variables utiles de l'env :

- `OPENCLAW_CONFIG_DIR=...` (par défaut : `~/.openclaw`) monté sur `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (par défaut : `~/.openclaw/workspace`) monté sur `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (par défaut : `~/.profile`) monté sur `/home/node/.profile` et sourcé avant l’exécution des tests
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` pour restreindre l’exécution
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` pour garantir que les identifiants proviennent du magasin de profils (et non des variables d’environnement)

## Sanity des docs

Exécutez les vérifications de documentation après des modifications de docs : `pnpm docs:list`.

## Régressions hors ligne (compatibles CI)

Ce sont des régressions « pipeline réel » sans fournisseurs réels :

- Appels d’outils de la gateway (OpenAI simulé, vraie boucle gateway + agent) : `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Assistant de la gateway (WS `wizard.start`/`wizard.next`, écrit la config + authentification imposée) : `src/gateway/gateway.wizard.e2e.test.ts`

## Évaluations de fiabilité de l’agent (Skills)

Nous avons déjà quelques tests compatibles CI qui se comportent comme des « évaluations de fiabilité de l’agent » :

- Appels d’outils simulés via la vraie boucle gateway + agent (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- Flux d’assistant end‑to‑end qui valident le câblage des sessions et les effets de configuration (`src/gateway/gateway.wizard.e2e.test.ts`).

Ce qui manque encore pour les skills (voir [Skills](/tools/skills)) :

- **Décision** : lorsque les skills sont listées dans l’invite, l’agent choisit‑il la bonne skill (ou évite‑t‑il les non pertinentes) ?
- **Conformité** : l’agent lit‑il `SKILL.md` avant utilisation et suit‑il les étapes/arguments requis ?
- **Contrats de workflow** : scénarios multi‑tours qui valident l’ordre des outils, le report de l’historique de session et les limites de sandbox.

Les futures évaluations doivent rester déterministes d’abord :

- Un runner de scénarios utilisant des fournisseurs simulés pour vérifier les appels d’outils + l’ordre, la lecture des fichiers de skills et le câblage des sessions.
- Une petite suite de scénarios axés sur les skills (utiliser vs éviter, gating, injection d’invite).
- Des évaluations live optionnelles (opt‑in, contrôlées par env) uniquement après la mise en place de la suite compatible CI.

## Ajouter des régressions (recommandations)

Lorsque vous corrigez un problème de fournisseur/modèle découvert en live :

- Ajoutez une régression compatible CI si possible (fournisseur simulé/stub, ou capture exacte de la transformation de la forme de requête)
- Si c’est intrinsèquement live‑only (limites de débit, politiques d’authentification), gardez le test live étroit et opt‑in via des variables d’environnement
- Ciblez de préférence la couche la plus petite qui attrape le bug :
  - bug de conversion/relecture de requête fournisseur → test des modèles directs
  - bug du pipeline de session/historique/outils de la gateway → smoke live de la gateway ou test mock de la gateway compatible CI
