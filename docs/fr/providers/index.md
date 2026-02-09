---
summary: "Fournisseurs de modèles (LLM) pris en charge par OpenClaw"
read_when:
  - Vous souhaitez choisir un fournisseur de modèles
  - Vous avez besoin d’un aperçu rapide des backends LLM pris en charge
title: "Fournisseurs de modèles"
---

# Fournisseurs de modèles

OpenClaw peut utiliser de nombreux fournisseurs de LLM. Choisissez un fournisseur, authentifiez-vous, puis définissez le
modèle par défaut sur `provider/model`.

Vous cherchez la documentation des canaux de discussion (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.) ? Voir [Canaux](/channels).

## Mise en avant : Venice (Venice AI)

Venice est notre configuration Venice AI recommandée pour une inférence axée sur la confidentialité, avec la possibilité d’utiliser Opus pour les tâches difficiles.

- Par défaut : `venice/llama-3.3-70b`
- Meilleur choix global : `venice/claude-opus-45` (Opus reste le plus performant)

Voir [Venice AI](/providers/venice).

## Demarrage rapide

1. Authentifiez-vous auprès du fournisseur (généralement via `openclaw onboard`).
2. Définissez le modèle par défaut :

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Documentation des fournisseurs

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [Modèles GLM](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, axé sur la confidentialité)](/providers/venice)
- [Ollama (modèles locaux)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Fournisseurs de transcription

- [Deepgram (transcription audio)](/providers/deepgram)

## Outils communautaires

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Utilisez un abonnement Claude Max/Pro comme point de terminaison d’API compatible OpenAI

Pour le catalogue complet des fournisseurs (xAI, Groq, Mistral, etc.) et la configuration avancée,
voir [Fournisseurs de modèles](/concepts/model-providers).
