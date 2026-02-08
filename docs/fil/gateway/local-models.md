---
summary: "Patakbuhin ang OpenClaw sa mga lokal na LLM (LM Studio, vLLM, LiteLLM, custom OpenAI endpoints)"
read_when:
  - Gusto mong mag-serve ng mga model mula sa sarili mong GPU box
  - Ikino-konekta mo ang LM Studio o isang OpenAI-compatible proxy
  - Kailangan mo ng pinakaligtas na gabay para sa lokal na model
title: "Mga Lokal na Model"
x-i18n:
  source_path: gateway/local-models.md
  source_hash: 82164e8c4f0c7479
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:36Z
---

# Mga lokal na model

Posible ang local, pero inaasahan ng OpenClaw ang **malaking context + matitibay na depensa laban sa prompt injection**. Ang maliliit na card ay nagta-truncate ng context at naglalabas ng safety. Mag-aim mataas: **≥2 na fully maxed-out na Mac Studio o katumbas na GPU rig (~$30k+)**. Ang iisang **24 GB** GPU ay gumagana lang para sa mas magagaan na prompt na may mas mataas na latency. Gamitin ang **pinakamalaki / full-size na variant ng model na kaya mong patakbuhin**; ang sobrang quantized o “small” na checkpoints ay nagpapataas ng panganib ng prompt injection (tingnan ang [Security](/gateway/security)).

## Inirerekomenda: LM Studio + MiniMax M2.1 (Responses API, full-size)

Pinakamahusay na kasalukuyang local stack. I-load ang MiniMax M2.1 sa LM Studio, i-enable ang local server (default `http://127.0.0.1:1234`), at gamitin ang Responses API para hiwalay ang reasoning sa final na teksto.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**Checklist ng setup**

- I-install ang LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- Sa LM Studio, i-download ang **pinakamalaking MiniMax M2.1 build na available** (iwasan ang “small”/mabigat na quantized na variants), simulan ang server, at kumpirmahin na `http://127.0.0.1:1234/v1/models` ay nakalista ito.
- Panatilihing naka-load ang model; ang cold-load ay nagdadagdag ng startup latency.
- Ayusin ang `contextWindow`/`maxTokens` kung iba ang LM Studio build mo.
- Para sa WhatsApp, manatili sa Responses API para final na teksto lang ang ipinapadala.

Panatilihing naka-configure ang hosted models kahit tumatakbo ang local; gamitin ang `models.mode: "merge"` para manatiling available ang mga fallback.

### Hybrid config: hosted primary, local fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Local-first na may hosted safety net

Ipalit ang pagkakasunod ng primary at fallback; panatilihin ang parehong providers block at `models.mode: "merge"` para makapag-fallback ka sa Sonnet o Opus kapag down ang local box.

### Regional hosting / data routing

- Mayroon ding hosted MiniMax/Kimi/GLM variants sa OpenRouter na may region-pinned endpoints (hal., US-hosted). Piliin ang regional variant doon para manatili ang traffic sa napili mong hurisdiksyon habang ginagamit pa rin ang `models.mode: "merge"` para sa Anthropic/OpenAI fallbacks.
- Ang local-only ang pinakamalakas na landas sa privacy; ang hosted regional routing ay gitnang opsyon kapag kailangan mo ng provider features pero gusto mo ng kontrol sa daloy ng data.

## Iba pang OpenAI-compatible na local proxy

Gumagana ang vLLM, LiteLLM, OAI-proxy, o custom gateways kung nag-e-expose sila ng OpenAI-style na `/v1` endpoint. Palitan ang provider block sa itaas ng iyong endpoint at model ID:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Panatilihin ang `models.mode: "merge"` para manatiling available ang hosted models bilang mga fallback.

## Pag-troubleshoot

- Nakakaabot ba ang Gateway sa proxy? `curl http://127.0.0.1:1234/v1/models`.
- Na-unload ang LM Studio model? I-reload; ang cold start ay karaniwang sanhi ng “hanging”.
- Mga error sa context? Ibaba ang `contextWindow` o itaas ang limit ng server mo.
- Safety: nilalaktawan ng local models ang provider-side filters; panatilihing makitid ang agents at naka-on ang compaction para limitahan ang blast radius ng prompt injection.
