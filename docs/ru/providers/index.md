---
summary: "Провайдеры моделей (LLM), поддерживаемые OpenClaw"
read_when:
  - Вы хотите выбрать провайдера модели
  - Вам нужен краткий обзор поддерживаемых бэкендов LLM
title: "Провайдеры моделей"
---

# Провайдеры моделей

OpenClaw может использовать множество провайдеров LLM. Выберите провайдера, пройдите аутентификацию, затем установите
модель по умолчанию как `provider/model`.

Ищете документацию по чат-каналам (WhatsApp/Telegram/Discord/Slack/Mattermost (плагин)/и т. д.)? См. [Channels](/channels).

## Выделение: Venice (Venice AI)

Venice — это рекомендуемая нами настройка Venice AI для приватно-ориентированного инференса с возможностью использовать Opus для сложных задач.

- По умолчанию: `venice/llama-3.3-70b`
- Лучший в целом: `venice/claude-opus-45` (Opus остаётся самым сильным)

См. [Venice AI](/providers/venice).

## Быстрый старт

1. Пройдите аутентификацию у провайдера (обычно через `openclaw onboard`).
2. Установите модель по умолчанию:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Документация по провайдерам

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
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, ориентирован на приватность)](/providers/venice)
- [Ollama (локальные модели)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Провайдеры транскрибации

- [Deepgram (аудио-транскрибация)](/providers/deepgram)

## Инструменты сообщества

- [Claude Max API Proxy](/providers/claude-max-api-proxy) — используйте подписку Claude Max/Pro как совместимую с OpenAI конечную точку API

Полный каталог провайдеров (xAI, Groq, Mistral и т. д.) и расширенную конфигурацию
см. в разделе [Model providers](/concepts/model-providers).
