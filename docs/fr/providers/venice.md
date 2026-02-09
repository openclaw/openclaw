---
summary: "Utiliser les modeles Venice AI axes sur la confidentialite dans OpenClaw"
read_when:
  - Vous souhaitez une inference axee sur la confidentialite dans OpenClaw
  - Vous souhaitez des conseils de configuration pour Venice AI
title: "Venice AI"
---

# Venice AI (mise en avant Venice)

**Venice** est notre configuration Venice mise en avant pour une inference « privacy-first » avec un acces anonymise optionnel a des modeles proprietaires.

Venice AI fournit une inference d’IA axee sur la confidentialite, avec prise en charge de modeles non censurés et acces aux principaux modeles proprietaires via leur proxy anonymise. Toute inference est privee par defaut — aucune formation sur vos donnees, aucune journalisation.

## Pourquoi Venice dans OpenClaw

- **Inference privee** pour les modeles open source (aucune journalisation).
- **Modeles non censurés** lorsque vous en avez besoin.
- **Acces anonymise** aux modeles proprietaires (Opus/GPT/Gemini) lorsque la qualite prime.
- Points de terminaison compatibles OpenAI `/v1`.

## Modes de confidentialite

Venice propose deux niveaux de confidentialite — les comprendre est essentiel pour choisir votre modele :

| Mode          | Description                                                                                                                                                                    | Modeles                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Prive**     | Entierement prive. Les invites/reponses ne sont **jamais stockees ni journalisees**. Ephemeres.                                | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonymise** | Proxy via Venice avec metadonnees supprimees. Le fournisseur sous-jacent (OpenAI, Anthropic) voit des requetes anonymisees. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                       |

## Fonctionnalites

- **Axee sur la confidentialite** : Choisissez entre les modes « prive » (entierement prive) et « anonymise » (via proxy)
- **Modeles non censurés** : Acces a des modeles sans restrictions de contenu
- **Acces aux grands modeles** : Utilisez Claude, GPT-5.2, Gemini, Grok via le proxy anonymise de Venice
- **API compatible OpenAI** : Points de terminaison standard `/v1` pour une integration facile
- **Streaming** : ✅ Pris en charge sur tous les modeles
- **Appel de fonctions** : ✅ Pris en charge sur certains modeles (verifiez les capacites des modeles)
- **Vision** : ✅ Pris en charge sur les modeles avec capacite vision
- **Pas de limites strictes de debit** : Une limitation equilibree peut s’appliquer en cas d’usage extreme

## Configuration

### 1. Obtenir une cle API

1. Inscrivez-vous sur [venice.ai](https://venice.ai)
2. Allez dans **Settings → API Keys → Create new key**
3. Copiez votre cle API (format : `vapi_xxxxxxxxxxxx`)

### 2) Configurer OpenClaw

**Option A : Variable d’environnement**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Option B : Configuration interactive (recommandee)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Cela va :

1. Demander votre cle API (ou utiliser l’existante `VENICE_API_KEY`)
2. Afficher tous les modeles Venice disponibles
3. Vous permettre de choisir votre modele par defaut
4. Configurer automatiquement le fournisseur

**Option C : Non interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verifier la configuration

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Selection du modele

Apres la configuration, OpenClaw affiche tous les modeles Venice disponibles. Choisissez selon vos besoins :

- **Par defaut (notre choix)** : `venice/llama-3.3-70b` pour des performances equilibrees et privees.
- **Meilleure qualite globale** : `venice/claude-opus-45` pour les taches difficiles (Opus reste le plus performant).
- **Confidentialite** : Choisissez les modeles « prive » pour une inference entierement privee.
- **Capacites** : Choisissez les modeles « anonymise » pour acceder a Claude, GPT, Gemini via le proxy de Venice.

Changez votre modele par defaut a tout moment :

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Lister tous les modeles disponibles :

```bash
openclaw models list | grep venice
```

## Configurer via `openclaw configure`

1. Executez `openclaw configure`
2. Selectionnez **Model/auth**
3. Choisissez **Venice AI**

## Quel modele devrais-je utiliser ?

| Cas d’usage                          | Modele recommande                | Pourquoi                                                 |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------- |
| **Discussion generale**              | `llama-3.3-70b`                  | Bon polyvalent, entierement prive                        |
| **Meilleure qualite globale**        | `claude-opus-45`                 | Opus reste le plus performant pour les taches difficiles |
| **Confidentialite + qualite Claude** | `claude-opus-45`                 | Meilleur raisonnement via proxy anonymise                |
| **Developpement**                    | `qwen3-coder-480b-a35b-instruct` | Optimise pour le code, contexte 262k                     |
| **Taches de vision**                 | `qwen3-vl-235b-a22b`             | Meilleur modele de vision prive                          |
| **Non censure**                      | `venice-uncensored`              | Aucune restriction de contenu                            |
| **Rapide + economique**              | `qwen3-4b`                       | Leger, mais toujours capable                             |
| **Raisonnement complexe**            | `deepseek-v3.2`                  | Raisonnement solide, prive                               |

## Modeles disponibles (25 au total)

### Modeles prives (15) — Entierement prives, sans journalisation

| ID du modele                     | Nom                                        | Contexte (tokens) | Fonctionnalites           |
| -------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                 | General                   |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                 | Rapide, leger             |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                 | Taches complexes          |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                 | Raisonnement              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                 | General                   |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                 | Code                      |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                 | General                   |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                 | Vision                    |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                  | Rapide, raisonnement      |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                 | Raisonnement              |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                  | Non censure               |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                 | Vision                    |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                 | Vision                    |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                 | General                   |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                 | Raisonnement, multilingue |

### Modeles anonymises (10) — Via le proxy Venice

| ID du modele             | Original                          | Contexte (tokens) | Fonctionnalites      |
| ------------------------ | --------------------------------- | ------------------------------------ | -------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                 | Raisonnement, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                 | Raisonnement, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k                                 | Raisonnement         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                 | Raisonnement, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                 | Raisonnement, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                 | Raisonnement, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                 | Raisonnement, vision |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                 | Raisonnement, code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                 | Raisonnement         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                 | Raisonnement         |

## Decouverte des modeles

OpenClaw decouvre automatiquement les modeles depuis l’API Venice lorsque `VENICE_API_KEY` est defini. Si l’API est inaccessible, il revient a un catalogue statique.

Le point de terminaison `/models` est public (aucune authentification requise pour le listing), mais l’inference necessite une cle API valide.

## Streaming et prise en charge des outils

| Fonctionnalite         | Soutien                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| **Streaming**          | ✅ Tous les modeles                                                                          |
| **Appel de fonctions** | ✅ La plupart des modeles (verifiez `supportsFunctionCalling` dans l’API) |
| **Vision/Images**      | ✅ Modeles marques avec la fonctionnalite « Vision »                                         |
| **Mode JSON**          | ✅ Pris en charge via `response_format`                                                      |

## Tarification

Venice utilise un systeme base sur des credits. Consultez [venice.ai/pricing](https://venice.ai/pricing) pour les tarifs actuels :

- **Modeles prives** : Generalement moins chers
- **Modeles anonymises** : Similaires a la tarification directe des API + de faibles frais Venice

## Comparaison : Venice vs API directe

| Aspect              | Venice (anonymise)           | API directe                |
| ------------------- | ----------------------------------------------- | -------------------------- |
| **Confidentialite** | Metadonnees supprimees, anonymise               | Votre compte est lie       |
| **Latence**         | +10–50 ms (proxy)            | Direct                     |
| **Fonctionnalites** | La plupart des fonctionnalites prises en charge | Fonctionnalites completes  |
| **Facturation**     | Credits Venice                                  | Facturation du fournisseur |

## Exemples d’utilisation

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Problemes courants

### Cle API non reconnue

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Assurez-vous que la cle commence par `vapi_`.

### Modele non disponible

Le catalogue de modeles Venice se met a jour dynamiquement. Executez `openclaw models list` pour voir les modeles actuellement disponibles. Certains modeles peuvent etre temporairement hors ligne.

### Problemes de connexion

L’API Venice se trouve a `https://api.venice.ai/api/v1`. Assurez-vous que votre reseau autorise les connexions HTTPS.

## Exemple de fichier de configuration

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
- [Documentation de l’API](https://docs.venice.ai)
- [Tarification](https://venice.ai/pricing)
- [Statut](https://status.venice.ai)
