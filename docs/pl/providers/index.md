---
summary: "Dostawcy modeli (LLM) obsługiwani przez OpenClaw"
read_when:
  - Chcesz wybrać dostawcę modelu
  - Potrzebujesz szybkiego przeglądu obsługiwanych backendów LLM
title: "Dostawcy modeli"
---

# Dostawcy modeli

OpenClaw może korzystać z wielu dostawców LLM. Wybierz dostawcę, uwierzytelnij się, a następnie ustaw
model domyślny jako `provider/model`.

Szukasz dokumentacji kanałów czatu (WhatsApp/Telegram/Discord/Slack/Mattermost (wtyczka)/itp.)? Zobacz [Kanały](/channels).

## Wyróżnienie: Venice (Venice AI)

Venice to nasza rekomendowana konfiguracja Venice AI, ukierunkowana na prywatność wnioskowania, z opcją użycia Opus do trudnych zadań.

- Domyślny: `venice/llama-3.3-70b`
- Najlepszy ogólnie: `venice/claude-opus-45` (Opus pozostaje najsilniejszy)

Zobacz [Venice AI](/providers/venice).

## Szybki start

1. Uwierzytelnij się u dostawcy (zwykle przez `openclaw onboard`).
2. Ustaw model domyślny:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Dokumentacja dostawców

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [Modele GLM](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, zorientowane na prywatność)](/providers/venice)
- [Ollama (modele lokalne)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Dostawcy transkrypcji

- [Deepgram (transkrypcja audio)](/providers/deepgram)

## Narzędzia społecznościowe

- [Claude Max API Proxy](/providers/claude-max-api-proxy) – Używaj subskrypcji Claude Max/Pro jako punktu końcowego API zgodnego z OpenAI

Pełny katalog dostawców (xAI, Groq, Mistral itd.) oraz zaawansowaną konfigurację
znajdziesz w sekcji [Dostawcy modeli](/concepts/model-providers).
