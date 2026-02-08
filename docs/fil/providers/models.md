---
summary: "Mga provider ng model (LLMs) na sinusuportahan ng OpenClaw"
read_when:
  - Gusto mong pumili ng provider ng model
  - Gusto mo ng mga halimbawa ng mabilis na setup para sa LLM auth + pagpili ng model
title: "Mabilis na Pagsisimula ng Model Provider"
x-i18n:
  source_path: providers/models.md
  source_hash: 691d2c97ef6b01cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:44Z
---

# Mga Provider ng Model

Maaaring gumamit ang OpenClaw ng maraming LLM provider. Pumili ng isa, mag-authenticate, at pagkatapos ay itakda ang default
model bilang `provider/model`.

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

Para sa kumpletong catalog ng provider (xAI, Groq, Mistral, atbp.) at advanced na konpigurasyon,
tingnan ang [Mga provider ng model](/concepts/model-providers).
