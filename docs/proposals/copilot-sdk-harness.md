# Add the GitHub Copilot SDK as an Additional Agent Harness in OpenClaw

Repo: `https://github.com/openclaw/openclaw` (cloned to `C:\Users\ramrajba\openclaw`, `main`).
Target SDK: `@github/copilot-sdk` (Node/TypeScript, public preview). Companion runtime: GitHub Copilot CLI (bundled by the Node SDK).

> **Scope note:** PI is **not** being retired. The PI agent harness (`@earendil-works/pi-*` + `src/agents/pi-embedded-runner/`) stays in place as the default. This plan adds the GitHub Copilot SDK as a **second, peer harness** that users can opt into per agent / per provider, alongside any other plugin harnesses.

---

## 1. Problem statement

OpenClaw already has a clean harness abstraction in `src/agents/harness/`:

- `types.ts` — `AgentHarness` interface (`id`, `label`, `supports`, `runAttempt`, `runSideQuestion?`, `compact?`, `reset?`, `dispose?`).
- `registry.ts` — global `registerAgentHarness` keyed by `id`; pluggable.
- `selection.ts` — chooses a harness based on `policy.runtime` (`auto` / `pi` / any registered plugin id) plus per-attempt `agentHarnessId`. PI is the fallback for `auto`.
- `v2.ts` — V2 lifecycle (`prepare → start → resume → send → handleToolCall → resolveOutcome → cleanup`) with an `adaptAgentHarnessToV2` adapter so v1 harnesses Just Work.
- `builtin-pi.ts` — registers the built-in PI harness; the only thing it does is wrap `runEmbeddedAttempt` from `pi-embedded-runner`.

This is exactly the seam an additional Copilot SDK harness plugs into. No core rewrite, no provider migration, no PI retirement.

The work is therefore narrow and well-bounded:

1. Implement a `copilot-sdk` `AgentHarness` that translates between OpenClaw's existing `EmbeddedRunAttemptParams`/`EmbeddedRunAttemptResult` contract and the Copilot SDK's `CopilotClient`/`CopilotSession` API.
2. Register it via the documented plugin path so it shows up next to PI.
3. Make it opt-in by config / CLI flag / env knob. Default selection (`auto`) continues to land on PI.
4. Cover the surface that matters in unit + one live smoke test.

### What we are *not* doing

- Not changing `selection.ts` defaults.
- Not removing or deprecating `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, or `pi-tui`.
- Not rewriting the 383 import sites that reach into `@earendil-works/pi-*`.
- Not touching `src/agents/pi-embedded-runner/`, `src/agents/pi-hooks/`, `src/agents/pi-embedded-helpers/`, or `src/agents/harness/builtin-pi.ts` beyond what's needed to expose extracted neutral helpers (e.g. tool-policy) so both harnesses can reuse them.
- Not removing any PI provider extension (`extensions/anthropic*`, `extensions/amazon-bedrock*`).
- Not migrating channel delivery, transcript file format, or auth-profile storage off PI shapes.
- Not replacing `pi-tui` or anything in `src/tui`.

---

## 2. Architectural mismatch (and how the harness hides it from the rest of OpenClaw)

| Concern | PI (existing default) | Copilot SDK (new opt-in harness) | How the harness reconciles |
|---|---|---|---|
| Process model | In-process library | Out-of-process Copilot CLI subprocess over JSON-RPC; SDK manages lifecycle | Pool one `CopilotClient` per `copilotHome`; harness owns spawn/teardown |
| Loop ownership | OpenClaw's `runEmbeddedAttempt` | `session.send` / `sendAndWait` | `runCopilotSdkAttempt` calls `sendAndWait`, listens to events, projects them into OpenClaw's `EmbeddedRunAttemptResult` |
| Streaming | Per-provider stream wrappers + block chunker | `streaming: true`, `assistant.message_delta` / `assistant.reasoning_delta` events | Subscribe to delta events; reuse the existing block chunker for channel delivery |
| Tools | OpenClaw owns the tool list (pi-tools, bash-tools, apply-patch, message tool, channel plugins) | `tools?: Tool[]` per session + `onPermissionRequest` (required) + `onUserInputRequest` + `tool.execution_*` events | A `tool-bridge` converts each OpenClaw tool to a Copilot SDK `Tool` and proxies execution back into the existing tool runner |
| Permission policy | `pi-tools.before-tool-call.ts`, `effective-tool-policy.ts` | `onPermissionRequest` callback | Extract a runtime-neutral `before-tool-call` helper (small refactor); both harnesses call it. PI keeps its existing wiring. |
| User-input from tools | OpenClaw inline | `onUserInputRequest` | Bridge to existing channel/TUI prompt flow (`commitments/`) |
| Compaction | OpenClaw drives `compact.runtime.ts`; persists `compactionSummary` custom message | `infiniteSessions: { ... }` config; SDK auto-compacts; exposes `workspacePath` with `checkpoints/`, `plan.md`, `files/` | Harness `compact()` enables `infiniteSessions` and writes an OpenClaw-shaped marker file (`workspacePath/files/openclaw-compaction-<ts>.json`) so the rest of OpenClaw still sees a familiar artifact |
| Side-questions | `runSideQuestion` against raw `Model<Api>` | A short-lived `client.createSession({ infiniteSessions: false, tools: [] })` + `sendAndWait` + `disconnect` | Pool one "scratch" session per agent for back-to-back questions |
| Auth | Per-agent `AuthProfileStore`, multi-profile rotation | `useLoggedInUser`, `gitHubToken`, or `provider: ProviderConfig` BYOK; `copilotHome` per agent | Per-profile mapping inside the harness; PI's `AuthProfileStore` stays untouched and ignored when the active harness is `copilot-sdk` |
| Models | 10+ providers via PI | `gpt-5`, `gpt-5.5`, `gpt-4.1`, `claude-sonnet-4.5`, etc., plus BYOK | Harness exposes `supports(ctx)` returning `true` only for the model set Copilot SDK actually handles. Anything outside that set falls through to PI by way of `selection.ts`'s existing `auto_pi` branch. |
| Reasoning | OpenClaw's `auto-reply/thinking.ts` resolves `ThinkLevel`/`ReasoningLevel` | `reasoningEffort: "low"|"medium"|"high"|"xhigh"` | One mapping function; nothing in the rest of the codebase changes |
| Transcript persistence | OpenClaw's `transcript-file-state.ts` | Copilot CLI writes under `~/.copilot/...`; reachable via `client.listSessions/resumeSession/getMessages` | Harness dual-writes an OpenClaw-format transcript next to the SDK's session so the existing transcript readers keep working |
| Replay | `replay-state.ts` | `client.resumeSession(sessionId)` | Harness `runAttempt` honors `initialReplayState` by either resuming the matching SDK session id or starting a fresh one |
| Cancel/abort | OpenClaw aborts via attempt context | `session.abort()` | Wired in `attempt.ts` |
| Reset | `harness.reset(...)` | `client.deleteSession(sessionId)` | Implemented in harness; matches the `resetRegisteredAgentHarnessSessions` flow in `registry.ts` |
| Dispose | `harness.dispose` | `await client.stop()` | Implemented in harness; pool releases all clients |
| Telemetry | OpenClaw's `diagnostic-events.ts` | `telemetry?: TelemetryConfig` (OpenTelemetry) + `onGetTraceContext` | Bridge in `telemetry-bridge.ts`; opt-in |
| TUI | `@earendil-works/pi-tui` (separate concern) | n/a | Not in scope |

The whole point: every column on the right is implemented **inside the new harness module**. Nothing outside `src/agents/copilot-sdk-runtime/` and `src/agents/harness/builtin-copilot-sdk.ts` changes shape. PI keeps its full footprint, untouched.

---

## 3. Approach

### 3.1 Strategy

A single track:

1. Add `@github/copilot-sdk` as a dependency.
2. Build `src/agents/copilot-sdk-runtime/` (small, self-contained module) that mirrors the few PI-runner concepts the harness contract needs.
3. Ship `src/agents/harness/builtin-copilot-sdk.ts` registering an `id: "copilot-sdk"` `AgentHarness` via the documented plugin path.
4. Extend the runtime policy enum to accept `"copilot-sdk"`.
5. Make selection opt-in: a user has to set `agentHarnessId: "copilot-sdk"` (per-agent config) or pass `--harness copilot-sdk` (CLI) or set `OPENCLAW_AGENT_HARNESS=copilot-sdk` (env). `auto` keeps falling back to PI.
6. Test it (focused unit tests with injected SDK fakes; one live smoke gated on `OPENCLAW_LIVE_TEST=1`).
7. Document it.

### 3.2 Why this is the right shape

- Matches the documented architecture in the root `AGENTS.md`: "Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels." A second harness registered via plugin SDK is exactly that.
- `selection.ts` already supports `forced_pi`, `forced_plugin`, `auto_plugin`, `auto_pi`. No selection logic changes; `copilot-sdk` shows up as just another `auto_plugin`/`forced_plugin` candidate, but only matches when the caller asks for it.
- No risk to existing PI users; no behavior change for anyone who doesn't opt in.
- The Copilot SDK is in **public preview** — keeping it side-by-side with PI means SDK breakage cannot brick the product.

### 3.3 Module layout

```
src/agents/copilot-sdk-runtime/
  runtime.ts          # Pooled CopilotClient per copilotHome. Lifecycle.
  attempt.ts          # runCopilotSdkAttempt(params): EmbeddedRunAttemptResult
  event-bridge.ts     # Session events -> AssistantMessage / AgentMessage
  tool-bridge.ts      # OpenClaw tools -> SDK Tool[] + onPermissionRequest
  permission-bridge.ts# Calls extracted neutral before-tool-call helper
  user-input-bridge.ts# onUserInputRequest -> channel/TUI prompts
  hooks-bridge.ts     # SDK SessionHooks -> harness lifecycle hooks
  auth-bridge.ts      # AuthProfileStore -> {gitHubToken | useLoggedInUser, copilotHome}
  usage-bridge.ts     # SDK signals -> NormalizedUsage
  compaction.ts       # harness.compact via infiniteSessions + workspace marker
  side-question.ts    # harness.runSideQuestion via transient session
  reset.ts            # harness.reset via deleteSession
  provider-mapping/   # Optional BYOK adapters per provider (added on demand)
  *.test.ts           # Per-bridge focused unit tests with injected fakes
  attempt.live.e2e.test.ts   # OPENCLAW_LIVE_TEST=1 only

src/agents/harness/
  builtin-copilot-sdk.ts    # createCopilotSdkAgentHarness(): AgentHarness
  policy.ts                 # runtime enum extended with "copilot-sdk"

src/plugins/builtin/
  copilot-sdk-harness.ts    # registerAgentHarness(...) on bootstrap
```

Nothing in `src/agents/pi-embedded-runner/`, `src/agents/pi-hooks/`, `src/agents/pi-embedded-helpers/`, or `src/types/pi-*.d.ts` is touched.

### 3.4 The single small refactor outside the new module

To avoid duplicating tool-policy logic, extract the runtime-neutral parts of `src/agents/pi-tools.before-tool-call.ts` into `src/agents/before-tool-call.ts`. PI calls it, the new harness calls it. This is purely additive (rename + re-export shim from the old path) and does not change PI behavior.

If extracting cleanly proves invasive in review, the fallback is to copy the policy logic into `permission-bridge.ts` with a comment pointing at the PI source — acceptable for an additive feature.

### 3.5 Configuration surface

- `agents/harness/policy.ts` runtime enum gains `"copilot-sdk"` alongside `"auto"` and `"pi"`. `auto` behavior unchanged.
- New optional file `~/.openclaw/agents/<agentId>/agent/copilot.json`: `{ copilotHome?, model?, reasoningEffort?, infiniteSessions?, provider? }`. Absent means "use sensible defaults derived from the agent's existing config".
- New env knobs: `OPENCLAW_AGENT_HARNESS=copilot-sdk`, `OPENCLAW_COPILOT_CLI_PATH`, `OPENCLAW_COPILOT_HOME_BASE` (defaults to `~/.openclaw/agents/<id>/copilot`).
- New CLI flag: `openclaw agent --harness copilot-sdk` (already plumbed via `agentHarnessId` in `selectAgentHarness`).
- New `openclaw doctor` probe that verifies `copilot --version`, auth, and `copilotHome` writability — only runs when at least one agent has `agentHarnessId: "copilot-sdk"`.

### 3.6 Auth model

- Default: `useLoggedInUser: true` against `copilotHome = ~/.openclaw/agents/<agentId>/copilot`. Each agent gets isolated Copilot CLI state.
- Headless / cron: `gitHubToken` resolved from the existing `AuthProfileStore` if a `github-copilot` profile exists; otherwise from `GITHUB_TOKEN`/`OPENCLAW_GITHUB_TOKEN` env.
- BYOK (only if/when needed for a provider that the user wants under Copilot SDK): `provider: ProviderConfig` filled from a `provider-mapping/<provider>.ts` adapter.

PI's auth-profile machinery is **not** touched. When the active harness is `copilot-sdk`, the harness reads what it needs from `AuthProfileStore` and ignores the rest.

### 3.7 Risk register

| Risk | Mitigation |
|---|---|
| Copilot SDK is preview, breaking changes | Pin a minor version; add a smoke E2E gated on `OPENCLAW_LIVE_TEST=1`; PI is always the fallback so SDK breakage cannot brick the product |
| CLI subprocess per agent multiplies process count | Pool one `CopilotClient` per `copilotHome`; reuse across attempts; release on harness `dispose` |
| Permission UX regression for channel users approving tools out-of-band | `onPermissionRequest` proxies to existing `commitments/` flow; long waits supported because the SDK call is awaitable |
| Transcript divergence between SDK session disk format and OpenClaw's transcript readers | Harness dual-writes an OpenClaw-format transcript next to the SDK session for compatibility |
| `compactionSummary` custom messages don't appear under `infiniteSessions` | Persist OpenClaw's compaction marker as a JSON file in `workspacePath/files/`; readers updated to look there too |
| Side-question latency (creating a CLI session per call) | Pool one scratch session per agent; reset between questions |
| Replay parity with `replay-state.ts` | Honor `initialReplayState` by `resumeSession` when the SDK session id is recorded; otherwise log a downgrade and start fresh |
| Bundled extensions (`extensions/anthropic*`, `extensions/amazon-bedrock*`) own PI imports | Untouched; they continue to back the PI harness for their providers. The new harness simply does not advertise `supports: true` for those provider/model combos unless a BYOK mapping exists |
| Test cost for live smoke | Single live test, single model (`gpt-4.1`), single tool — minimal token spend |

---

## 4. Phases

Three short phases. All sequential at the gate level; PRs within a phase can land in parallel.

### Phase 0 — Discovery & spike

- Read `node_modules/@github/copilot-sdk` `.d.ts` after install, plus the Cookbook, and produce a short `qa/copilot-sdk-capabilities.md` listing: lifecycle methods, event types, tool/permission/user-input contracts, infiniteSessions behavior, BYOK shape.
- Stand up `apps/copilot-sdk-spike/` (excluded from build/dist) that runs a one-turn session with one custom tool. Confirms the shape before touching production code.
- Capture baseline `pnpm test src/agents` duration + RSS per `src/agents/AGENTS.md` perf rules (so the new module's overhead is measurable, not assumed).

Exit: capability doc + working spike.

### Phase 1 — Harness MVP (opt-in, no defaults change)

- Add dep `@github/copilot-sdk`, `pnpm install`, confirm bundled `copilot` CLI runs.
- Build `src/agents/copilot-sdk-runtime/` (runtime, attempt, event-bridge, tool-bridge, usage-bridge).
- Ship `src/agents/harness/builtin-copilot-sdk.ts`.
- Register via `src/plugins/builtin/copilot-sdk-harness.ts` (documented plugin path; no changes to `src/agents/harness/selection.ts` other than the policy enum widening).
- Extend `policy.ts` runtime enum; document.
- CLI flag `--harness copilot-sdk`.
- Focused per-bridge unit tests with injected fakes.
- One live smoke (`OPENCLAW_LIVE_TEST=1`) on `gpt-4.1` with one custom tool.

Exit: `pnpm test`, `pnpm tsgo:prod`, `pnpm check` green; opt-in path works end to end; PI-only users see zero behavior change.

### Phase 2 — Capability surface

- `harness.compact` via `infiniteSessions` + workspace marker.
- `harness.runSideQuestion` via pooled transient session.
- `harness.reset` and `harness.dispose` lifecycle.
- Permission/user-input/hooks/auth bridges (extract neutral `before-tool-call.ts`; PI keeps its existing call site through a re-export).
- Optional telemetry bridge.
- Optional dual-write transcript adapter so existing OpenClaw transcript readers see SDK sessions.
- Add BYOK provider mappings only on demand (no fan-out unless a user/team asks for a specific provider under the new harness).
- `openclaw doctor` probe.

Exit: every method on `AgentHarness` (and the V2 lifecycle in `harness/v2.ts`) has a Copilot-SDK implementation; recorded fixture conversations on `gpt-4.1` / `gpt-5` / `claude-sonnet-4.5` produce structurally equivalent outputs to PI runs (tool-call order, message ordering, usage shape — content drift tolerated).

### Phase 3 — Documentation & long tail

- New page `docs/concepts/agent-harnesses.md` describing harness selection, the PI default, the Copilot SDK opt-in path, auth, configuration, and trade-offs.
- Update `docs/concepts/models.md` and onboarding to mention the option.
- Changelog entry under `### Changes`.
- Optional: a small example agent config in `docs/examples/`.

Exit: docs published; one external user report or internal dogfood agent running on the new harness.

There is **no Phase 4 retiring PI**. PI stays.

---

## 5. Per-component work breakdown

Each item is sized for one PR. IDs match the SQL todo table.

1. `sdk-capability-doc` — `qa/copilot-sdk-capabilities.md` from `.d.ts` + Cookbook.
2. `spike-app` — `apps/copilot-sdk-spike/`, excluded from build.
3. `add-sdk-dep` — add `@github/copilot-sdk` to root `package.json`; `pnpm install`; confirm bundled CLI.
4. `runtime-pool` — `src/agents/copilot-sdk-runtime/runtime.ts` pooled `CopilotClient` per `copilotHome`.
5. `attempt-bridge` — `attempt.ts` implementing `runCopilotSdkAttempt`.
6. `event-bridge` — translate session events to OpenClaw assistant/agent messages.
7. `tool-bridge` — translate OpenClaw tools to SDK `Tool[]`; route through permission bridge.
8. `usage-bridge` — fill `NormalizedUsage` from SDK signals; mark unavailable fields undefined.
9. `harness-shim` — `src/agents/harness/builtin-copilot-sdk.ts` (`id: "copilot-sdk"`).
10. `plugin-register` — `src/plugins/builtin/copilot-sdk-harness.ts` registering on bootstrap.
11. `policy-runtime-enum` — extend `policy.ts` runtime enum and config schema.
12. `cli-flag` — `openclaw agent --harness copilot-sdk` plumbing.
13. `unit-tests-mvp` — focused tests per bridge with injected SDK fakes.
14. `live-smoke` — `attempt.live.e2e.test.ts` under `OPENCLAW_LIVE_TEST=1`.
15. `compaction-impl` — `harness.compact` via `infiniteSessions`; OpenClaw marker in `workspacePath/files/`.
16. `side-question-impl` — `runSideQuestion` via pooled transient session.
17. `reset-dispose-impl` — `reset` (`deleteSession`) and `dispose` (`stop`) lifecycle.
18. `permission-extract` — extract runtime-neutral `before-tool-call.ts`; PI keeps current call site via re-export.
19. `permission-bridge` — Copilot SDK `onPermissionRequest` calls the extracted helper.
20. `user-input-bridge` — `onUserInputRequest` to existing channel/TUI prompt path.
21. `hooks-bridge` — SDK `SessionHooks` to `harness/lifecycle-hook-helpers.ts`.
22. `auth-bridge` — `AuthProfileStore` -> `{gitHubToken | useLoggedInUser, copilotHome}`; client pooling per profile.
23. `byok-mapping-skeleton` — `provider-mapping/` framework (only used when a user asks for a non-subscription model under the new harness).
24. `dual-write-transcripts` — write OpenClaw audit transcript next to SDK session.
25. `replay-shim` — honor `initialReplayState` via `resumeSession`; downgrade gracefully when not possible.
26. `telemetry-bridge` — `TelemetryConfig` + `onGetTraceContext` to OpenClaw diagnostic events.
27. `doctor-copilot-sdk` — `openclaw doctor` probes (CLI version, auth, `copilotHome`).
28. `docs-harnesses` — `docs/concepts/agent-harnesses.md` and onboarding/models updates.
29. `changelog` — entry under `### Changes`.
30. `dogfood-agent` — run one internal agent on `copilot-sdk` for a release cycle; capture findings.

---

## 6. Validation strategy

- Per PR: `pnpm check:changed`, `pnpm test:changed`, `pnpm tsgo:prod`. Build only when packaging or dynamic-import boundaries change (see root `AGENTS.md`).
- Per phase: full `pnpm test`, `pnpm test:extensions`, `pnpm check`, `pnpm tsgo:all`, `pnpm check:import-cycles`. Crabbox/Testbox for full lanes per `AGENTS.md`.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live` covering one Copilot subscription account on `gpt-4.1` with one custom tool.
- Behavior parity (informational, not gating): record fixture conversations under PI for `gpt-4.1`, `gpt-5`, `claude-sonnet-4.5`; replay under the new harness; diff structurally (tool-call order, message ordering, usage shape).
- Performance: `src/agents/AGENTS.md` flags this surface as import-bound. Capture seconds + RSS for `pnpm test src/agents/copilot-sdk-runtime` on every phase boundary.
- Regression check that **PI behavior is unchanged**: `pnpm test src/agents/pi-embedded-runner` must pass without modification at every phase.

---

## 7. Open questions

1. Which Copilot subscription does OpenClaw plan to use for live tests in CI, and what's the per-release token budget?
2. Should the new harness advertise `supports: true` for any non-subscription model on day one, or stay subscription-only until a user asks for BYOK?
3. Permission UX: are long-running channel approvals (seconds-to-minutes) acceptable inside `onPermissionRequest`, or do we need a fast-path?
4. Does the `before-tool-call` extraction in Phase 2 need owner sign-off (it touches a PI-adjacent file), or can it land as a maintainer refactor?
5. Should the pooled `CopilotClient` be process-global or per-agent? Per-agent is safer; process-global is cheaper.

---

## 8. Notes / considerations

- Root `AGENTS.md`: "Core stays plugin-agnostic." The new harness registers via `src/plugins/builtin/`, not by editing core selection logic.
- `src/agents/AGENTS.md`: agent tests are import-bound. Keep `copilot-sdk-runtime` behind dependency injection so unit tests do not cold-load the SDK or spawn the CLI.
- `src/agents/pi-embedded-runner/run/AGENTS.md`: full-runner tests are expensive; mirror that discipline in the new harness — focused per-bridge tests are mandatory; a single full-attempt test is the exception, not the rule.
- Per the security/release rules in root `AGENTS.md`, dependency adds beyond a single new SDK package should be flagged for approval.
- Beta tag semantics: any release shipping the new harness uses the `vYYYY.M.D-beta.N` convention until we mark it stable.
