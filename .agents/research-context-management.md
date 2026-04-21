# How OpenClaw Manages Context for an Agent Turn

OpenClaw does not implement its own inference loop; it drives `@mariozechner/pi-coding-agent` session objects and layers context plumbing (sanitize, limit, compact, prompt-cache observability, pluggable context engines) around the call site. The turn entry point for a live reply is `runEmbeddedAttempt` in `src/agents/pi-embedded-runner/run/attempt.ts`, which assembles messages + system prompt + tools into an `activeSession` before invoking `activeSession.prompt(effectivePrompt, ...)`.

## 1. Context assembly (entry point and shape)

`runEmbeddedAttempt` (`src/agents/pi-embedded-runner/run/attempt.ts:406`) composes four kinds of input into one Pi `session`:

- **System prompt** — built from config + skills + hooks, then applied via `applySystemPromptOverrideToSession(session, systemPromptText)` (`src/agents/pi-embedded-runner/run/attempt.ts:1116`). Context-engine additions are prepended if `assemble()` returned a `systemPromptAddition` (`src/agents/pi-embedded-runner/run/attempt.ts:1537`).
- **Tools** — built-in tools from `createOpenClawCodingTools(...)` plus `clientToolDefs` are concatenated (`src/agents/pi-embedded-runner/run/attempt.ts:1101`) and passed into `createAgentSession({ tools: builtInTools, customTools: allCustomTools, ... })` (`src/agents/pi-embedded-runner/run/attempt.ts:1103`).
- **Transcript** — loaded by `SessionManager.open(sessionFile)` (via Pi) into `activeSession.messages`; then passed through a sanitize/validate/limit/repair pipeline (`src/agents/pi-embedded-runner/run/attempt.ts:1465-1515`). The pipeline runs `sanitizeSessionHistory` → `validateReplayTurns` → `filterHeartbeatPairs` → `limitHistoryTurns` → `sanitizeToolUseResultPairing`, and writes the result to `activeSession.agent.state.messages`.
- **Pluggable context-engine hook** — if a `ContextEngine` is registered, `assembleAttemptContextEngine(...)` is called with `{ messages, tokenBudget, availableTools, citationsMode, modelId, prompt }` and may replace `activeSession.agent.state.messages` wholesale (`src/agents/pi-embedded-runner/run/attempt.ts:1518-1546`). The `ContextEngine` contract is defined at `src/context-engine/types.ts:240` (`assemble()` returns `{ messages, estimatedTokens, systemPromptAddition? }`).

The final call is `activeSession.prompt(effectivePrompt, { images })` at `src/agents/pi-embedded-runner/run/attempt.ts:2172-2175` — OpenClaw never hand-builds a provider payload; Pi's session does that from `state.messages` + its `streamFn`.

## 2. Transcript model and persistence

- Transcripts live on disk as newline-delimited JSON under `<agentsDir>/<agentId>/sessions/` (`src/agents/session-dirs.ts:6-9`) with paths resolved by `resolveSessionFilePath()` in `src/config/sessions/paths.ts:263`. Agent isolation is thus a filesystem boundary — each `agentId` has its own `sessions/` directory tree.
- Pi's `SessionManager` owns message append / branch / leaf tracking; OpenClaw calls `SessionManager.open(sessionFile)` and `sessionManager.buildSessionContext()` to rebuild in-memory messages (`src/agents/pi-embedded-runner/manual-compaction-boundary.ts:44,60,95`).
- Writes are protected by `acquireSessionWriteLock({ sessionFile, maxHoldMs })` (`src/agents/pi-embedded-runner/run/attempt.ts:463` and `src/agents/session-write-lock.ts:1-48`), using file locks with PID/start-time liveness checks so concurrent process writes can't corrupt a session.
- Session identity is the `(sessionKey, sessionId)` pair carried through every call; `sandboxSessionKey = params.sessionKey?.trim() || params.sessionId` (`src/agents/pi-embedded-runner/run/attempt.ts:419`) keeps it stable across turns.

## 3. Compaction / `/compact`

There are three triggers:

- **Manual `/compact` from chat** — `handleCompactCommand` (`src/auto-reply/reply/commands-compact.ts:78`) aborts any active run, resolves the `sessionFile`, then calls `runtime.compactEmbeddedPiSession(...)` with `trigger: "manual"`. After compaction it hardens the boundary via `hardenManualCompactionBoundary` (`src/agents/pi-embedded-runner/manual-compaction-boundary.ts:41`), which rewrites the latest compaction entry's `firstKeptEntryId` to point at the summary itself so prior turns aren't kept alive.
- **Preemptive (pre-prompt) compaction** — Before every turn, `shouldPreemptivelyCompactBeforePrompt(...)` (`src/agents/pi-embedded-runner/run/preemptive-compaction.ts:41`) estimates `system + prompt + messages` tokens, applies `SAFETY_MARGIN` (1.2 in `src/agents/compaction.ts:21`), and picks one of four routes: `fits`, `truncate_tool_results_only`, `compact_only`, `compact_then_truncate` (`src/agents/pi-embedded-runner/run/preemptive-compaction.ts:83-92`). The call site is `src/agents/pi-embedded-runner/run/attempt.ts:2069-2091`. Oversized tool results are preferred for truncation (cheap) over real summarization.
- **Overflow recovery** — when the provider itself returns a context-overflow error, the same compaction machinery is invoked through `delegateCompactionToRuntime()` (`src/context-engine/delegate.ts:33-64`), which the `LegacyContextEngine` (`src/context-engine/legacy.ts:70-82`) forwards verbatim.

Summarization itself lives in `src/agents/compaction.ts`:
- `estimateMessagesTokens()` strips `toolResult.details` before estimation to keep untrusted payloads out of LLM-facing summaries (`src/agents/compaction.ts:103-107`, noted as a security rule).
- `splitMessagesByTokenShare()` chunks the transcript by token share while refusing to split across a pending `tool_use`/`tool_result` pair (`src/agents/compaction.ts:120-209`) — tool call pairs stay verbatim inside one chunk.
- `summarizeInStages()` → `summarizeWithFallback()` → `summarizeChunks()` produces the summary with three-tier fallback: full summary, small-message-only summary noting oversized messages, and a final "`Summary unavailable due to size limits`" placeholder (`src/agents/compaction.ts:438-442`).
- After rewriting, `pruneHistoryForContextShare()` runs `repairToolUseResultPairing` so orphan tool_results from dropped chunks don't poison the next prompt (`src/agents/compaction.ts:546`).

## 4. Prompt-cache ordering / "deterministic ordering" rule

The AGENTS.md rule ("deterministic ordering for maps/sets/registries/plugin lists/files/network results before model/tool payloads") is enforced at multiple sites:

- **Tool digest used for prompt-cache break detection** sorts names before hashing: `digestText(JSON.stringify([...toolNames].toSorted()))` at `src/agents/pi-embedded-runner/prompt-cache-observability.ts:65`. The comment explicitly says "order changes alone should not look like a real cache break when the same tool set is still present."
- **System-prompt capability IDs** get deduped and sorted by `normalizePromptCapabilityIds()` at `src/agents/prompt-cache-stability.ts:10-22` (used by `delegateCompactionToRuntime`'s `normalizeStructuredPromptSection` path).
- **Memory prompt supplements** are sorted by plugin id before flattening so registration order can't churn cache bytes: `src/plugins/memory-state.ts:214-217` — `toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))` with the inline comment "Keep supplement order stable even if plugin registration order changes."

The prompt-cache observability module (`src/agents/pi-embedded-runner/prompt-cache-observability.ts:80-130`) compares snapshots across turns and emits a `PromptCacheChange[]` with codes `cacheRetention | model | streamStrategy | systemPrompt | tools | transport`, which then rides out to tracing and the context-engine result via `buildContextEnginePromptCacheInfo()` (`src/agents/pi-embedded-runner/run/attempt.context-engine-helpers.ts:55-98`).

## 5. Memory integration

Memory plugins hook into context assembly through two seams in `src/plugins/memory-state.ts`:

- `registerMemoryCapability(pluginId, { promptBuilder, flushPlanResolver, runtime, publicArtifacts })` at `src/plugins/memory-state.ts:170-175` registers a full memory capability. `buildMemoryPromptSection({ availableTools, citationsMode })` at `src/plugins/memory-state.ts:206-219` fans out to the capability's `promptBuilder` plus any `promptSupplements` (in sorted order).
- Context engines pull that into assembly via `buildMemorySystemPromptAddition({ availableTools, citationsMode })` in `src/context-engine/delegate.ts:88-101`, which returns a normalized `systemPromptAddition` string that is then prepended to the runtime system prompt by the attempt loop at `src/agents/pi-embedded-runner/run/attempt.ts:1538-1541`.

So memory does not live in the transcript — it injects (a) a system-prompt section describing available memory/wiki tools, (b) tool implementations, and optionally (c) its own `ContextEngine.assemble()` if the plugin provides one.

## 6. Per-session / per-agent isolation

- Each `(agentId, sessionId)` maps to a distinct file under `agents/<agentId>/sessions/<sessionId>.jsonl` (`src/agents/session-dirs.ts:6-9`, `src/config/sessions/paths.ts:263-278`). Cross-agent reads require going through `resolveSiblingAgentSessionsDir()` (`src/config/sessions/paths.ts:93-108`) which validates the `agents/<id>/sessions` shape.
- Writes serialize through `acquireSessionWriteLock(sessionFile, ...)` (`src/agents/pi-embedded-runner/run/attempt.ts:463`; impl at `src/agents/session-write-lock.ts`).
- The prompt-cache tracker is keyed per session: `buildTrackerKey({ sessionKey?, sessionId })` at `src/agents/pi-embedded-runner/prompt-cache-observability.ts:58-60`, and trackers are bounded to `MAX_TRACKERS = 512` with LRU eviction, so one session's cache state can't be observed by another.
- Subagent lifecycle is signalled through `ContextEngine.prepareSubagentSpawn({ parentSessionKey, childSessionKey, ttlMs })` and `onSubagentEnded({ childSessionKey, reason })` (`src/context-engine/types.ts:282-291`), letting engines clean up their own per-session state without core knowledge of subagent internals.

## 7. Token / size budgeting

Budgeting is **explicit** and layered, not purely post-hoc:

- Resolution order per turn: `resolveContextWindowInfo({ cfg, provider, modelId, modelContextTokens, modelContextWindow, defaultTokens })` at `src/agents/context-window-guard.ts:23-58` returns `{ tokens, source }` where `source ∈ {"modelsConfig" | "model" | "agentContextTokens" | "default"}`. An `agents.defaults.contextTokens` cap can narrow the real limit.
- `evaluateContextWindowGuard()` refuses to run under `CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000` and warns under `CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000` (`src/agents/context-window-guard.ts:5-6, 136-153`). `resolveEffectiveRuntimeModel` mutates the runtime model's `contextWindow` down to the capped value so Pi's internal auto-compaction sees the same effective limit (`src/agents/pi-embedded-runner/run/setup.ts:119-142`).
- Pre-prompt, `shouldPreemptivelyCompactBeforePrompt` computes `promptBudgetBeforeReserve = contextTokenBudget - effectiveReserveTokens` with a minimum prompt budget derived from `MIN_PROMPT_BUDGET_RATIO`/`MIN_PROMPT_BUDGET_TOKENS` (`src/agents/pi-embedded-runner/run/preemptive-compaction.ts:60-68`).
- A separate `pruneHistoryForContextShare({ messages, maxContextTokens, maxHistoryShare = 0.5 })` in `src/agents/compaction.ts:510-572` enforces that transcript history cannot exceed half the context budget; over-budget chunks are removed from the head and orphan tool_results are repaired on the way out.
- For DM/channel sessions, a coarser turn-count limit is applied by `limitHistoryTurns(messages, limit)` (`src/agents/pi-embedded-runner/history.ts:17-38`), keyed off provider config via `getHistoryLimitFromSessionKey()` (`src/agents/pi-embedded-runner/history.ts:45-118`).

## Open questions I could not answer from code alone

- Whether the `ContextEngine.assemble()` return value is supposed to be the sole source of truth or a "sugar" layer on top of the sanitize/limit pipeline — both are currently applied in sequence at `src/agents/pi-embedded-runner/run/attempt.ts:1465-1546` and I didn't confirm which wins on conflicts beyond the "pass-through" comment in `LegacyContextEngine.assemble()`.
- Exact semantics of `compactionTarget: "budget" | "threshold"` on the `ContextEngine` contract — the delegate explicitly ignores it ("built-in runtime compaction path does not expose that knob", `src/context-engine/delegate.ts:28-32`) and I didn't find a non-legacy engine that honors it.
- Whether `turnMaintenanceMode: "foreground" | "background"` (`src/context-engine/types.ts:58-60`) is wired all the way through — the contract exists but I didn't trace the dispatcher.
- Persistence format details (header + newline-delimited JSON) beyond what's visible in `manual-compaction-boundary.ts:17-21` — Pi owns the rest of `SessionManager`.
- Whether sanitize-step image pruning (`pruneProcessedHistoryImages` at `src/agents/pi-embedded-runner/run/attempt.ts:1981`) is meant to be idempotent across retries in the same turn or only across turns.
