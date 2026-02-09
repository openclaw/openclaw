---
summary: "Executer OpenClaw avec des LLM locaux (LM Studio, vLLM, LiteLLM, points de terminaison OpenAI personnalises)"
read_when:
  - Vous souhaitez servir des modeles depuis votre propre machine GPU
  - Vous connectez LM Studio ou un proxy compatible OpenAI
  - Vous avez besoin des recommandations les plus sures pour les modeles locaux
title: "Modeles locaux"
---

# Modeles locaux

Le local est possible, mais OpenClaw attend un **grand contexte** et de **solides defenses contre l’injection de prompt**. Les petites cartes tronquent le contexte et laissent fuiter la securite. Visez haut : **≥2 Mac Studio au maximum ou une configuration GPU equivalente (~30 k$+)**. Un seul GPU de **24 Go** ne fonctionne que pour des invites plus legeres avec une latence plus elevee. Utilisez la **plus grande / version complete du modele que vous pouvez executer** ; les checkpoints fortement quantifies ou « petits » augmentent le risque d’injection de prompt (voir [Security](/gateway/security)).

## Recommande : LM Studio + MiniMax M2.1 (Responses API, version complete)

Meilleure pile locale actuelle. Chargez MiniMax M2.1 dans LM Studio, activez le serveur local (par defaut `http://127.0.0.1:1234`), et utilisez la Responses API pour garder le raisonnement separe du texte final.

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

**Liste de verification d’installation**

- Installez LM Studio : https://lmstudio.ai
- Dans LM Studio, telechargez la **plus grande version MiniMax M2.1 disponible** (evitez les variantes « small » / fortement quantifiees), demarrez le serveur et confirmez que `http://127.0.0.1:1234/v1/models` la liste.
- Gardez le modele charge ; le chargement a froid ajoute une latence de demarrage.
- Ajustez `contextWindow`/`maxTokens` si votre version de LM Studio differe.
- Pour WhatsApp, restez sur la Responses API afin que seul le texte final soit envoye.

Conservez les modeles heberges configures meme lorsque vous executez en local ; utilisez `models.mode: "merge"` pour que les solutions de repli restent disponibles.

### Configuration hybride : heberge en principal, local en repli

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

### Priorite au local avec filet de securite heberge

Inversez l’ordre principal / repli ; conservez le meme bloc de fournisseurs et `models.mode: "merge"` afin de pouvoir revenir a Sonnet ou Opus lorsque la machine locale est indisponible.

### Hebergement regional / routage des donnees

- Des variantes hebergees MiniMax/Kimi/GLM existent aussi sur OpenRouter avec des points de terminaison ancrés par region (p. ex. heberges aux Etats-Unis). Choisissez la variante regionale pour garder le trafic dans la juridiction souhaitee tout en utilisant `models.mode: "merge"` pour les solutions de repli Anthropic/OpenAI.
- Le local uniquement reste la voie la plus protectrice pour la confidentialite ; le routage regional heberge est un compromis lorsque vous avez besoin de fonctionnalites de fournisseur tout en gardant le controle des flux de donnees.

## Autres proxys locaux compatibles OpenAI

vLLM, LiteLLM, OAI-proxy ou des passerelles personnalisees fonctionnent s’ils exposent un point de terminaison `/v1` de type OpenAI. Remplacez le bloc de fournisseur ci-dessus par votre point de terminaison et l’ID du modele :

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

Conservez `models.mode: "merge"` afin que les modeles heberges restent disponibles comme solutions de repli.

## Problemes courants

- La Gateway (passerelle) peut atteindre le proxy ? `curl http://127.0.0.1:1234/v1/models`.
- Modele LM Studio decharge ? Rechargez-le ; le demarrage a froid est une cause frequente de « blocage ».
- Erreurs de contexte ? Diminuez `contextWindow` ou augmentez la limite de votre serveur.
- Securite : les modeles locaux contournent les filtres cote fournisseur ; gardez des agents restreints et la compaction activee pour limiter le rayon d’explosion des injections de prompt.
