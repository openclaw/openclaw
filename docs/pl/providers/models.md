---
summary: "Dostawcy modeli (LLM) obsługiwani przez OpenClaw"
read_when:
  - Chcesz wybrać dostawcę modelu
  - Chcesz szybkie przykłady konfiguracji uwierzytelniania LLM + wyboru modelu
title: "Szybki start dostawców modeli"
---

# Dostawcy modeli

OpenClaw może korzystać z wielu dostawców LLM. Wybierz jednego, uwierzytelnij się, a następnie ustaw domyślny
model jako `provider/model`.

## Wyróżnienie: Venice (Venice AI)

Venice to nasza rekomendowana konfiguracja Venice AI, zapewniająca wnioskowanie z naciskiem na prywatność, z opcją użycia Opus do najtrudniejszych zadań.

- Domyślny: `venice/llama-3.3-70b`
- Najlepszy ogólnie: `venice/claude-opus-45` (Opus pozostaje najsilniejszy)

Zobacz [Venice AI](/providers/venice).

## Szybki start (dwa kroki)

1. Uwierzytelnij się u dostawcy (zwykle przez `openclaw onboard`).
2. Ustaw domyślny model:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Obsługiwani dostawcy (zestaw startowy)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

Pełny katalog dostawców (xAI, Groq, Mistral itd.) oraz zaawansowaną konfigurację znajdziesz w
[Model providers](/concepts/model-providers).
