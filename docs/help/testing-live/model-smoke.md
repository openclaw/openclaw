---
summary: "The two-layer live model smoke: direct completion and the gateway + dev agent pipeline"
title: "Live model smoke (profile keys)"
read_when:
  - You are smoking a provider or model with your own profile keys
  - You need to tell a broken provider key apart from a broken gateway pipeline
---

## Live: model smoke (profile keys)

Live model tests are split into two layers so failures are isolated:

- "Direct model" tells you whether the provider/model can answer at all with the given key.
- "Gateway smoke" tells you whether the full gateway+agent pipeline works for that model (sessions, history, tools, sandbox policy, etc.).

The curated model lists on
[Live: model matrix](/help/testing-live/long-context-and-matrix#live-model-matrix-what-we-cover)
live in `src/agents/test-helpers/live-model-dynamic-candidates.ts` and
change over time; treat the arrays there as the source of truth, not this
page.

MiniMax M3 uses `minimax/MiniMax-M3` as its default provider/model reference.

### Layer 1: Direct model completion (no gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Goal:
  - Enumerate discovered models
  - Use `getApiKeyForModel` to select models you have creds for
  - Run a small completion per model (and targeted regressions where needed)
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
  - Set `OPENCLAW_LIVE_MODELS=modern`, `small`, or `all` (alias for `modern`) to actually run this suite; otherwise it skips, so `pnpm test:live` on its own stays focused on gateway smoke.
- How to select models:
  - `OPENCLAW_LIVE_MODELS=modern` runs the curated high-signal priority list (see [Live: model matrix](/help/testing-live/long-context-and-matrix#live-model-matrix-what-we-cover))
  - `OPENCLAW_LIVE_MODELS=small` runs the curated small-model priority list
  - `OPENCLAW_LIVE_MODELS=all` is an alias for `modern`
  - or `OPENCLAW_LIVE_MODELS="openai/gpt-5.6-luna,anthropic/claude-opus-4-6,..."` (comma allowlist)
  - Local Ollama small-model runs default to `http://127.0.0.1:11434`; set `OPENCLAW_LIVE_OLLAMA_BASE_URL` only for LAN, custom, or Ollama Cloud endpoints.
  - Modern/all and small sweeps default to their curated-list length as a cap; set `OPENCLAW_LIVE_MAX_MODELS=0` for an exhaustive selected-profile sweep or a positive number for a smaller cap.
  - Exhaustive sweeps use `OPENCLAW_LIVE_TEST_TIMEOUT_MS` for the whole direct-model test timeout. Default: 60 minutes.
  - Direct-model probes run with 20-way parallelism by default; set `OPENCLAW_LIVE_MODEL_CONCURRENCY` to override.
- How to select providers:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-gemini-cli"` (comma allowlist)
- Where keys come from:
  - By default: profile store and env fallbacks
  - Set `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only
- Why this exists:
  - Separates "provider API is broken / key is invalid" from "gateway agent pipeline is broken"
  - Contains small, isolated regressions (example: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Goal:
  - Spin up an in-process gateway
  - Create/patch an `agent:dev:*` session (model override per run)
  - Iterate models-with-keys and assert:
    - "meaningful" response (no tools)
    - a real tool invocation works (read probe)
    - optional extra tool probes (exec+read probe)
    - OpenAI regression paths (tool-call-only -> follow-up) keep working
- Probe details (so you can explain failures quickly):
  - `read` probe: the test writes a nonce file in the workspace and asks the agent to `read` it and echo the nonce back.
  - `exec+read` probe: the test asks the agent to `exec`-write a nonce into a temp file, then `read` it back.
  - image probe: the test attaches a generated PNG (cat + randomized code) and expects the model to return `cat <CODE>`.
  - Implementation reference: `src/gateway/gateway-models.profiles.live.test.ts` and `test/helpers/live-image-probe.ts`.
- How to enable:
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)
- How to select models:
  - Default: the curated high-signal (`modern`) priority list
  - `OPENCLAW_LIVE_GATEWAY_MODELS=small` runs the curated small-model list through the full gateway+agent pipeline
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` is an alias for `modern`
  - Or set `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (or comma list) to narrow
  - Modern/all and small gateway sweeps default to their curated-list length as a cap; set `OPENCLAW_LIVE_GATEWAY_MAX_MODELS=0` for an exhaustive selected sweep or a positive number for a smaller cap.
- How to select providers (avoid "OpenRouter everything"):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Tool + image probes are always on in this live test:
  - `read` probe + `exec+read` probe (tool stress)
  - image probe runs when the model advertises image input support
  - Flow (high level):
    - Test generates a tiny PNG with "CAT" + random code (`test/helpers/live-image-probe.ts`)
    - Sends it via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parses attachments into `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Embedded agent forwards a multimodal user message to the model
    - Assertion: reply contains `cat` + the code (OCR tolerance: minor mistakes allowed)

<Tip>
To see what you can test on your machine (and the exact `provider/model` ids), run:

```bash
openclaw models list
openclaw models list --json
```

</Tip>
