---
summary: "Exécuter OpenClaw sur des LLMs locaux (LM Studio, vLLM, LiteLLM, points de terminaison OpenAI personnalisés)"
read_when:
  - Vous voulez servir des modèles depuis votre propre box GPU
  - Vous câblez LM Studio ou un proxy compatible OpenAI
  - Vous avez besoin du guide de modèle local le plus sûr
title: "Modèles locaux"
---

# Modèles locaux

Le local est faisable, mais OpenClaw attend un contexte large + de fortes défenses contre l'injection de prompt. Les petites cartes tronquent le contexte et laissent fuir la sécurité. Visez haut : **≥2 Mac Studios maxés ou équivalent rig GPU (~30k$+)**. Un seul GPU **24 GB** ne fonctionne que pour des prompts plus légers avec une latence plus élevée. Utilisez la **variante de modèle la plus grande / pleine taille que vous pouvez exécuter** ; les checkpoints agressivement quantifiés ou "petits" augmentent le risque d'injection de prompt (voir [Sécurité](/fr-FR/gateway/security)).

## Recommandé : LM Studio + MiniMax M2.1 (API Responses, pleine taille)

Meilleure pile locale actuelle. Chargez MiniMax M2.1 dans LM Studio, activez le serveur local (défaut `http://127.0.0.1:1234`), et utilisez l'API Responses pour garder le raisonnement séparé du texte final.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**Liste de vérification de configuration**

- Installez LM Studio : [https://lmstudio.ai](https://lmstudio.ai)
- Dans LM Studio, téléchargez le **plus grand build MiniMax M2.1 disponible** (évitez les variantes "small"/fortement quantifiées), démarrez le serveur, confirmez que `http://127.0.0.1:1234/v1/models` le liste.
- Gardez le modèle chargé ; le chargement à froid ajoute de la latence de démarrage.
- Ajustez `contextWindow`/`maxTokens` si votre build LM Studio diffère.
- Pour WhatsApp, restez sur l'API Responses pour que seul le texte final soit envoyé.

Gardez les modèles hébergés configurés même lors de l'exécution locale ; utilisez `models.mode: "merge"` pour que les fallbacks restent disponibles.

### Config hybride : primaire hébergé, fallback local

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Local d'abord avec filet de sécurité hébergé

Échangez l'ordre primaire et fallback ; gardez le même bloc providers et `models.mode: "merge"` pour pouvoir revenir à Sonnet ou Opus lorsque la box locale est en panne.

### Hébergement régional / routage de données

- Les variantes MiniMax/Kimi/GLM hébergées existent aussi sur OpenRouter avec des points de terminaison épinglés par région (par ex., hébergé US). Choisissez la variante régionale là-bas pour garder le trafic dans votre juridiction choisie tout en utilisant `models.mode: "merge"` pour les fallbacks Anthropic/OpenAI.
- Le local-uniquement reste le chemin de confidentialité le plus fort ; le routage régional hébergé est le compromis lorsque vous avez besoin de fonctionnalités fournisseur mais voulez contrôler le flux de données.

## Autres proxies locaux compatibles OpenAI

vLLM, LiteLLM, OAI-proxy ou passerelles personnalisées fonctionnent s'ils exposent un point de terminaison style OpenAI `/v1`. Remplacez le bloc provider ci-dessus avec votre point de terminaison et ID modèle :

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Gardez `models.mode: "merge"` pour que les modèles hébergés restent disponibles comme fallbacks.

## Dépannage

- La Passerelle peut atteindre le proxy ? `curl http://127.0.0.1:1234/v1/models`.
- Modèle LM Studio déchargé ? Rechargez ; le démarrage à froid est une cause courante de "suspension".
- Erreurs de contexte ? Baissez `contextWindow` ou augmentez votre limite serveur.
- Sécurité : les modèles locaux sautent les filtres côté fournisseur ; gardez les agents étroits et la compaction activée pour limiter le rayon d'explosion d'injection de prompt.
