---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Testing kit: unit/e2e/live suites, Docker runners, and what each test covers"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running tests locally or in CI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding regressions for model/provider bugs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging gateway + agent behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Testing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw has three Vitest suites (unit/integration, e2e, live) and a small set of Docker runners.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This doc is a “how we test” guide:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- What each suite covers (and what it deliberately does _not_ cover)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Which commands to run for common workflows (local, pre-push, debugging)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How live tests discover credentials and select models/providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to add regressions for real-world model/provider issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most days:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full gate (expected before push): `pnpm build && pnpm check && pnpm test`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you touch tests or want extra confidence:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Coverage gate: `pnpm test:coverage`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- E2E suite: `pnpm test:e2e`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When debugging real providers/models (requires real creds):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Live suite (models + gateway tool/image probes): `pnpm test:live`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: when you only need one failing case, prefer narrowing live tests via the allowlist env vars described below.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Test suites (what runs where)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Think of the suites as “increasing realism” (and increasing flakiness/cost):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Unit / integration (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command: `pnpm test`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `vitest.config.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Files: `src/**/*.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pure unit tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deterministic regressions for known bugs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expectations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Runs in CI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - No real keys required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Should be fast and stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### E2E (gateway smoke)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command: `pnpm test:e2e`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `vitest.e2e.config.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Files: `src/**/*.e2e.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Multi-instance gateway end-to-end behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - WebSocket/HTTP surfaces, node pairing, and heavier networking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expectations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Runs in CI (when enabled in the pipeline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - No real keys required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - More moving parts than unit tests (can be slower)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Live (real providers + real models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command: `pnpm test:live`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `vitest.live.config.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Files: `src/**/*.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: **enabled** by `pnpm test:live` (sets `OPENCLAW_LIVE_TEST=1`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - “Does this provider/model actually work _today_ with real creds?”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Catch provider format changes, tool-calling quirks, auth issues, and rate limit behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expectations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Costs money / uses rate limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Prefer running narrowed subsets instead of “everything”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Live runs will source `~/.profile` to pick up missing API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Anthropic key rotation: set `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (or `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) or multiple `ANTHROPIC_API_KEY*` vars; tests will retry on rate limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Which suite should I run?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this decision table:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Editing logic/tests: run `pnpm test` (and `pnpm test:coverage` if you changed a lot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debugging “my bot is down” / provider-specific failures / tool calling: run a narrowed `pnpm test:live`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Live: model smoke (profile keys)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Live tests are split into two layers so we can isolate failures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Direct model” tells us the provider/model can answer at all with the given key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Gateway smoke” tells us the full gateway+agent pipeline works for that model (sessions, history, tools, sandbox policy, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Layer 1: Direct model completion (no gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test: `src/agents/models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Goal:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Enumerate discovered models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Use `getApiKeyForModel` to select models you have creds for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Run a small completion per model (and targeted regressions where needed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to enable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `OPENCLAW_LIVE_MODELS=modern` (or `all`, alias for modern) to actually run this suite; otherwise it skips to keep `pnpm test:live` focused on gateway smoke（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to select models:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_MODELS=modern` to run the modern allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_MODELS=all` is an alias for the modern allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - or `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (comma allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to select providers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Where keys come from:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - By default: profile store and env fallbacks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Set `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Why this exists:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Separates “provider API is broken / key is invalid” from “gateway agent pipeline is broken”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Contains small, isolated regressions (example: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Layer 2: Gateway + dev agent smoke (what “@openclaw” actually does)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test: `src/gateway/gateway-models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Goal:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Spin up an in-process gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Create/patch a `agent:dev:*` session (model override per run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Iterate models-with-keys and assert:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - “meaningful” response (no tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - a real tool invocation works (read probe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - optional extra tool probes (exec+read probe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - OpenAI regression paths (tool-call-only → follow-up) keep working（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Probe details (so you can explain failures quickly):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `read` probe: the test writes a nonce file in the workspace and asks the agent to `read` it and echo the nonce back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `exec+read` probe: the test asks the agent to `exec`-write a nonce into a temp file, then `read` it back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - image probe: the test attaches a generated PNG (cat + randomized code) and expects the model to return `cat <CODE>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementation reference: `src/gateway/gateway-models.profiles.live.test.ts` and `src/gateway/live-image-probe.ts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to enable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to select models:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Default: modern allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` is an alias for the modern allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Or set `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (or comma list) to narrow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to select providers (avoid “OpenRouter everything”):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool + image probes are always on in this live test:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `read` probe + `exec+read` probe (tool stress)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - image probe runs when the model advertises image input support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Flow (high level):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Test generates a tiny PNG with “CAT” + random code (`src/gateway/live-image-probe.ts`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Sends it via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Gateway parses attachments into `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Embedded agent forwards a multimodal user message to the model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Assertion: reply contains `cat` + the code (OCR tolerance: minor mistakes allowed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: to see what you can test on your machine (and the exact `provider/model` ids), run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Live: Anthropic setup-token smoke（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test: `src/agents/anthropic.setup-token.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Goal: verify Claude Code CLI setup-token (or a pasted setup-token profile) can complete an Anthropic prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token sources (pick one):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Profile: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Raw token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model override (optional):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Live: CLI backend smoke (Claude Code CLI or other local CLIs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test: `src/gateway/gateway-cli-backend.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Goal: validate the Gateway + agent pipeline using a local CLI backend, without touching your default config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` if invoking Vitest directly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Model: `claude-cli/claude-sonnet-4-5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Command: `claude`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overrides (optional):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment (paths are injected into the prompt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as CLI args instead of prompt injection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (or `"list"`) to control how image args are passed when `IMAGE_ARG` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate resume flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` to keep Claude Code CLI MCP config enabled (default disables MCP config with a temporary empty file).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_LIVE_CLI_BACKEND=1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Recommended live recipes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Narrow, explicit allowlists are fastest and least flaky:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Single model, direct (no gateway):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Single model, gateway smoke:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool calling across several providers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google focus (Gemini API key + Antigravity):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `google/...` uses the Gemini API (API key).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `google-antigravity/...` uses the Antigravity OAuth bridge (Cloud Code Assist-style agent endpoint).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `google-gemini-cli/...` uses the local Gemini CLI on your machine (separate auth + tooling quirks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gemini API vs Gemini CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - API: OpenClaw calls Google’s hosted Gemini API over HTTP (API key / profile auth); this is what most users mean by “Gemini”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - CLI: OpenClaw shells out to a local `gemini` binary; it has its own auth and can behave differently (streaming/tool support/version skew).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Live: model matrix (what we cover)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There is no fixed “CI model list” (live is opt-in), but these are the **recommended** models to cover regularly on a dev machine with keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Modern smoke set (tool calling + image)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the “common models” run we expect to keep working:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI (non-Codex): `openai/gpt-5.2` (optional: `openai/gpt-5.1`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (optional: `openai-codex/gpt-5.3-codex-codex`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-5`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google (Gemini API): `google/gemini-3-pro-preview` and `google/gemini-3-flash-preview` (avoid older Gemini 2.x models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` and `google-antigravity/gemini-3-flash`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Z.AI (GLM): `zai/glm-4.7`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MiniMax: `minimax/minimax-m2.1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run gateway smoke with tools + image:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Baseline: tool calling (Read + optional Exec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick at least one per provider family:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI: `openai/gpt-5.2` (or `openai/gpt-5-mini`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: `anthropic/claude-opus-4-6` (or `anthropic/claude-sonnet-4-5`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google: `google/gemini-3-flash-preview` (or `google/gemini-3-pro-preview`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Z.AI (GLM): `zai/glm-4.7`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MiniMax: `minimax/minimax-m2.1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional additional coverage (nice to have):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- xAI: `xai/grok-4` (or latest available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mistral: `mistral/`… (pick one “tools” capable model you have enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cerebras: `cerebras/`… (if you have access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- LM Studio: `lmstudio/`… (local; tool calling depends on API mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Vision: image send (attachment → multimodal message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Include at least one image-capable model in `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI vision-capable variants, etc.) to exercise the image probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Aggregators / alternate gateways（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you have keys enabled, we also support testing via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenRouter: `openrouter/...` (hundreds of models; use `openclaw models scan` to find tool+image capable candidates)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenCode Zen: `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More providers you can include in the live matrix (if you have creds/config):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Built-in: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Via `models.providers` (custom endpoints): `minimax` (cloud/API), plus any OpenAI/Anthropic-compatible proxy (LM Studio, vLLM, LiteLLM, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: don’t try to hardcode “all models” in docs. The authoritative list is whatever `discoverModels(...)` returns on your machine + whatever keys are available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Credentials (never commit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Live tests discover credentials the same way the CLI does. Practical implications:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the CLI works, live tests should find the same keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a live test says “no creds”, debug the same way you’d debug `openclaw models list` / model selection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Profile store: `~/.openclaw/credentials/` (preferred; what “profile keys” means in the tests)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to rely on env keys (e.g. exported in your `~/.profile`), run local tests after `source ~/.profile`, or use the Docker runners below (they can mount `~/.profile` into the container).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Deepgram live (audio transcription)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Docker runners (optional “works in Linux” checks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These run `pnpm test:live` inside the repo Docker image, mounting your local config dir and workspace (and sourcing `~/.profile` if mounted):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway networking (two containers, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins (custom extension load + registry smoke): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Useful env vars:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_DIR=...` (default: `~/.openclaw`) mounted to `/home/node/.openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_WORKSPACE_DIR=...` (default: `~/.openclaw/workspace`) mounted to `/home/node/.openclaw/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` to narrow the run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Docs sanity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run docs checks after doc edits: `pnpm docs:list`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Offline regression (CI-safe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are “real pipeline” regressions without real providers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway tool calling (mock OpenAI, real gateway + agent loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.wizard.e2e.test.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent reliability evals (skills)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We already have a few CI-safe tests that behave like “agent reliability evals”:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mock tool-calling through the real gateway + agent loop (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- End-to-end wizard flows that validate session wiring and config effects (`src/gateway/gateway.wizard.e2e.test.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What’s still missing for skills (see [Skills](/tools/skills)):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Decisioning:** when skills are listed in the prompt, does the agent pick the right skill (or avoid irrelevant ones)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Compliance:** does the agent read `SKILL.md` before use and follow required steps/args?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workflow contracts:** multi-turn scenarios that assert tool order, session history carryover, and sandbox boundaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Future evals should stay deterministic first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A scenario runner using mock providers to assert tool calls + order, skill file reads, and session wiring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Adding regressions (guidance)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you fix a provider/model issue discovered in live:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a CI-safe regression if possible (mock/stub provider, or capture the exact request-shape transformation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If it’s inherently live-only (rate limits, auth policies), keep the live test narrow and opt-in via env vars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer targeting the smallest layer that catches the bug:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - provider request conversion/replay bug → direct models test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - gateway session/history/tool pipeline bug → gateway live smoke or CI-safe gateway mock test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
