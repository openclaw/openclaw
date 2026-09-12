---
summary: "The OpenAI long-context proof runs, the recommended live recipes, and the curated model matrix"
title: "OpenAI long context and the live model matrix"
read_when:
  - You are crossing the OpenAI long-context pricing boundary on purpose
  - You want the curated modern/small model lists or a copy-ready live recipe
---

## Live: OpenAI long context

- Goal: validate exact-model embedded OpenClaw execution through a
  process-owned isolated Gateway, cross the long-context pricing boundary,
  observe a first-class OpenAI Responses compaction item, and prove opaque
  replay plus prefix pruning on the next request.
- Test: `src/gateway/gateway-openai-long-context.live.test.ts`
- Enable: `OPENCLAW_LIVE_OPENAI_LONG_CONTEXT=1`
- Profiles: `OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_PROFILE=full` selects exact
  `openai/gpt-5.6-sol` with a `1050000` total window, `922000` safe active
  input, `128000` maximum output, and `700000` compaction threshold. `reduced`
  reaches the same transport and persistence path with a smaller budget.
- Metrics: `OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_METRICS=1` emits phase timing and
  token observations. These measurements are informational, not pass/fail
  latency targets.
- Long output: `OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_OUTPUT=1` requires a
  deterministic response between 4000 and 8000 output tokens.
- Optional raw read-tool stress:
  `OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_TOOL_OUTPUT=1`. It is not part of the
  default recipe because the effective tool surface may use Code Mode instead
  of exposing the raw read tool.

Full `922000` input-budget recipe:

```bash
OPENCLAW_LIVE_OPENAI_LONG_CONTEXT=1 \
  OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_PROFILE=full \
  OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_METRICS=1 \
  OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_OUTPUT=1 \
  node --import tsx scripts/test-live.mts --quiet src/gateway/gateway-openai-long-context.live.test.ts
```

Reduced-budget recipe:

```bash
OPENCLAW_LIVE_OPENAI_LONG_CONTEXT=1 \
  OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_PROFILE=reduced \
  OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_METRICS=1 \
  OPENCLAW_LIVE_OPENAI_LONG_CONTEXT_OUTPUT=1 \
  node --import tsx scripts/test-live.mts --quiet src/gateway/gateway-openai-long-context.live.test.ts
```

### Long-context hard oracles

The full embedded and native recipes are proof runs, not throughput
benchmarks. They fail unless the following runtime contracts hold:

- Runtime and model identity are exact: embedded OpenClaw or native Codex as
  requested, both on `openai/gpt-5.6-sol`.
- At least one provider request crosses `272000` input tokens and every call
  reports priority service.
- Embedded OpenClaw receives and persists a first-class encrypted Responses
  `compaction` item, replays the exact opaque item on the next request, and
  prunes the earlier input prefix. The encrypted content must never appear in
  display or diagnostics.
- Native Codex reports an effective window of `875900`, grows beyond the
  `700000` total-scope threshold without a manual compact, and automatically
  compacts on the next turn.
- Each runtime produces a deterministic long response between 4000 and 8000
  output tokens and preserves a durable marker through compaction and a
  Gateway restart.

Compaction duration, restart latency, turn latency, and total suite duration
are emitted as informational metrics only.

<Warning>
The full modes deliberately cross OpenAI's long-context pricing boundary and
make several large API calls. Above `272000` input tokens, the whole request is
2× input/cache and 1.5× output; Fast/Priority doubles that tier again. Use full
mode only with explicit spend approval.
</Warning>

Fresh OpenAI API-key default:

```bash
OPENCLAW_LIVE_GATEWAY_OPENAI_API_DEFAULT=1 \
  OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai \
  OPENCLAW_LIVE_GATEWAY_THINKING=off \
  pnpm test:live -- src/gateway/gateway-models.profiles.live.test.ts
```

This proof leaves `OPENCLAW_LIVE_GATEWAY_MODELS` unset, resolves the model through
the fresh onboarding inference-selection seam, asserts `openai/gpt-5.6-sol`, and then
runs a real gateway turn with that resolved model.

GPT-5.6 embedded OpenClaw matrix:

```bash
OPENCLAW_LIVE_GATEWAY_THINKING=ultra \
  OPENCLAW_LIVE_GATEWAY_PROVIDERS=openai \
  OPENCLAW_LIVE_GATEWAY_MODELS='openai/gpt-5.6-sol,openai/gpt-5.6-terra,openai/gpt-5.6-luna' \
  pnpm test:live -- src/gateway/gateway-models.profiles.live.test.ts
```

Docker notes:

- The Docker runner lives at `scripts/test-live-codex-harness-docker.sh`.
- It passes `OPENAI_API_KEY`, copies Codex CLI auth files when present, installs
  `@openai/codex` into a writable mounted npm
  prefix, stages the source tree, then runs only the Codex-harness live test.
- Docker enables the image, MCP/tool, and Guardian probes by default. Set
  `OPENCLAW_LIVE_CODEX_HARNESS_IMAGE_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_MCP_PROBE=0` or
  `OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=0` when you need a narrower debug
  run.
- Docker uses the same explicit Codex runtime config, so legacy aliases or OpenClaw
  fallback cannot hide a Codex harness regression.
- Matrix targets run sequentially in one container. The Docker script scales its
  default 35-minute timeout by target count; any outer shell or CI timeout must
  allow the same total. Canonical CI keeps each GPT-5.6 target in a separate shard.

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.6-luna" pnpm test:live src/agents/models.profiles.live.test.ts`

- Small-model direct profile:
  - `OPENCLAW_LIVE_MODELS=small pnpm test:live src/agents/models.profiles.live.test.ts`

- Small-model gateway profile:
  - `OPENCLAW_LIVE_GATEWAY_MODELS=small pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Ollama Cloud API smoke:
  - `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_OLLAMA=1 OPENCLAW_LIVE_OLLAMA_BASE_URL=https://ollama.com OPENCLAW_LIVE_OLLAMA_MODEL=glm-5.1:cloud OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=0 pnpm test:live -- extensions/ollama/ollama.live.test.ts`

- Single model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.6-luna" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling across several providers:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.6-luna,anthropic/claude-opus-4-6,google/gemini-3.5-flash,deepseek/deepseek-v4-flash,zai/glm-5.1,minimax/MiniMax-M3" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Z.AI Coding Plan GLM-5.3 direct smoke:
  - `ZAI_CODING_LIVE_TEST=1 pnpm test:live src/agents/zai.live.test.ts`

- Google focus:
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3.5-flash" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google adaptive thinking smoke (`qa manual` from the private QA CLI - requires `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1` and a source checkout; see [QA overview](/concepts/qa-e2e-automation)):
  - Gemini 3 dynamic default: `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 pnpm openclaw qa manual --provider-mode live-frontier --model google/gemini-3.1-pro-preview --alt-model google/gemini-3.1-pro-preview --message '/think adaptive Reply exactly: GEMINI_ADAPTIVE_OK' --timeout-ms 180000`
  - Gemini 2.5 dynamic budget: `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 pnpm openclaw qa manual --provider-mode live-frontier --model google/gemini-2.5-flash --alt-model google/gemini-2.5-flash --message '/think adaptive Reply exactly: GEMINI25_ADAPTIVE_OK' --timeout-ms 180000`

Notes:

- `google/...` uses the Gemini API (API key).
- `google-gemini-cli/...` uses the local Gemini CLI on your machine (separate auth + tooling quirks).
- `google-antigravity/...` is not a registered provider or supported setup path. Do not add it to live-test allowlists.
- Gemini API vs Gemini CLI:
  - API: OpenClaw calls Google's hosted Gemini API over HTTP (API key / profile auth); this is what most users mean by "Gemini".
  - CLI: OpenClaw shells out to a local `gemini` binary; it has its own auth and can behave differently (streaming/tool support/version skew).

## Live: model matrix (what we cover)

Live is opt-in, so there is no fixed "CI model list." `OPENCLAW_LIVE_MODELS=modern` / `OPENCLAW_LIVE_GATEWAY_MODELS=modern` (and their `all` alias) run the curated priority list from `HIGH_SIGNAL_LIVE_MODEL_PRIORITY` in `src/agents/test-helpers/live-model-dynamic-candidates.ts`, in this priority order:

| Provider/model                                      | Notes      |
| --------------------------------------------------- | ---------- |
| `anthropic/claude-opus-5`                           |            |
| `anthropic/claude-opus-4-8`                         |            |
| `anthropic/claude-sonnet-5`                         |            |
| `anthropic/claude-sonnet-4-6`                       |            |
| `anthropic/claude-opus-4-7`                         |            |
| `google/gemini-3.1-pro-preview`                     | Gemini API |
| `google/gemini-3.5-flash`                           | Gemini API |
| `cohere/command-a-plus-05-2026`                     |            |
| `moonshot/kimi-k3`                                  |            |
| `anthropic/claude-opus-4-6`                         |            |
| `deepseek/deepseek-v4-flash`                        |            |
| `deepseek/deepseek-v4-pro`                          |            |
| `minimax/MiniMax-M3`                                |            |
| `openai/gpt-5.6`                                    |            |
| `openrouter/openai/gpt-5.2-chat`                    |            |
| `openrouter/minimax/minimax-m2.7`                   |            |
| `opencode-go/glm-5`                                 |            |
| `openrouter/ai21/jamba-large-1.7`                   |            |
| `xai/grok-4.6`                                      |            |
| `xai/grok-4.5`                                      |            |
| `xai/grok-4.20-0309-reasoning`                      |            |
| `zai/glm-5.1`                                       |            |
| `fireworks/accounts/fireworks/routers/glm-5p2-fast` |            |
| `minimax-portal/minimax-m3`                         |            |

The curated **small-model** list (`OPENCLAW_LIVE_MODELS=small` / `OPENCLAW_LIVE_GATEWAY_MODELS=small`), from `SMALL_LIVE_MODEL_PRIORITY`:

| Provider/model               |
| ---------------------------- |
| `lmstudio/qwen/qwen3.5-9b`   |
| `vllm/qwen/qwen3-8b`         |
| `sglang/qwen/qwen3-8b`       |
| `ollama/gemma3:4b`           |
| `openrouter/qwen/qwen3.5-9b` |
| `openrouter/z-ai/glm-5.1`    |
| `openrouter/z-ai/glm-5`      |
| `zai/glm-5.1`                |

Notes on the modern list:

- `codex` and `codex-cli` providers are excluded from the default modern sweep (they cover CLI-backend/ACP behavior, tested separately on [CLI backend and APNs lanes](/help/testing-live/cli-backends) and [ACP bind and Codex app-server lanes](/help/testing-live/acp-and-codex)). `openai/gpt-5.6` itself routes through the Codex app-server harness by default; see [Live: Codex app-server harness smoke](/help/testing-live/acp-and-codex#live-codex-app-server-harness-smoke).
- `fireworks`, `google`, `openrouter`, and `xai` only run their explicitly curated model ids in the modern sweep (no automatic "every model from this provider" expansion).
- Include at least one image-capable model (Claude/Gemini/OpenAI-family vision variants, etc.) in `OPENCLAW_LIVE_GATEWAY_MODELS` to exercise the image probe.

Run gateway smoke with tools + image across a hand-picked cross-provider set:

```bash
OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.6-luna,anthropic/claude-opus-4-6,google/gemini-3.1-pro-preview,google/gemini-3.5-flash,deepseek/deepseek-v4-flash,zai/glm-5.1,minimax/MiniMax-M3" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts
```

Optional additional coverage outside the curated lists (nice to have, pick a "tools"-capable model you have enabled):

- Mistral: `mistral/...`
- Cerebras: `cerebras/...` (if you have access)
- LM Studio: `lmstudio/...` (local; tool calling depends on API mode)

### Aggregators / alternate gateways

If you have keys enabled, you can also test via:

- OpenRouter: `openrouter/...` (hundreds of models; use `openclaw models scan` to find tool+image capable candidates)
- OpenCode: `opencode/...` for Zen and `opencode-go/...` for Go (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

More providers you can include in the live matrix (if you have creds/config):

- First-party provider plugins: `anthropic`, `cerebras`, `github-copilot`, `google`, `google-gemini-cli`, `google-vertex`, `groq`, `mistral`, `openai`, `openrouter`, `opencode`, `opencode-go`, `xai`, `zai`
- Via `models.providers` (custom endpoints): `minimax` (cloud/API), plus any OpenAI/Anthropic-compatible proxy (LM Studio, vLLM, LiteLLM, etc.)

<Tip>
Do not hardcode "all models" in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine plus whatever keys are available.
</Tip>
