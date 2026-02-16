---
summary: "Utilisez les modèles Venice AI axés sur la confidentialité dans OpenClaw"
read_when:
  - Vous voulez une inférence axée sur la confidentialité dans OpenClaw
  - Vous voulez des conseils de configuration Venice AI
title: "Venice AI"
---

# Venice AI (Point fort Venice)

**Venice** est notre configuration Venice phare pour l'inférence axée confidentialité avec accès anonymisé optionnel aux modèles propriétaires.

Venice AI fournit une inférence IA axée confidentialité avec support de modèles non censurés et accès aux modèles propriétaires majeurs via leur proxy anonymisé. Toute inférence est privée par défaut—pas d'entraînement sur vos données, pas de journalisation.

## Pourquoi Venice dans OpenClaw

- **Inférence privée** pour modèles open-source (pas de journalisation).
- **Modèles non censurés** quand vous en avez besoin.
- **Accès anonymisé** aux modèles propriétaires (Opus/GPT/Gemini) quand la qualité compte.
- Points de terminaison `/v1` compatibles OpenAI.

## Modes de confidentialité

Venice offre deux niveaux de confidentialité — comprendre cela est clé pour choisir votre modèle :

| Mode          | Description                                                                                                                 | Modèles                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Privé**     | Totalement privé. Les prompts/réponses ne sont **jamais stockés ou journalisés**. Éphémère.                                 | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonymisé** | Proxy via Venice avec métadonnées supprimées. Le fournisseur sous-jacent (OpenAI, Anthropic) voit des requêtes anonymisées. | Claude, GPT, Gemini, Grok, Kimi, MiniMax       |

## Fonctionnalités

- **Axé confidentialité** : Choisissez entre modes "privé" (totalement privé) et "anonymisé" (proxy)
- **Modèles non censurés** : Accès aux modèles sans restrictions de contenu
- **Accès modèles majeurs** : Utilisez Claude, GPT-5.2, Gemini, Grok via le proxy anonymisé de Venice
- **API compatible OpenAI** : Points de terminaison `/v1` standards pour intégration facile
- **Streaming** : ✅ Supporté sur tous les modèles
- **Appel de fonction** : ✅ Supporté sur certains modèles (vérifier capacités modèle)
- **Vision** : ✅ Supporté sur modèles avec capacité vision
- **Pas de limites de taux strictes** : Throttling d'utilisation équitable peut s'appliquer pour utilisation extrême

## Configuration

### 1. Obtenir clé API

1. Inscrivez-vous sur [venice.ai](https://venice.ai)
2. Allez à **Paramètres → Clés API → Créer nouvelle clé**
3. Copiez votre clé API (format : `vapi_xxxxxxxxxxxx`)

### 2. Configurer OpenClaw

**Option A : Variable d'environnement**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Option B : Configuration interactive (Recommandé)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Cela va :

1. Demander votre clé API (ou utiliser `VENICE_API_KEY` existant)
2. Afficher tous les modèles Venice disponibles
3. Vous laisser choisir votre modèle par défaut
4. Configurer le fournisseur automatiquement

**Option C : Non-interactif**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Vérifier configuration

```bash
openclaw chat --model venice/llama-3.3-70b "Bonjour, fonctionnez-vous ?"
```

## Sélection de modèle

Après configuration, OpenClaw affiche tous les modèles Venice disponibles. Choisissez selon vos besoins :

- **Par défaut (notre choix)** : `venice/llama-3.3-70b` pour privé, performance équilibrée.
- **Meilleure qualité globale** : `venice/claude-opus-45` pour tâches difficiles (Opus reste le plus fort).
- **Confidentialité** : Choisissez modèles "privés" pour inférence totalement privée.
- **Capacité** : Choisissez modèles "anonymisés" pour accéder Claude, GPT, Gemini via le proxy Venice.

Changez votre modèle par défaut à tout moment :

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Listez tous les modèles disponibles :

```bash
openclaw models list | grep venice
```

## Configurer via `openclaw configure`

1. Exécutez `openclaw configure`
2. Sélectionnez **Model/auth**
3. Choisissez **Venice AI**

## Quel modèle dois-je utiliser ?

| Cas d'utilisation                    | Modèle recommandé                | Pourquoi                                       |
| ------------------------------------ | -------------------------------- | ---------------------------------------------- |
| **Chat général**                     | `llama-3.3-70b`                  | Bon polyvalent, totalement privé               |
| **Meilleure qualité globale**        | `claude-opus-45`                 | Opus reste le plus fort pour tâches difficiles |
| **Confidentialité + qualité Claude** | `claude-opus-45`                 | Meilleur raisonnement via proxy anonymisé      |
| **Codage**                           | `qwen3-coder-480b-a35b-instruct` | Optimisé code, contexte 262k                   |
| **Tâches vision**                    | `qwen3-vl-235b-a22b`             | Meilleur modèle vision privé                   |
| **Non censuré**                      | `venice-uncensored`              | Pas de restrictions de contenu                 |
| **Rapide + pas cher**                | `qwen3-4b`                       | Léger, toujours capable                        |
| **Raisonnement complexe**            | `deepseek-v3.2`                  | Raisonnement fort, privé                       |

## Modèles disponibles (25 Total)

### Modèles privés (15) — Totalement privé, pas de journalisation

| ID Modèle                        | Nom                     | Contexte (tokens) | Fonctionnalités           |
| -------------------------------- | ----------------------- | ----------------- | ------------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k              | Général                   |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k              | Rapide, léger             |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k              | Tâches complexes          |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k              | Raisonnement              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k              | Général                   |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k              | Code                      |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k              | Général                   |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k              | Vision                    |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k               | Rapide, raisonnement      |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k              | Raisonnement              |
| `venice-uncensored`              | Venice Uncensored       | 32k               | Non censuré               |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k              | Vision                    |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k              | Vision                    |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k              | Général                   |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k              | Raisonnement, multilingue |

### Modèles anonymisés (10) — Via proxy Venice

| ID Modèle                | Original          | Contexte (tokens) | Fonctionnalités      |
| ------------------------ | ----------------- | ----------------- | -------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k              | Raisonnement, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k              | Raisonnement, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k              | Raisonnement         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k              | Raisonnement, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k              | Raisonnement, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k              | Raisonnement, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k              | Raisonnement, vision |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k              | Raisonnement, code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k              | Raisonnement         |
| `minimax-m21`            | MiniMax M2.1      | 202k              | Raisonnement         |

## Découverte de modèle

OpenClaw découvre automatiquement les modèles depuis l'API Venice quand `VENICE_API_KEY` est défini. Si l'API est inaccessible, il se replie sur un catalogue statique.

Le point de terminaison `/models` est public (pas d'auth nécessaire pour listage), mais l'inférence nécessite une clé API valide.

## Support streaming & outil

| Fonctionnalité        | Support                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| **Streaming**         | ✅ Tous les modèles                                                     |
| **Appel de fonction** | ✅ La plupart des modèles (vérifier `supportsFunctionCalling` dans API) |
| **Vision/Images**     | ✅ Modèles marqués avec fonctionnalité "Vision"                         |
| **Mode JSON**         | ✅ Supporté via `response_format`                                       |

## Tarification

Venice utilise un système basé sur les crédits. Vérifiez [venice.ai/pricing](https://venice.ai/pricing) pour les tarifs actuels :

- **Modèles privés** : Généralement coût plus bas
- **Modèles anonymisés** : Similaire à tarification API directe + petits frais Venice

## Comparaison : Venice vs API directe

| Aspect              | Venice (Anonymisé)                | API directe               |
| ------------------- | --------------------------------- | ------------------------- |
| **Confidentialité** | Métadonnées supprimées, anonymisé | Votre compte lié          |
| **Latence**         | +10-50ms (proxy)                  | Direct                    |
| **Fonctionnalités** | La plupart supportées             | Fonctionnalités complètes |
| **Facturation**     | Crédits Venice                    | Facturation fournisseur   |

## Exemples d'utilisation

```bash
# Utiliser modèle privé par défaut
openclaw chat --model venice/llama-3.3-70b

# Utiliser Claude via Venice (anonymisé)
openclaw chat --model venice/claude-opus-45

# Utiliser modèle non censuré
openclaw chat --model venice/venice-uncensored

# Utiliser modèle vision avec image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Utiliser modèle codage
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Dépannage

### Clé API non reconnue

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Assurez-vous que la clé commence par `vapi_`.

### Modèle non disponible

Le catalogue de modèle Venice se met à jour dynamiquement. Exécutez `openclaw models list` pour voir les modèles actuellement disponibles. Certains modèles peuvent être temporairement hors ligne.

### Problèmes de connexion

L'API Venice est à `https://api.venice.ai/api/v1`. Assurez-vous que votre réseau autorise les connexions HTTPS.

## Exemple de fichier config

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Liens

- [Venice AI](https://venice.ai)
- [Documentation API](https://docs.venice.ai)
- [Tarification](https://venice.ai/pricing)
- [Statut](https://status.venice.ai)
