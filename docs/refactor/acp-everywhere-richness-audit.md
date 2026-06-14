# ACP richness audit

**Purpose.** Turn "is ACP rich enough for our existing contracts?" into a row-by-row checklist instead of a vibes discussion. Companion to `docs/refactor/acp-everywhere.md`.

**Rating key.**

- 🟢 Covered by ACP today, maps cleanly.
- 🟡 Requires an additive Phase 1 extension (documented path, no protocol rewrite).
- 🔴 Fundamentally missing, would require a redesign of the seam.

**Headline.** 0 🔴, ~17 🟡, ~15 🟢. There are no hard blockers. The 🟡 list is the actual Phase 1 work and must land before Phase 3's parity gate.

## Session lifecycle

| Pi / existing contract              | ACP today                                              | After Phase 1                  | Fit |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------ | --- |
| New session with workspace + auth   | `ensureSession({ sessionKey, agent, mode, cwd, env })` | same                           | 🟢  |
| Resume by upstream session id       | `loadSession`, our `resumeSessionId`                   | same                           | 🟢  |
| Set session mode mid-session        | `session/set_mode`, our `setMode`                      | same                           | 🟢  |
| Per-session config options          | `session/set_config_option`, our `setConfigOption`     | keys advertised via capability | 🟢  |
| Cancel in-flight run                | `cancel` + `AbortSignal` on turn                       | same                           | 🟢  |
| Close with `discardPersistentState` | `close({ discardPersistentState })`                    | same                           | 🟢  |
| Health probe                        | `doctor()`                                             | same                           | 🟢  |

## Per-turn inputs

| Pi / existing contract                                                                  | ACP today                                               | After Phase 1                                                                           | Fit |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- | --- |
| Prompt text                                                                             | `session/prompt` text                                   | same                                                                                    | 🟢  |
| Attachments (images)                                                                    | `AcpRuntimeTurnAttachment` (mediaType + data)           | same; may carry size/path metadata                                                      | 🟢  |
| Run / request correlation id                                                            | `requestId` in `TurnInput`                              | same; echoed on every event                                                             | 🟡  |
| Abort signal                                                                            | `signal` in `TurnInput`                                 | same                                                                                    | 🟢  |
| Hard timeout                                                                            | via `AbortController` wrapping `signal`                 | same (no protocol-level timeout)                                                        | 🟢  |
| Provider / model                                                                        | `ensureSession({ agent })` + `setConfigOption("model")` | same                                                                                    | 🟢  |
| Auth profile id                                                                         | via `env` on `ensureSession` OR `setConfigOption`       | document the one chosen                                                                 | 🟡  |
| Thinking level                                                                          | `setConfigOption("thinking")` or `setMode("plan")`      | same                                                                                    | 🟢  |
| Verbose level                                                                           | `setConfigOption("verbose")`                            | same                                                                                    | 🟢  |
| Extra system prompt                                                                     | NOT modeled                                             | add optional `systemPromptExtras` on `ensureSession`; gated by capability               | 🟡  |
| Bootstrap context (mode + runKind)                                                      | NOT modeled                                             | add optional `bootstrapContext` on `ensureSession`; gated by capability                 | 🟡  |
| Skills snapshot                                                                         | NOT modeled                                             | add optional `skills` on `ensureSession`; gated by capability                           | 🟡  |
| Client tool surface                                                                     | Partially via `fs/*`, `terminal/*`                      | map OpenClaw client tools onto ACP client-tool methods                                  | 🟡  |
| Messaging / delivery context (channel/to/thread)                                        | NOT a runtime concern in ACP                            | backend uses client-tool callbacks; OpenClaw supplies a `messaging` client-tool surface | 🟡  |
| Provenance metadata                                                                     | `_meta` on ACP messages                                 | same                                                                                    | 🟢  |
| senderIsOwner / elevated gating                                                         | Pi-local flag today                                     | part of `SandboxPolicy` or `setConfigOption`                                            | 🟡  |
| Lane / queue                                                                            | OpenClaw-internal, stays in spawn module                | stays in spawn module                                                                   | 🟢  |
| Fast mode                                                                               | Pi-local flag today                                     | `setConfigOption("fastMode")`                                                           | 🟢  |
| `allowTransientCooldownProbe`, `cleanupBundleMcpOnRunEnd`, bootstrap warning signatures | Pi-specific flags                                       | `setConfigOption` or backend init; not protocol-level                                   | 🟢  |

## Events emitted during a turn

| Pi / existing contract             | ACP today                                | After Phase 1                                               | Fit |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------------------------- | --- |
| Lifecycle start                    | —                                        | new `lifecycle({ phase: "start" })` variant                 | 🟡  |
| Lifecycle end with stop reason     | `done({ stopReason })`                   | same                                                        | 🟢  |
| Lifecycle error                    | `error({ message, code, retryable })`    | same                                                        | 🟢  |
| Assistant text delta               | `text_delta({ stream: "output" })`       | same                                                        | 🟢  |
| Reasoning / thought delta          | tag `agent_thought_chunk`, not a variant | first-class `text_delta({ stream: "thought" })`             | 🟡  |
| Tool call start                    | `tool_call` (flat fields)                | extend with structured args + `phase: "start"`              | 🟡  |
| Tool call update                   | tag `tool_call_update`, not a variant    | first-class `tool_call_update` variant                      | 🟡  |
| Tool call end (with result)        | —                                        | `tool_call_update({ phase: "end", result })`                | 🟡  |
| Exec approval request              | —                                        | new `approval_request` variant (or reuse ACP permissions)   | 🟡  |
| Exec approval decision             | —                                        | new `approval_response` variant                             | 🟡  |
| Compaction start                   | —                                        | new `compaction({ phase: "start" })` variant                | 🟡  |
| Compaction progress                | —                                        | `compaction({ phase: "progress", used, size })`             | 🟡  |
| Compaction end (with retry signal) | —                                        | `compaction({ phase: "end", retry?: boolean })`             | 🟡  |
| Usage tick                         | tag `usage_update`, not a variant        | first-class `usage_update({ input, output, cache, total })` | 🟡  |
| Plan update                        | tag `plan`, not a variant                | first-class `plan_update({ plan })`                         | 🟡  |
| Session info update                | tag `session_info_update`, not a variant | first-class `session_info_update`                           | 🟡  |
| Final assistant text               | Implicit via text deltas + `done`        | same                                                        | 🟢  |

## Out-of-turn orchestration

| Pi / existing contract         | ACP today                           | After Phase 1                                                        | Fit |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------- | --- |
| Auth profile rotation          | Backend-internal (reads `agentDir`) | backend reads scope from `env`; rotation internal                    | 🟢  |
| Transcript persistence         | Spawn-module concern                | stays in spawn module; driven by event stream                        | 🟢  |
| Session store updates          | Spawn-module concern                | stays in spawn module                                                | 🟢  |
| Announce / delivery to channel | Spawn-module concern                | stays in spawn module; fired on `done`                               | 🟢  |
| Thread-binding lifecycle       | Channel plugin + spawn module       | stays in spawn module; backend oblivious                             | 🟢  |
| Depth / concurrency limits     | Spawn-module concern                | stays in spawn module                                                | 🟢  |
| Subagent registry              | Spawn-module concern                | stays in spawn module                                                | 🟢  |
| Sandbox enforcement            | Boolean flag today                  | `SandboxCapability` + `SandboxPolicy` + `satisfies()` (see RFC Cons) | 🟡  |
| Event ↔ run correlation        | Pi emits `runId` on each event      | `requestId` echoed on every event                                    | 🟡  |

## Verdict

- **🟢 ~15 rows** fit ACP as-is or are deliberately kept out of the seam (orchestration that stays in the spawn module).
- **🟡 ~17 rows** need additive Phase 1 extensions — mostly new event variants, plus four optional `ensureSession` inputs (skills, bootstrap context, system-prompt extras, client-tool surface).
- **🔴 0 rows** found that fundamentally don't fit. If the room identifies one during the meet, that's the RFC-killer signal and we should flag it hard.

## Top 5 Phase 1 extensions this audit justifies

These are the smallest concrete changes that turn all 🟡 rows green:

1. Split `tool_call` into `tool_call` (start) + `tool_call_update` (progress/end) with a structured `args` / `result` payload.
2. Add first-class event variants for `reasoning` (or `text_delta` with `stream: "thought"`), `compaction` (start/progress/end), `usage_update`, `plan_update`, `session_info_update`, `lifecycle` (start).
3. Add `approval_request` / `approval_response` variants for exec-approval gating, or bind to ACP's existing permission flow — whichever the team prefers.
4. Extend `AcpRuntimeEnsureInput` with optional, capability-gated `skills`, `systemPromptExtras`, `bootstrapContext` fields.
5. Define how messaging / delivery context becomes a _client-tool_ surface (the way `fs/*` and `terminal/*` already are), not an `AcpRuntime` input. Draft a `messaging/*` method set and have the backend call into it during a turn.

## How to use this at the meet

- Display the three section tables; skip rows whose color isn't debated.
- Ask the room: "anything here that you think is 🔴, not 🟡?" — any row promoted to red kills or reshapes the RFC.
- Ask: "anything here that you think is 🟡 but is actually 🟢 (already covered)?" — green-ification shrinks Phase 1.
- Rough time: 10 minutes to walk the three tables at high altitude; don't bikeshed individual event-variant naming in the meet, that's a Phase 1 PR review concern.
