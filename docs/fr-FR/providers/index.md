---
summary: "Fournisseurs de modèles (LLMs) supportés par OpenClaw"
read_when:
  - Vous voulez choisir un fournisseur de modèle
  - Vous avez besoin d'un aperçu rapide des backends LLM supportés
title: "Fournisseurs de Modèles"
---

# Fournisseurs de Modèles

OpenClaw peut utiliser de nombreux fournisseurs LLM. Choisissez un fournisseur, authentifiez-vous, puis définissez le modèle par défaut comme `fournisseur/modèle`.

Vous cherchez les docs de canal de discussion (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/etc.) ? Voir [Canaux](/fr-FR/channels).

## Point fort : Venice (Venice AI)

Venice est notre configuration Venice AI recommandée pour l'inférence axée confidentialité avec une option d'utiliser Opus pour les tâches difficiles.

- Par défaut : `venice/llama-3.3-70b`
- Meilleur global : `venice/claude-opus-45` (Opus reste le plus fort)

Voir [Venice AI](/fr-FR/providers/venice).

## Démarrage rapide

1. Authentifiez-vous auprès du fournisseur (généralement via `openclaw onboard`).
2. Définissez le modèle par défaut :

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Docs de fournisseurs

- [OpenAI (API + Codex)](/fr-FR/providers/openai)
- [Anthropic (API + Claude Code CLI)](/fr-FR/providers/anthropic)
- [Qwen (OAuth)](/fr-FR/providers/qwen)
- [OpenRouter](/fr-FR/providers/openrouter)
- [LiteLLM (passerelle unifiée)](/fr-FR/providers/litellm)
- [Vercel AI Gateway](/fr-FR/providers/vercel-ai-gateway)
- [Together AI](/fr-FR/providers/together)
- [Cloudflare AI Gateway](/fr-FR/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/fr-FR/providers/moonshot)
- [OpenCode Zen](/fr-FR/providers/opencode)
- [Amazon Bedrock](/fr-FR/providers/bedrock)
- [Z.AI](/fr-FR/providers/zai)
- [Xiaomi](/fr-FR/providers/xiaomi)
- [Modèles GLM](/fr-FR/providers/glm)
- [MiniMax](/fr-FR/providers/minimax)
- [Venice (Venice AI, axé confidentialité)](/fr-FR/providers/venice)
- [Hugging Face (Inférence)](/fr-FR/providers/huggingface)
- [Ollama (modèles locaux)](/fr-FR/providers/ollama)
- [vLLM (modèles locaux)](/fr-FR/providers/vllm)
- [Qianfan](/fr-FR/providers/qianfan)
- [NVIDIA](/fr-FR/providers/nvidia)

## Fournisseurs de transcription

- [Deepgram (transcription audio)](/fr-FR/providers/deepgram)

## Outils communautaires

- [Claude Max API Proxy](/fr-FR/providers/claude-max-api-proxy) - Utilisez l'abonnement Claude Max/Pro comme point de terminaison API compatible OpenAI

Pour le catalogue complet de fournisseurs (xAI, Groq, Mistral, etc.) et la configuration avancée, voir [Fournisseurs de modèles](/fr-FR/concepts/model-providers).
