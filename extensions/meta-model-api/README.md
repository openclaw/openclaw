# Meta Model API provider

Bundled OpenClaw provider plugin for the **Meta Model API** — an OpenAI-compatible
**Responses API** endpoint (`POST /v1/responses`).

- **Base URL:** `https://api.ai.meta.com/v1`
- **Auth:** `Authorization: Bearer $MODEL_API_KEY`
- **Model:** `muse-spark-1.1` (reasoning model; use `muse-spark` for smoke tests until 1.1 ships)
  - Context window: 1,048,576 tokens (input + output share the budget)
  - Reasoning effort: `minimal | low | medium | high | xhigh` (default: `high`)
  - Vision: image input in `user` messages
  - Tool calling + streaming
  - Stateless encrypted reasoning replay (`store: false`)

## Usage

Set the API key and select the model:

```bash
export MODEL_API_KEY=<key>
```

```json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      model: { primary: "meta-model-api/muse-spark-1.1" },
    },
  },
}
```

Or run onboarding and choose **Meta Model API**.

## Thinking / reasoning

`--thinking <level>` and `/think <level>` map to Responses API `reasoning.effort`.
Default thinking level is `high`. `off` maps to `minimal` because Muse Spark does
not accept `none`.

## Docs

See `docs/providers/meta-model-api.md` for setup, onboarding, and smoke tests.

## Live test

```bash
export MODEL_API_KEY=<key>
export OPENCLAW_LIVE_TEST=1
export META_MODEL_API_LIVE_TEST=1
pnpm test extensions/meta-model-api/meta-model-api.live.test.ts
```

Live tests call `muse-spark` on `/v1/responses`.
