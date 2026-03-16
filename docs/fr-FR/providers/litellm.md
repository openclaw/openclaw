---
summary: "Exécutez OpenClaw via LiteLLM Proxy pour un accès unifié aux modèles et un suivi des coûts"
read_when:
  - Vous voulez router OpenClaw via un proxy LiteLLM
  - Vous avez besoin de suivi des coûts, journalisation, ou routage de modèle via LiteLLM
---

# LiteLLM

[LiteLLM](https://litellm.ai) est une passerelle LLM open-source qui fournit une API unifiée vers plus de 100 fournisseurs de modèles. Routez OpenClaw via LiteLLM pour obtenir un suivi centralisé des coûts, une journalisation, et la flexibilité de changer de backends sans modifier votre config OpenClaw.

## Pourquoi utiliser LiteLLM avec OpenClaw ?

- **Suivi des coûts** — Voyez exactement ce qu'OpenClaw dépense sur tous les modèles
- **Routage de modèle** — Basculez entre Claude, GPT-4, Gemini, Bedrock sans changements de config
- **Clés virtuelles** — Créez des clés avec limites de dépense pour OpenClaw
- **Journalisation** — Journaux complets requête/réponse pour le débogage
- **Replis** — Basculement automatique si votre fournisseur principal est en panne

## Démarrage rapide

### Via onboarding

```bash
openclaw onboard --auth-choice litellm-api-key
```

### Configuration manuelle

1. Démarrez LiteLLM Proxy :

```bash
pip install 'litellm[proxy]'
litellm --model claude-opus-4-6
```

2. Pointez OpenClaw vers LiteLLM :

```bash
export LITELLM_API_KEY="votre-clé-litellm"

openclaw
```

C'est tout. OpenClaw route maintenant via LiteLLM.

## Configuration

### Variables d'environnement

```bash
export LITELLM_API_KEY="sk-clé-litellm"
```

### Fichier de config

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-opus-4-6" },
    },
  },
}
```

## Clés virtuelles

Créez une clé dédiée pour OpenClaw avec limites de dépense :

```bash
curl -X POST "http://localhost:4000/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key_alias": "openclaw",
    "max_budget": 50.00,
    "budget_duration": "monthly"
  }'
```

Utilisez la clé générée comme `LITELLM_API_KEY`.

## Routage de modèle

LiteLLM peut router les requêtes de modèle vers différents backends. Configurez dans votre `config.yaml` LiteLLM :

```yaml
model_list:
  - model_name: claude-opus-4-6
    litellm_params:
      model: claude-opus-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: gpt-4o
    litellm_params:
      model: gpt-4o
      api_key: os.environ/OPENAI_API_KEY
```

OpenClaw continue de demander `claude-opus-4-6` — LiteLLM gère le routage.

## Visualisation de l'utilisation

Vérifiez le tableau de bord ou l'API de LiteLLM :

```bash
# Info de clé
curl "http://localhost:4000/key/info" \
  -H "Authorization: Bearer sk-clé-litellm"

# Journaux de dépenses
curl "http://localhost:4000/spend/logs" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## Notes

- LiteLLM s'exécute sur `http://localhost:4000` par défaut
- OpenClaw se connecte via le point de terminaison compatible OpenAI `/v1/chat/completions`
- Toutes les fonctionnalités OpenClaw fonctionnent via LiteLLM — aucune limitation

## Voir aussi

- [Docs LiteLLM](https://docs.litellm.ai)
- [Fournisseurs de Modèle](/fr-FR/concepts/model-providers)
