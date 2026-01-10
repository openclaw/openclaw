---
summary: "Testing kit: unit/e2e/live suites, Docker runners, and what each test covers"
read_when:
  - Running tests locally or in CI
  - Adding regressions for model/provider bugs
  - Debugging gateway + agent behavior
---

# Testing

Clawdbot has three Vitest suites (unit, e2e, live) plus a couple Docker helpers for “run with my real keys” smoke checks.

## Quick start

- Full gate (what we expect before push): `pnpm lint && pnpm build && pnpm test`
- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`
- Live suite (opt-in, Clawdbot only): `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- Live suite (opt-in, includes provider live tests too): `LIVE=1 pnpm test:live`

## Test suites (what runs where)

### Unit / integration (default)

- Command: `pnpm test`
- Config: `vitest.config.ts`
- Files: `src/**/*.test.ts`
- Scope: pure unit tests + in-process integration tests (gateway server auth, routing, tooling, parsing, config).

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`
- Scope: multi-instance gateway end-to-end behavior (WebSocket/HTTP/node pairing), heavier networking surface.

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`
- Default: **skipped** unless `CLAWDBOT_LIVE_TEST=1` or `LIVE=1`
- Scope: “does this provider/model actually work today with real creds”.

## Live: model smoke (profile keys)

Two layers:

1. Direct model completion (no gateway):
   - Test: `src/agents/models.profiles.live.test.ts`
   - Goal: enumerate discovered models, use `getApiKeyForModel` to pick ones you have creds for, then run a small completion.
   - Selection:
     - `CLAWDBOT_LIVE_ALL_MODELS=1` (required to run the suite)
     - `CLAWDBOT_LIVE_MODELS=all` or comma allowlist (`openai/gpt-5.2,anthropic/claude-opus-4-5,...`)
     - `CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not ad-hoc env).
   - Regression hook: OpenAI Responses tool-only → follow-up path (the `reasoning` replay class) is covered here.

2. Gateway + dev agent smoke (what “@clawdbot” actually does):
   - Test: `src/gateway/gateway-models.profiles.live.test.ts`
   - Goal: spin up an in-process gateway, create/patch a `agent:dev:*` session, iterate models-with-keys, and assert “meaningful” responses.
   - Covers providers present in your `models.json`/config (e.g. OpenAI, Anthropic, Google Gemini, `google-antigravity`, etc.) as long as a key/profile is available.
   - Selection:
     - `CLAWDBOT_LIVE_GATEWAY=1`
     - `CLAWDBOT_LIVE_GATEWAY_ALL_MODELS=1` (scan all discovered models with available keys)
     - `CLAWDBOT_LIVE_GATEWAY_MODELS=all` or comma allowlist
   - Extra regression: for OpenAI Responses/Codex Responses models, force a tool-call-only turn followed by a user question (the exact failure mode that produced `400 … reasoning … required following item`).

## Credentials (never commit)

Live tests discover credentials the same way the CLI does:

- Profile store: `~/.clawdbot/credentials/` (preferred; what “profile keys” means in the tests)
- Config: `~/.clawdbot/clawdbot.json` (or `CLAWDBOT_CONFIG_PATH`)

If you want to rely on env keys (e.g. exported in your `~/.profile`), run local tests after `source ~/.profile`, or use the Docker runners below (they can mount `~/.profile` into the container).

## Docker runners (optional “works in Linux” checks)

These run `pnpm test:live` inside the repo Docker image, mounting your local config dir and workspace (and sourcing `~/.profile` if mounted):

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)

Useful env vars:

- `CLAWDBOT_CONFIG_DIR=...` (default: `~/.clawdbot`) mounted to `/home/node/.clawdbot`
- `CLAWDBOT_WORKSPACE_DIR=...` (default: `~/clawd`) mounted to `/home/node/clawd`
- `CLAWDBOT_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests
- `CLAWDBOT_LIVE_GATEWAY_MODELS=...` / `CLAWDBOT_LIVE_MODELS=...` to narrow the run
- `CLAWDBOT_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)

## Docs sanity

Run docs checks after doc edits: `pnpm docs:list`.

## Offline regression (CI-safe)

- Gateway tool calling (mock OpenAI, real gateway + agent loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.wizard.e2e.test.ts`
