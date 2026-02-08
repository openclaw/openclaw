---
summary: "Kit de test : suites unitaires/e2e/live, runners Docker et ce que couvre chaque test"
read_when:
  - Exécuter les tests en local ou en CI
  - Ajouter des régressions pour des bugs de modele/fournisseur
  - Déboguer le comportement de la passerelle et de l’agent
title: "Tests"
x-i18n:
  source_path: testing.md
  source_hash: 7a23ced0e6e3be5e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:03:31Z
---

# Tests

OpenClaw dispose de trois suites Vitest (unitaires/intégration, e2e, live) et d’un petit ensemble de runners Docker.

Ce document est un guide « comment nous testons » :

- Ce que couvre chaque suite (et ce qu’elle ne couvre délibérément _pas_)
- Quelles commandes exécuter pour les workflows courants (local, pré-push, débogage)
- Comment les tests live découvrent les identifiants et sélectionnent les modeles/fournisseurs
- Comment ajouter des régressions pour des problèmes réels de modele/fournisseur

## Demarrage rapide

La plupart des jours :

- Porte complète (attendue avant push) : `pnpm build && pnpm check && pnpm test`

Quand vous modifiez des tests ou voulez plus de confiance :

- Porte de couverture : `pnpm test:coverage`
- Suite E2E : `pnpm test:e2e`

Lors du débogage de fournisseurs/modeles réels (nécessite de vrais identifiants) :

- Suite live (sondes des modeles + outils/images de la Gateway) : `pnpm test:live`

Astuce : quand vous n’avez besoin que d’un seul cas en échec, préférez restreindre les tests live via les variables d’environnement d’allowlist décrites ci-dessous.

## Suites de tests (où s’exécute quoi)

Considérez les suites comme une « réalité croissante » (et une instabilité/coût croissants) :

### Unitaires / intégration (par défaut)

- Commande : `pnpm test`
- Config : `vitest.config.ts`
- Fichiers : `src/**/*.test.ts`
- Portée :
  - Tests unitaires purs
  - Tests d’intégration en processus (authentification de la Gateway, routage, outillage, parsing, config)
  - Régressions déterministes pour des bugs connus
- Attentes :
  - S’exécute en CI
  - Aucune clé réelle requise
  - Doit être rapide et stable

### E2E (fumée de la Gateway)

- Commande : `pnpm test:e2e`
- Config : `vitest.e2e.config.ts`
- Fichiers : `src/**/*.e2e.test.ts`
- Portée :
  - Comportement de bout en bout de la Gateway multi-instances
  - Surfaces WebSocket/HTTP, appairage de nœuds et réseau plus lourd
- Attentes :
  - S’exécute en CI (lorsqu’activée dans le pipeline)
  - Aucune clé réelle requise
  - Plus de pièces mobiles que les tests unitaires (peut être plus lent)

### Live (fournisseurs réels + modeles réels)

- Commande : `pnpm test:live`
- Config : `vitest.live.config.ts`
- Fichiers : `src/**/*.live.test.ts`
- Par défaut : **activée** par `pnpm test:live` (définit `OPENCLAW_LIVE_TEST=1`)
- Portée :
  - « Ce fournisseur/modele fonctionne-t-il vraiment _aujourd’hui_ avec de vrais identifiants ? »
  - Détecter les changements de format fournisseur, bizarreries d’appel d’outils, problèmes d’authentification et comportements de limitation de débit
- Attentes :
  - Non stable en CI par conception (réseaux réels, politiques fournisseurs réelles, quotas, pannes)
  - Coûte de l’argent / consomme des quotas
  - Préférer exécuter des sous-ensembles restreints plutôt que « tout »
  - Les exécutions live sourceront `~/.profile` pour récupérer les clés API manquantes
  - Rotation des clés Anthropic : définissez `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (ou `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) ou plusieurs variables `ANTHROPIC_API_KEY*` ; les tests réessaieront en cas de limites de débit

## Quelle suite dois-je exécuter ?

Utilisez ce tableau de décision :

- Édition de logique/tests : exécutez `pnpm test` (et `pnpm test:coverage` si vous avez beaucoup modifié)
- Modification du réseau de la Gateway / protocole WS / appairage : ajoutez `pnpm test:e2e`
- Débogage « mon bot est en panne » / échecs spécifiques à un fournisseur / appel d’outils : exécutez un `pnpm test:live` restreint

## Live : fumée des modeles (clés de profil)

Les tests live sont divisés en deux couches afin d’isoler les échecs :

- Le « modele direct » indique si le fournisseur/modele peut répondre avec la clé fournie.
- La « fumée Gateway » indique si l’ensemble du pipeline Gateway+agent fonctionne pour ce modele (sessions, historique, outils, politique de sandbox, etc.).

### Couche 1 : complétion directe du modele (sans Gateway)

- Test : `src/agents/models.profiles.live.test.ts`
- Objectif :
  - Énumérer les modeles découverts
  - Utiliser `getApiKeyForModel` pour sélectionner les modeles pour lesquels vous avez des identifiants
  - Exécuter une petite complétion par modele (et des régressions ciblées si nécessaire)
- Comment activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si vous invoquez Vitest directement)
- Définissez `OPENCLAW_LIVE_MODELS=modern` (ou `all`, alias moderne) pour exécuter réellement cette suite ; sinon elle est ignorée afin de garder `pnpm test:live` focalisée sur la fumée Gateway
- Comment sélectionner les modeles :
  - `OPENCLAW_LIVE_MODELS=modern` pour exécuter l’allowlist moderne (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` est un alias de l’allowlist moderne
  - ou `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (allowlist séparée par des virgules)
- Comment sélectionner les fournisseurs :
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (allowlist séparée par des virgules)
- D’où viennent les clés :
  - Par défaut : magasin de profils et replis env
  - Définissez `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` pour imposer **uniquement** le magasin de profils
- Pourquoi cela existe :
  - Sépare « l’API fournisseur est cassée / la clé est invalide » de « le pipeline agent de la Gateway est cassé »
  - Contient de petites régressions isolées (exemple : OpenAI Responses/Codex Responses, relecture de raisonnement + flux d’appel d’outils)

### Couche 2 : fumée Gateway + agent de dev (ce que fait réellement « @openclaw »)

- Test : `src/gateway/gateway-models.profiles.live.test.ts`
- Objectif :
  - Démarrer une Gateway en processus
  - Créer/modifier une session `agent:dev:*` (remplacement du modele par exécution)
  - Itérer sur les modeles-avec-clés et vérifier :
    - une réponse « significative » (sans outils)
    - qu’une invocation d’outil réelle fonctionne (sonde de lecture)
    - des sondes d’outils supplémentaires optionnelles (sonde exec+read)
    - que les chemins de régression OpenAI (appel d’outil seul → suivi) continuent de fonctionner
- Détails des sondes (pour expliquer rapidement les échecs) :
  - Sonde `read` : le test écrit un fichier nonce dans l’espace de travail et demande à l’agent de le `read` et de renvoyer le nonce.
  - Sonde `exec+read` : le test demande à l’agent d’`exec`-écrire un nonce dans un fichier temporaire, puis de le `read`.
  - Sonde image : le test joint un PNG généré (chat + code aléatoire) et attend que le modele renvoie `cat <CODE>`.
  - Référence d’implémentation : `src/gateway/gateway-models.profiles.live.test.ts` et `src/gateway/live-image-probe.ts`.
- Comment activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si vous invoquez Vitest directement)
- Comment sélectionner les modeles :
  - Par défaut : allowlist moderne (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` est un alias de l’allowlist moderne
  - Ou définissez `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (ou une liste séparée par des virgules) pour restreindre
- Comment sélectionner les fournisseurs (éviter « OpenRouter tout ») :
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (allowlist séparée par des virgules)
- Les sondes d’outils + d’images sont toujours activées dans ce test live :
  - Sonde `read` + sonde `exec+read` (stress d’outils)
  - La sonde image s’exécute lorsque le modele annonce le support des entrées image
  - Flux (vue d’ensemble) :
    - Le test génère un petit PNG avec « CAT » + code aléatoire (`src/gateway/live-image-probe.ts`)
    - L’envoie via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - La Gateway parse les pièces jointes en `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - L’agent embarqué transmet un message utilisateur multimodal au modele
    - Assertion : la réponse contient `cat` + le code (tolérance OCR : erreurs mineures autorisées)

Astuce : pour voir ce que vous pouvez tester sur votre machine (et les identifiants `provider/model` exacts), exécutez :

```bash
openclaw models list
openclaw models list --json
```

## Live : fumée setup-token Anthropic

- Test : `src/agents/anthropic.setup-token.live.test.ts`
- Objectif : vérifier que le setup-token du CLI Claude Code (ou un profil setup-token collé) peut compléter une invite Anthropic.
- Activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si vous invoquez Vitest directement)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Sources de token (choisissez-en une) :
  - Profil : `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Token brut : `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Remplacement de modele (optionnel) :
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Exemple de configuration :

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live : fumée backend CLI (Claude Code CLI ou autres CLIs locaux)

- Test : `src/gateway/gateway-cli-backend.live.test.ts`
- Objectif : valider le pipeline Gateway + agent en utilisant un backend CLI local, sans toucher à votre configuration par défaut.
- Activer :
  - `pnpm test:live` (ou `OPENCLAW_LIVE_TEST=1` si vous invoquez Vitest directement)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Valeurs par défaut :
  - Modele : `claude-cli/claude-sonnet-4-5`
  - Commande : `claude`
  - Arguments : `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Remplacements (optionnels) :
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` pour envoyer une pièce jointe image réelle (les chemins sont injectés dans l’invite).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` pour passer les chemins de fichiers image comme arguments CLI au lieu de l’injection dans l’invite.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (ou `"list"`) pour contrôler la façon dont les arguments image sont passés lorsque `IMAGE_ARG` est défini.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` pour envoyer un second tour et valider le flux de reprise.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` pour conserver la configuration MCP du CLI Claude Code activée (par défaut, la configuration MCP est désactivée avec un fichier vide temporaire).

Exemple :

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Recettes live recommandées

Des allowlists étroites et explicites sont les plus rapides et les moins instables :

- Modele unique, direct (sans Gateway) :
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Modele unique, fumée Gateway :
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Appel d’outils sur plusieurs fournisseurs :
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Focus Google (clé API Gemini + Antigravity) :
  - Gemini (clé API) : `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth) : `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-5-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notes :

- `google/...` utilise l’API Gemini (clé API).
- `google-antigravity/...` utilise le pont OAuth Antigravity (endpoint d’agent de type Cloud Code Assist).
- `google-gemini-cli/...` utilise le CLI Gemini local sur votre machine (authentification et particularités d’outillage distinctes).
- API Gemini vs CLI Gemini :
  - API : OpenClaw appelle l’API Gemini hébergée de Google via HTTP (clé API / auth par profil) ; c’est ce que la plupart des utilisateurs entendent par « Gemini ».
  - CLI : OpenClaw exécute un binaire local `gemini` ; il a sa propre auth et peut se comporter différemment (streaming/support d’outils/décalage de versions).

## Live : matrice de modeles (ce que nous couvrons)

Il n’existe pas de « liste de modeles CI » fixe (le live est opt-in), mais voici les modeles **recommandés** à couvrir régulièrement sur une machine de dev avec des clés.

### Ensemble de fumée moderne (appel d’outils + image)

C’est l’exécution des « modeles courants » que nous attendons fonctionnelle :

- OpenAI (hors Codex) : `openai/gpt-5.2` (optionnel : `openai/gpt-5.1`)
- OpenAI Codex : `openai-codex/gpt-5.3-codex` (optionnel : `openai-codex/gpt-5.3-codex-codex`)
- Anthropic : `anthropic/claude-opus-4-6` (ou `anthropic/claude-sonnet-4-5`)
- Google (API Gemini) : `google/gemini-3-pro-preview` et `google/gemini-3-flash-preview` (éviter les anciens modeles Gemini 2.x)
- Google (Antigravity) : `google-antigravity/claude-opus-4-5-thinking` et `google-antigravity/gemini-3-flash`
- Z.AI (GLM) : `zai/glm-4.7`
- MiniMax : `minimax/minimax-m2.1`

Exécuter la fumée Gateway avec outils + image :
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-5-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Base : appel d’outils (Read + Exec optionnel)

Choisissez au moins un par famille de fournisseurs :

- OpenAI : `openai/gpt-5.2` (ou `openai/gpt-5-mini`)
- Anthropic : `anthropic/claude-opus-4-6` (ou `anthropic/claude-sonnet-4-5`)
- Google : `google/gemini-3-flash-preview` (ou `google/gemini-3-pro-preview`)
- Z.AI (GLM) : `zai/glm-4.7`
- MiniMax : `minimax/minimax-m2.1`

Couverture additionnelle optionnelle (agréable à avoir) :

- xAI : `xai/grok-4` (ou la plus récente disponible)
- Mistral : `mistral/`… (choisissez un modele « tools » que vous avez activé)
- Cerebras : `cerebras/`… (si vous avez accès)
- LM Studio : `lmstudio/`… (local ; l’appel d’outils dépend du mode API)

### Vision : envoi d’image (pièce jointe → message multimodal)

Incluez au moins un modele compatible image dans `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI avec capacités vision, etc.) pour exercer la sonde image.

### Agrégateurs / passerelles alternatives

Si vous avez des clés activées, nous prenons aussi en charge les tests via :

- OpenRouter : `openrouter/...` (des centaines de modeles ; utilisez `openclaw models scan` pour trouver des candidats compatibles outils+image)
- OpenCode Zen : `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Autres fournisseurs que vous pouvez inclure dans la matrice live (si vous avez les identifiants/config) :

- Intégrés : `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (endpoints personnalisés) : `minimax` (cloud/API), plus tout proxy compatible OpenAI/Anthropic (LM Studio, vLLM, LiteLLM, etc.)

Astuce : n’essayez pas de coder en dur « tous les modeles » dans la documentation. La liste faisant autorité est ce que renvoie `discoverModels(...)` sur votre machine + les clés disponibles.

## Identifiants (ne jamais committer)

Les tests live découvrent les identifiants de la même manière que la CLI. Implications pratiques :

- Si la CLI fonctionne, les tests live devraient trouver les mêmes clés.
- Si un test live indique « pas d’identifiants », déboguez de la même façon que pour `openclaw models list` / la sélection de modele.

- Magasin de profils : `~/.openclaw/credentials/` (préféré ; c’est ce que signifient « clés de profil » dans les tests)
- Config : `~/.openclaw/openclaw.json` (ou `OPENCLAW_CONFIG_PATH`)

Si vous souhaitez vous appuyer sur des clés env (par ex. exportées dans votre `~/.profile`), exécutez les tests locaux après `source ~/.profile`, ou utilisez les runners Docker ci-dessous (ils peuvent monter `~/.profile` dans le conteneur).

## Live Deepgram (transcription audio)

- Test : `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Activer : `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Runners Docker (vérifications optionnelles « fonctionne sous Linux »)

Ils exécutent `pnpm test:live` dans l’image Docker du dépôt, en montant votre répertoire de config local et l’espace de travail (et en sourçant `~/.profile` s’il est monté) :

- Modeles directs : `pnpm test:docker:live-models` (script : `scripts/test-live-models-docker.sh`)
- Gateway + agent de dev : `pnpm test:docker:live-gateway` (script : `scripts/test-live-gateway-models-docker.sh`)
- Assistant de prise en main (TTY, scaffolding complet) : `pnpm test:docker:onboard` (script : `scripts/e2e/onboard-docker.sh`)
- Réseau de la Gateway (deux conteneurs, auth WS + santé) : `pnpm test:docker:gateway-network` (script : `scripts/e2e/gateway-network-docker.sh`)
- Plugins (chargement d’extension personnalisée + fumée du registre) : `pnpm test:docker:plugins` (script : `scripts/e2e/plugins-docker.sh`)

Variables d’environnement utiles :

- `OPENCLAW_CONFIG_DIR=...` (défaut : `~/.openclaw`) monté sur `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (défaut : `~/.openclaw/workspace`) monté sur `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (défaut : `~/.profile`) monté sur `/home/node/.profile` et sourcé avant l’exécution des tests
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` pour restreindre l’exécution
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` pour s’assurer que les identifiants proviennent du magasin de profils (et non des variables env)

## Cohérence de la documentation

Exécutez les vérifications de docs après des modifications : `pnpm docs:list`.

## Régression hors ligne (compatible CI)

Il s’agit de régressions de « pipeline réel » sans fournisseurs réels :

- Appel d’outils de la Gateway (OpenAI simulé, vraie boucle Gateway + agent) : `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Assistant de la Gateway (WS `wizard.start`/`wizard.next`, écrit la config + auth imposée) : `src/gateway/gateway.wizard.e2e.test.ts`

## Évaluations de fiabilité de l’agent (Skills)

Nous avons déjà quelques tests compatibles CI qui se comportent comme des « évaluations de fiabilité de l’agent » :

- Appel d’outils simulé via la vraie boucle Gateway + agent (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- Flux d’assistant de bout en bout qui valident le câblage de session et les effets de configuration (`src/gateway/gateway.wizard.e2e.test.ts`).

Ce qui manque encore pour les skills (voir [Skills](/tools/skills)) :

- **Décision** : lorsque des skills sont listées dans l’invite, l’agent choisit-il la bonne skill (ou évite-t-il les non pertinentes) ?
- **Conformité** : l’agent lit-il `SKILL.md` avant utilisation et suit-il les étapes/arguments requis ?
- **Contrats de workflow** : scénarios multi-tours qui vérifient l’ordre des outils, la reprise de l’historique de session et les limites de sandbox.

Les évaluations futures devraient rester déterministes en priorité :

- Un exécuteur de scénarios utilisant des fournisseurs simulés pour vérifier les appels d’outils + l’ordre, les lectures de fichiers de skills et le câblage de session.
- Une petite suite de scénarios centrés sur les skills (utiliser vs éviter, garde-fous, injection d’invite).
- Des évaluations live optionnelles (opt-in, contrôlées par env) uniquement après la mise en place de la suite compatible CI.

## Ajout de régressions (recommandations)

Lorsque vous corrigez un problème fournisseur/modele découvert en live :

- Ajoutez une régression compatible CI si possible (simuler/stubber le fournisseur, ou capturer exactement la transformation de la forme de requête)
- Si c’est intrinsèquement live-only (limites de débit, politiques d’authentification), gardez le test live étroit et opt-in via des variables d’environnement
- Préférez cibler la plus petite couche qui détecte le bug :
  - bug de conversion/relecture de requête fournisseur → test des modeles directs
  - bug de pipeline session/historique/outils de la Gateway → fumée live Gateway ou test simulé de la Gateway compatible CI
