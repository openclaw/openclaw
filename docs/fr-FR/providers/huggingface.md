---
summary: "Configuration Hugging Face Inference (auth + sélection de modèle)"
read_when:
  - Vous voulez utiliser Hugging Face Inference avec OpenClaw
  - Vous avez besoin de la variable env token HF ou du choix auth CLI
title: "Hugging Face (Inference)"
---

# Hugging Face (Inference)

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) offre des complétions de chat compatibles OpenAI via une API routeur unique. Vous obtenez l'accès à de nombreux modèles (DeepSeek, Llama, et plus) avec un seul token. OpenClaw utilise le **point de terminaison compatible OpenAI** (complétions de chat uniquement) ; pour texte-vers-image, embeddings, ou parole utilisez les [clients d'inférence HF](https://huggingface.co/docs/api-inference/quicktour) directement.

- Fournisseur : `huggingface`
- Auth : `HUGGINGFACE_HUB_TOKEN` ou `HF_TOKEN` (token à granularité fine avec **Faire des appels aux Fournisseurs d'Inférence**)
- API : compatible OpenAI (`https://router.huggingface.co/v1`)
- Facturation : Token HF unique ; [tarification](https://huggingface.co/docs/inference-providers/pricing) suit les tarifs de fournisseur avec un niveau gratuit.

## Démarrage rapide

1. Créez un token à granularité fine sur [Hugging Face → Paramètres → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) avec la permission **Faire des appels aux Fournisseurs d'Inférence**.
2. Exécutez l'onboarding et choisissez **Hugging Face** dans le menu déroulant fournisseur, puis entrez votre clé API lorsque demandé :

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. Dans le menu déroulant **Modèle Hugging Face par défaut**, choisissez le modèle que vous voulez (la liste est chargée depuis l'API Inference quand vous avez un token valide ; sinon une liste intégrée est affichée). Votre choix est sauvegardé comme modèle par défaut.
4. Vous pouvez aussi définir ou changer le modèle par défaut plus tard dans la config :

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## Exemple non-interactif

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

Cela définira `huggingface/deepseek-ai/DeepSeek-R1` comme modèle par défaut.

## Note d'environnement

Si la Passerelle s'exécute comme un daemon (launchd/systemd), assurez-vous que `HUGGINGFACE_HUB_TOKEN` ou `HF_TOKEN` est disponible pour ce processus (par exemple, dans `~/.openclaw/.env` ou via `env.shellEnv`).

## Découverte de modèle et menu déroulant onboarding

OpenClaw découvre les modèles en appelant le **point de terminaison Inference directement** :

```bash
GET https://router.huggingface.co/v1/models
```

(Optionnel : envoyez `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` ou `$HF_TOKEN` pour la liste complète ; certains points de terminaison retournent un sous-ensemble sans auth.) La réponse est style OpenAI `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`.

Quand vous configurez une clé API Hugging Face (via onboarding, `HUGGINGFACE_HUB_TOKEN`, ou `HF_TOKEN`), OpenClaw utilise ce GET pour découvrir les modèles de complétion de chat disponibles. Pendant l'**onboarding interactif**, après avoir entré votre token vous voyez un menu déroulant **Modèle Hugging Face par défaut** rempli depuis cette liste (ou le catalogue intégré si la requête échoue). Au runtime (par ex. démarrage Passerelle), quand une clé est présente, OpenClaw appelle à nouveau **GET** `https://router.huggingface.co/v1/models` pour rafraîchir le catalogue. La liste est fusionnée avec un catalogue intégré (pour métadonnées comme fenêtre de contexte et coût). Si la requête échoue ou aucune clé n'est définie, seul le catalogue intégré est utilisé.

## Noms de modèle et options éditables

- **Nom depuis API :** Le nom d'affichage du modèle est **hydraté depuis GET /v1/models** quand l'API retourne `name`, `title`, ou `display_name` ; sinon il est dérivé de l'id du modèle (par ex. `deepseek-ai/DeepSeek-R1` → "DeepSeek R1").
- **Remplacer nom d'affichage :** Vous pouvez définir une étiquette personnalisée par modèle dans la config pour qu'elle apparaisse comme vous voulez dans la CLI et l'UI :

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (rapide)" },
        "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (pas cher)" },
      },
    },
  },
}
```

- **Sélection fournisseur / politique :** Ajoutez un suffixe à l'**id du modèle** pour choisir comment le routeur choisit le backend :
  - **`:fastest`** — débit le plus élevé (le routeur choisit ; le choix de fournisseur est **verrouillé** — pas de sélecteur de backend interactif).
  - **`:cheapest`** — coût le plus bas par token de sortie (le routeur choisit ; le choix de fournisseur est **verrouillé**).
  - **`:provider`** — forcer un backend spécifique (par ex. `:sambanova`, `:together`).

  Quand vous sélectionnez **:cheapest** ou **:fastest** (par ex. dans le menu déroulant modèle onboarding), le fournisseur est verrouillé : le routeur décide par coût ou vitesse et aucune étape optionnelle "préférer backend spécifique" n'est affichée. Vous pouvez ajouter ces entrées séparément dans `models.providers.huggingface.models` ou définir `model.primary` avec le suffixe. Vous pouvez aussi définir votre ordre par défaut dans [paramètres Inference Provider](https://hf.co/settings/inference-providers) (pas de suffixe = utiliser cet ordre).

- **Fusion config :** Les entrées existantes dans `models.providers.huggingface.models` (par ex. dans `models.json`) sont conservées quand la config est fusionnée. Donc tout `name`, `alias`, ou options de modèle personnalisés que vous définissez là sont préservés.

## IDs de modèle et exemples de configuration

Les références de modèle utilisent la forme `huggingface/<org>/<model>` (IDs style Hub). La liste ci-dessous est de **GET** `https://router.huggingface.co/v1/models` ; votre catalogue peut en inclure plus.

**Exemples d'IDs (depuis le point de terminaison inference) :**

| Modèle                 | Ref (préfixer avec `huggingface/`)  |
| ---------------------- | ----------------------------------- |
| DeepSeek R1            | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2          | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B               | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct    | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B              | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct  | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B           | `openai/gpt-oss-120b`               |
| GLM 4.7                | `zai-org/GLM-4.7`                   |
| Kimi K2.5              | `moonshotai/Kimi-K2.5`              |

Vous pouvez ajouter `:fastest`, `:cheapest`, ou `:provider` (par ex. `:together`, `:sambanova`) à l'id du modèle. Définissez votre ordre par défaut dans [paramètres Inference Provider](https://hf.co/settings/inference-providers) ; voir [Inference Providers](https://huggingface.co/docs/inference-providers) et **GET** `https://router.huggingface.co/v1/models` pour la liste complète.

### Exemples de configuration complète

**DeepSeek R1 principal avec repli Qwen :**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-R1",
        fallbacks: ["huggingface/Qwen/Qwen3-8B"],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
      },
    },
  },
}
```

**Qwen par défaut, avec variantes :cheapest et :fastest :**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3-8B" },
      models: {
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
        "huggingface/Qwen/Qwen3-8B:cheapest": { alias: "Qwen3 8B (moins cher)" },
        "huggingface/Qwen/Qwen3-8B:fastest": { alias: "Qwen3 8B (plus rapide)" },
      },
    },
  },
}
```

**DeepSeek + Llama + GPT-OSS avec alias :**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-V3.2",
        fallbacks: [
          "huggingface/meta-llama/Llama-3.3-70B-Instruct",
          "huggingface/openai/gpt-oss-120b",
        ],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-V3.2": { alias: "DeepSeek V3.2" },
        "huggingface/meta-llama/Llama-3.3-70B-Instruct": { alias: "Llama 3.3 70B" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```

**Forcer un backend spécifique avec :provider :**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**Plusieurs modèles Qwen et DeepSeek avec suffixes de politique :**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest" },
      models: {
        "huggingface/Qwen/Qwen2.5-7B-Instruct": { alias: "Qwen2.5 7B" },
        "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest": { alias: "Qwen2.5 7B (pas cher)" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (rapide)" },
        "huggingface/meta-llama/Llama-3.1-8B-Instruct": { alias: "Llama 3.1 8B" },
      },
    },
  },
}
```
