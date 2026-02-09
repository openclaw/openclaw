---
summary: "Gamitin ang MiniMax M2.1 sa OpenClaw"
read_when:
  - Gusto mo ng mga MiniMax model sa OpenClaw
  - Kailangan mo ng gabay sa setup ng MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax is an AI company that builds the **M2/M2.1** model family. The current
coding-focused release is **MiniMax M2.1** (December 23, 2025), built for
real-world complex tasks.

Source: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Pangkalahatang-ideya ng model (M2.1)

Itinatampok ng MiniMax ang mga sumusunod na pagpapahusay sa M2.1:

- Mas malakas na **multi-language coding** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Mas mahusay na **web/app development** at kalidad ng aesthetic na output (kabilang ang native mobile).
- Pinahusay na paghawak ng **composite instruction** para sa mga office-style workflow, na binubuo sa
  interleaved thinking at integrated constraint execution.
- **Mas maiikling sagot** na may mas mababang paggamit ng token at mas mabilis na iteration loop.
- Mas malakas na **tool/agent framework** compatibility at context management (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Mas mataas na kalidad ng **dialogue at technical writing** na mga output.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Bilis:** Ang Lightning ang “fast” variant sa pricing docs ng MiniMax.
- **Gastos:** Ipinapakita ng pricing ang parehong input cost, ngunit mas mataas ang output cost ng Lightning.
- **Coding plan routing:** The Lightning back-end isn’t directly available on the MiniMax
  coding plan. MiniMax auto-routes most requests to Lightning, but falls back to the
  regular M2.1 back-end during traffic spikes.

## Pumili ng setup

### MiniMax OAuth (Coding Plan) — inirerekomenda

**Pinakamainam para sa:** mabilis na setup gamit ang MiniMax Coding Plan sa pamamagitan ng OAuth, walang kinakailangang API key.

I-enable ang bundled OAuth plugin at mag-authenticate:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Hihilingin sa iyo na pumili ng endpoint:

- **Global** - Mga international user (`api.minimax.io`)
- **CN** - Mga user sa China (`api.minimaxi.com`)

Tingnan ang [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) para sa mga detalye.

### MiniMax M2.1 (API key)

**Pinakamainam para sa:** hosted MiniMax na may Anthropic-compatible API.

I-configure sa pamamagitan ng CLI:

- Patakbuhin ang `openclaw configure`
- Piliin ang **Model/auth**
- Piliin ang **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 bilang fallback (Opus primary)

**Pinakamainam para sa:** panatilihing primary ang Opus 4.6, at mag-fail over sa MiniMax M2.1.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Opsyonal: Lokal sa pamamagitan ng LM Studio (manual)

**Best for:** local inference with LM Studio.
We have seen strong results with MiniMax M2.1 on powerful hardware (e.g. a
desktop/server) using LM Studio's local server.

I-configure nang manu-mano sa pamamagitan ng `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
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

## I-configure sa pamamagitan ng `openclaw configure`

Gamitin ang interactive config wizard para i-set up ang MiniMax nang hindi nag-e-edit ng JSON:

1. Patakbuhin ang `openclaw configure`.
2. Piliin ang **Model/auth**.
3. Piliin ang **MiniMax M2.1**.
4. Piliin ang iyong default na model kapag hiniling.

## Mga opsyon sa configuration

- `models.providers.minimax.baseUrl`: mas mainam ang `https://api.minimax.io/anthropic` (Anthropic-compatible); opsyonal ang `https://api.minimax.io/v1` para sa OpenAI-compatible payloads.
- `models.providers.minimax.api`: mas mainam ang `anthropic-messages`; opsyonal ang `openai-completions` para sa OpenAI-compatible payloads.
- `models.providers.minimax.apiKey`: MiniMax API key (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: tukuyin ang `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: mag-alias ng mga model na gusto mo sa allowlist.
- `models.mode`: panatilihin ang `merge` kung gusto mong idagdag ang MiniMax kasabay ng mga built-in.

## Mga tala

- Ang mga model ref ay `minimax/<model>`.
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (nangangailangan ng coding plan key).
- I-update ang mga pricing value sa `models.json` kung kailangan mo ng eksaktong cost tracking.
- Referral link para sa MiniMax Coding Plan (10% off): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Tingnan ang [/concepts/model-providers](/concepts/model-providers) para sa mga patakaran ng provider.
- Gamitin ang `openclaw models list` at `openclaw models set minimax/MiniMax-M2.1` para magpalit.

## Pag-troubleshoot

### “Unknown model: minimax/MiniMax-M2.1”

This usually means the **MiniMax provider isn’t configured** (no provider entry
and no MiniMax auth profile/env key found). A fix for this detection is in
**2026.1.12** (unreleased at the time of writing). Fix by:

- Pag-upgrade sa **2026.1.12** (o patakbuhin mula sa source `main`), pagkatapos ay i-restart ang Gateway.
- Pagpapatakbo ng `openclaw configure` at pagpili ng **MiniMax M2.1**, o
- Manu-manong pagdaragdag ng `models.providers.minimax` block, o
- Pagse-set ng `MINIMAX_API_KEY` (o isang MiniMax auth profile) para ma-inject ang provider.

Tiyaking ang model id ay **case‑sensitive**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Pagkatapos, i-recheck gamit ang:

```bash
openclaw models list
```
