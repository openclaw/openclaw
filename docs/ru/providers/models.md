---
summary: "Провайдеры моделей (LLM), поддерживаемые OpenClaw"
read_when:
  - Вы хотите выбрать провайдера модели
  - Вам нужны быстрые примеры настройки аутентификации LLM и выбора модели
title: "Быстрый старт по провайдерам моделей"
---

# Провайдеры моделей

OpenClaw может использовать множество провайдеров LLM. Выберите один, выполните аутентификацию, затем задайте модель по умолчанию как `provider/model`.

## Выделение: Venice (Venice AI)

Venice — наша рекомендуемая конфигурация Venice AI для приватной инференции с возможностью использовать Opus для самых сложных задач.

- По умолчанию: `venice/llama-3.3-70b`
- Лучший в целом: `venice/claude-opus-45` (Opus остаётся самым сильным)

См. [Venice AI](/providers/venice).

## Быстрый старт (два шага)

1. Выполните аутентификацию у провайдера (обычно через `openclaw onboard`).
2. Задайте модель по умолчанию:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Поддерживаемые провайдеры (стартовый набор)

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

Полный каталог провайдеров (xAI, Groq, Mistral и т. д.) и расширенную конфигурацию см. в разделе [Model providers](/concepts/model-providers).
