---
summary: "Fournisseurs de modèles (LLMs) supportés par OpenClaw"
read_when:
  - Vous voulez choisir un fournisseur de modèle
  - Vous voulez des exemples de configuration rapide pour auth LLM + sélection de modèle
title: "Démarrage Rapide Fournisseur de Modèle"
---

# Fournisseurs de Modèles

OpenClaw peut utiliser de nombreux fournisseurs LLM. Choisissez-en un, authentifiez-vous, puis définissez le modèle par défaut comme `fournisseur/modèle`.

## Point fort : Venice (Venice AI)

Venice est notre configuration Venice AI recommandée pour l'inférence axée confidentialité avec une option d'utiliser Opus pour les tâches les plus difficiles.

- Par défaut : `venice/llama-3.3-70b`
- Meilleur global : `venice/claude-opus-45` (Opus reste le plus fort)

Voir [Venice AI](/fr-FR/providers/venice).

## Démarrage rapide (deux étapes)

1. Authentifiez-vous auprès du fournisseur (généralement via `openclaw onboard`).
2. Définissez le modèle par défaut :

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Fournisseurs supportés (ensemble de départ)

- [OpenAI (API + Codex)](/fr-FR/providers/openai)
- [Anthropic (API + Claude Code CLI)](/fr-FR/providers/anthropic)
- [OpenRouter](/fr-FR/providers/openrouter)
- [Vercel AI Gateway](/fr-FR/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/fr-FR/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/fr-FR/providers/moonshot)
- [Synthetic](/fr-FR/providers/synthetic)
- [OpenCode Zen](/fr-FR/providers/opencode)
- [Z.AI](/fr-FR/providers/zai)
- [Modèles GLM](/fr-FR/providers/glm)
- [MiniMax](/fr-FR/providers/minimax)
- [Venice (Venice AI)](/fr-FR/providers/venice)
- [Amazon Bedrock](/fr-FR/providers/bedrock)
- [Qianfan](/fr-FR/providers/qianfan)

Pour le catalogue complet de fournisseurs (xAI, Groq, Mistral, etc.) et la configuration avancée, voir [Fournisseurs de modèles](/fr-FR/concepts/model-providers).
