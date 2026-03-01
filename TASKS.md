# OpenClaw — Current Tasks

_Last updated: 2026-02-27_

## Completed (this sprint)

- [x] **Gateway bind auto-correct** (#14542) — `fix/gateway-bind-tailscale-auto` — merged
- [x] **Session maintenance default** (#1949) — `fix/session-maintenance-enforce-default` — merged
- [x] **Outbound rate limiting** (#13627) — `feat/outbound-rate-limit` — merged
- [x] **xAI / Grok native tools** (#6872) — `xai_search` (X/Twitter search) + `xai_code_exec` (Python sandbox) implemented in `src/agents/tools/xai-native-tools.ts`
- [x] **Plugin lifecycle interception** (#12082) — `syntheticResult` injection + AI SDK hook wiring; hooks now fire for both pi-agent and AI SDK engine

## Active / Up Next

_No active tasks. See `docs/archive/by-date/2026-02-27/completed/forks-and-enhancements-2026-02-26.md` for remaining Tier 2 + Tier 3 candidates._

## Backlog candidates (Tier 2 from research)

- [ ] **Streaming tool-call deltas** (#9443) — expose partial tool-call tokens to plugins before the call completes
- [ ] **Structured output enforcement** (#11203) — validate LLM responses against a JSON schema before returning to agent
- [ ] **Agent memory versioning** (#8871) — allow rollback/diff of agent memory across sessions

See [Feature requests (2026-02-27)](docs/research/feature-requests-2026-02-27.md) for full scoring and implementation notes.
