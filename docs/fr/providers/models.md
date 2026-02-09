---
summary: "Fournisseurs de modèles (LLM) pris en charge par OpenClaw"
read_when:
  - Vous souhaitez choisir un fournisseur de modèles
  - Vous souhaitez des exemples de configuration rapide pour l’authentification LLM et la sélection de modèles
title: "Démarrage rapide des fournisseurs de modèles"
---

# Fournisseurs de modèles

OpenClaw peut utiliser de nombreux fournisseurs de LLM. Choisissez-en un, authentifiez-vous, puis définissez le
modèle par défaut comme `provider/model`.

## Mise en avant : Venice (Venice AI)

Venice est notre configuration Venice AI recommandée pour une inférence axée sur la confidentialité, avec la possibilité d’utiliser Opus pour les tâches les plus difficiles.

- Par défaut : `venice/llama-3.3-70b`
- Meilleur choix global : `venice/claude-opus-45` (Opus reste le plus performant)

Voir [Venice AI](/providers/venice).

## Démarrage rapide (deux étapes)

1. Authentifiez-vous auprès du fournisseur (généralement via `openclaw onboard`).
2. Définissez le modèle par défaut :

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Fournisseurs pris en charge (ensemble de départ)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [Modèles GLM](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/bedrock)
- [Qianfan](/providers/qianfan)

Pour le catalogue complet des fournisseurs (xAI, Groq, Mistral, etc.) et la configuration avancée,
voir [Fournisseurs de modèles](/concepts/model-providers).
