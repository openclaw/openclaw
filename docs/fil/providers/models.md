---
summary: "Mga provider ng model (LLMs) na sinusuportahan ng OpenClaw"
read_when:
  - Gusto mong pumili ng provider ng model
  - Gusto mo ng mga halimbawa ng mabilis na setup para sa LLM auth + pagpili ng model
title: "Mabilis na Pagsisimula ng Model Provider"
---

# Mga Provider ng Model

OpenClaw can use many LLM providers. Pick one, authenticate, then set the default
model as `provider/model`.

## Highlight: Venice (Venice AI)

Ang Venice ang aming inirerekomendang setup ng Venice AI para sa privacy-first inference na may opsyong gumamit ng Opus para sa pinakamahihirap na gawain.

- Default: `venice/llama-3.3-70b`
- Pinakamahusay sa kabuuan: `venice/claude-opus-45` (Nanatiling pinakamalakas ang Opus)

Tingnan ang [Venice AI](/providers/venice).

## Mabilis na pagsisimula (dalawang hakbang)

1. Mag-authenticate sa provider (karaniwan sa pamamagitan ng `openclaw onboard`).
2. Itakda ang default na model:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Mga sinusuportahang provider (starter set)

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

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
