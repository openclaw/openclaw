---
summary: "Exécutez OpenClaw avec vLLM (serveur local compatible OpenAI)"
read_when:
  - Vous voulez exécuter OpenClaw contre un serveur vLLM local
  - Vous voulez des points de terminaison /v1 compatibles OpenAI avec vos propres modèles
title: "vLLM"
---

# vLLM

vLLM peut servir des modèles open-source (et certains personnalisés) via une API HTTP **compatible OpenAI**. OpenClaw peut se connecter à vLLM en utilisant l'API `openai-completions`.

OpenClaw peut aussi **découvrir automatiquement** les modèles disponibles depuis vLLM quand vous optez avec `VLLM_API_KEY` (n'importe quelle valeur fonctionne si votre serveur n'impose pas d'auth) et que vous ne définissez pas d'entrée `models.providers.vllm` explicite.

## Démarrage rapide

1. Démarrez vLLM avec un serveur compatible OpenAI.

Votre URL de base devrait exposer les points de terminaison `/v1` (ex. `/v1/models`, `/v1/chat/completions`). vLLM s'exécute couramment sur :

- `http://127.0.0.1:8000/v1`

2. Optez (n'importe quelle valeur fonctionne si aucune auth n'est configurée) :

```bash
export VLLM_API_KEY="vllm-local"
```

3. Sélectionnez un modèle (remplacez par un de vos IDs de modèle vLLM) :

```json5
{
  agents: {
    defaults: {
      model: { primary: "vllm/votre-id-modele" },
    },
  },
}
```

## Découverte de modèle (fournisseur implicite)

Quand `VLLM_API_KEY` est défini (ou qu'un profil auth existe) et que vous **ne définissez pas** `models.providers.vllm`, OpenClaw interrogera :

- `GET http://127.0.0.1:8000/v1/models`

…et convertira les IDs retournés en entrées de modèle.

Si vous définissez `models.providers.vllm` explicitement, la découverte auto est ignorée et vous devez définir les modèles manuellement.

## Configuration explicite (modèles manuels)

Utilisez la config explicite quand :

- vLLM s'exécute sur un host/port différent.
- Vous voulez épingler les valeurs `contextWindow`/`maxTokens`.
- Votre serveur nécessite une vraie clé API (ou vous voulez contrôler les en-têtes).

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "votre-id-modele",
            name: "Modèle vLLM Local",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Dépannage

- Vérifiez que le serveur est accessible :

```bash
curl http://127.0.0.1:8000/v1/models
```

- Si les requêtes échouent avec des erreurs auth, définissez un vrai `VLLM_API_KEY` qui correspond à la configuration de votre serveur, ou configurez le fournisseur explicitement sous `models.providers.vllm`.
