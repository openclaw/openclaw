# QMD Timeout + Subagent Bootstrap Parity Design

Date: 2026-05-20
Status: draft for review
Scope: OpenClaw product/runtime behavior for QMD MCP retrieval and spawned worker/subagent bootstrap parity

## Goal

Fix two related runtime issues observed in the live Discord agent:

1. `qmd__query` times out often enough to add visible latency and noisy `"status": "error"` tool payloads even when the agent eventually answers correctly from fallback evidence.
2. Worker/subagent delegates do not reliably inherit the same retrieval/search guidance and bootstrap context as the main agent, especially when spawned under `agentId: "worker"`.

The target end state is:

- the main agent reaches for QMD first on memory/history questions without frequent timeout noise,
- worker/subagent delegates know the same retrieval policy and tool names as the main agent,
- full parity includes `MEMORY.md`, not just `AGENTS.md`/`TOOLS.md`,
- cross-agent worker spawns do not silently lose the main workspace retrieval policy.

## Findings

### 1. The QMD timeout is on the MCP server path, not the built-in memory backend

- Live Discord prompt 1 called `qmd__query` and `qdrant__qdrant-find` in parallel.
- `qmd__query` timed out with `MCP error -32001: Request timed out`.
- The gateway config currently has `memory.backend = "builtin"`, so this was **not** the `extensions/memory-core` QMD search-manager path.
- The QMD tool is coming from a separate MCP server registration:
  - `mcp.servers.qmd.command = /home/node/.openclaw/vendor/npm-global/bin/qmd`
  - `mcp.servers.qmd.args = ["mcp"]`
- OpenClaw bundle-MCP runtime does not impose a per-tool call timeout here; it only times out connection setup.
- Therefore the timeout source is inside `qmd mcp` itself or its search path, not OpenClaw’s bundle-MCP client wrapper.

### 2. QMD MCP defaults are heavier than the retrieval policy assumes

- The installed QMD MCP server exposes `query` with:
  - multiple typed sub-searches,
  - `rerank: true` by default,
  - semantic/hyde support,
  - optional LLM-assisted disambiguation.
- That is stronger than a plain lexical BM25 search and can be much slower on CPU-only or cold paths.
- Our retrieval policy currently treats `qmd__query` as the cheap first lexical lookup, but the QMD MCP server’s own default path is not cheap enough to justify that assumption.

### 3. The worker failure was primarily a workspace mismatch

- The failed delegation used `sessions_spawn` with `agentId: "worker"`.
- Cross-agent spawns intentionally do **not** inherit the requester workspace. `src/agents/subagent-spawn.ts` passes `undefined` for cross-agent `explicitWorkspaceDir`, and `src/agents/spawned-context.ts` then resolves the target agent workspace.
- In the live system, the `worker` agent therefore ran in its own workspace, not the `main` workspace.
- The worker transcript showed exactly that:
  - generic template `TOOLS.md`
  - no `retrieval/AGENTS.md`
  - no `MEMORY.md`
- So the worker could not verify the code-search tool from the requested sources even though the main agent could.

### 4. Same-agent subagents already inherit more than the docs claim, but not full parity

- Runtime filtering for subagent/cron bootstrap context currently keeps:
  - `AGENTS.md`
  - `TOOLS.md`
  - `SOUL.md`
  - `IDENTITY.md`
  - `USER.md`
- It excludes:
  - `MEMORY.md`
  - `HEARTBEAT.md`
  - `BOOTSTRAP.md`
- The bundled `bootstrap-extra-files` hook appends extra files and then re-applies that same filter.
- Because the filter keys on basename, hook-injected files like `retrieval/AGENTS.md` can survive for same-workspace subagents.
- But `MEMORY.md` still never survives, so parity with the main agent is incomplete even in the same workspace.

## Decision

Implement **full parity** for retrieval/bootstrap context across the main agent, same-agent subagents, and cross-agent worker delegates.

This design intentionally changes current boundaries:

- `MEMORY.md` will become available to subagent/worker runs that inherit the main workspace.
- Cross-agent worker spawns will inherit the requester workspace by default unless the caller or target agent explicitly requests a different workspace boundary.

That is a real behavior change, not just a docs fix. We are doing it deliberately because the user wants full parity, not the current privacy/token-minimized split.

## Approach

### Approach A — Config-only patch

- Repoint the `worker` agent to the main workspace in live config.
- Rewrite retrieval docs to prefer cheaper QMD calls.

Pros:
- Fastest to deploy.

Cons:
- Leaves product semantics inconsistent.
- Same bug returns on any other cross-agent worker or future workspace split.
- Does not give durable full parity.

Rejected.

### Approach B — Product-level parity + QMD first-pass hardening

- Change spawned-workspace inheritance for cross-agent delegates so they inherit the requester workspace by default.
- Expand subagent bootstrap filtering to include `MEMORY.md`.
- Keep `retrieval/AGENTS.md` hook-injected policy visible in spawned runs that share the workspace.
- Add a first-pass QMD retrieval lane that is cheaper and less timeout-prone for ordinary memory questions.

Pros:
- Fixes the actual runtime behavior that produced the audit failures.
- Durable across future worker spawns.
- Aligns live agent behavior with the intended bootstrap/search policy.

Cons:
- Changes current isolation semantics.
- Requires tests across spawn + bootstrap + retrieval behavior.

Recommended.

### Approach C — Full main-session prompt cloning

- Make subagents get the exact same bootstrap prompt composition as the main agent.

Pros:
- Maximum parity.

Cons:
- Overbroad.
- Needlessly pulls in `HEARTBEAT.md` and bootstrap-pending behavior.
- Increases token cost and risk of instruction noise.

Rejected.

## Design

### Component 1 — Cheaper QMD first-pass behavior

The goal is not “make QMD infinitely fast.” The goal is to prevent routine memory/history lookups from immediately taking the expensive query path.

Changes:

1. Update retrieval policy docs so ordinary memory/history lookups ask for a cheap first pass:
   - one lexical search only,
   - no semantic/hyde expansion,
   - no rerank on the first pass.
2. Add explicit guidance that the agent should escalate to richer QMD query shapes only if the cheap first pass is thin.
3. Add a bounded fallback order:
   - QMD cheap lexical first pass
   - Qdrant semantic fallback
   - richer QMD shape only when needed for follow-up retrieval

Important constraint:
- This should be done at the OpenClaw agent-policy/tool-usage layer unless the installed QMD MCP server already exposes a cheaper call shape we can safely target.
- We should not patch vendored `@tobilu/qmd` code in place.

Expected effect:
- fewer QMD timeouts on ordinary questions,
- lower latency,
- less verbose error churn before the final answer.

### Component 2 — Full bootstrap parity for spawned runs

Update subagent bootstrap filtering so parity includes `MEMORY.md`.

Current filter in `src/agents/workspace.ts`:
- allows `AGENTS.md`, `TOOLS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`
- excludes `MEMORY.md`

Change:
- include `MEMORY.md` in the subagent bootstrap allowlist
- continue excluding `HEARTBEAT.md` and `BOOTSTRAP.md`

Reasoning:
- `HEARTBEAT.md` is operational noise for workers.
- `BOOTSTRAP.md` is first-run workflow state, not durable policy.
- `MEMORY.md` is specifically requested as part of full parity.

Expected effect:
- same-workspace subagents can answer “what tool should I use” and similar retrieval-policy questions from the same durable memory/bootstrap context as main.

### Component 3 — Cross-agent worker workspace inheritance

Current behavior:
- cross-agent spawns deliberately drop requester workspace inheritance and resolve the target agent’s own workspace instead.

Change:
- default cross-agent spawned runs to the requester workspace when no explicit workspace override is supplied.
- preserve an escape hatch for agents that intentionally want separate workspaces.

Implementation shape:
- adjust `resolveSpawnedWorkspaceInheritance(...)` / spawn call-site behavior so `sessions_spawn agentId=worker` inherits the requester workspace by default.
- if a target agent explicitly defines a separate workspace contract later, that can be a future opt-out, but this change should fix the default behavior now.

Expected effect:
- `agentId: "worker"` delegates see the same workspace bootstrap files and hook-injected retrieval files as the main agent.
- the exact failure observed in the audit no longer reproduces.

### Component 4 — Retrieval hook parity proof

The bundled `bootstrap-extra-files` hook already appends extra bootstrap files and then re-filters them for subagents.

We should keep that mechanism, but test the intended live outcome explicitly:

- main session sees `retrieval/AGENTS.md`
- same-workspace subagent sees `retrieval/AGENTS.md`
- cross-agent `worker` delegate, after workspace-inheritance fix, also sees `retrieval/AGENTS.md`
- all three can report the same code-search tool name from the same source files

No new hook mechanism is needed if workspace inheritance is corrected.

## Testing

Follow TDD. No production changes before failing tests.

### Test group 1 — bootstrap parity

Add or update tests around `filterBootstrapFilesForSession(...)`:

- failing test: subagent sessions now include `MEMORY.md`
- passing expectation: `HEARTBEAT.md` and `BOOTSTRAP.md` remain excluded

### Test group 2 — cross-agent workspace inheritance

Add failing tests around spawned workspace resolution:

- same-agent spawn keeps requester workspace
- cross-agent spawn with `agentId: "worker"` also keeps requester workspace by default
- explicit override still wins when provided

### Test group 3 — retrieval policy behavior

Add or update tests proving the retrieval policy text/instructions point the agent at a cheaper QMD first pass and preserve the fallback order.

If there is a structured policy snapshot or system-prompt/bootstrap coverage seam, use that instead of brittle string-grep tests.

### Test group 4 — live proof

After code changes:

1. targeted local tests for the changed files
2. Testbox targeted proof for the broader changed lanes if needed
3. live Discord prompts:
   - main session: `What did we decide about the Blacksmith CI workflows?`
   - delegated worker: `Delegate a quick lookup to a worker: have it tell me what tool to use for code search.`

Success criteria:
- Prompt 1 no longer spends most of its time in a timing-out QMD first pass
- Prompt 2 worker answer comes from the worker’s own retrieved context rather than the parent apologizing for missing bootstrap files

## Risks

### Privacy / scope risk

Including `MEMORY.md` in subagents expands the amount of durable personal context child runs can see. This is accepted here because full parity was explicitly requested.

### Token cost risk

Adding `MEMORY.md` to subagent bootstrap raises child prompt size. We should keep an eye on bootstrap budget/truncation diagnostics and avoid dragging in `HEARTBEAT.md` / `BOOTSTRAP.md`.

### Behavioral risk

Cross-agent worker workspace inheritance changes existing semantics. Some users may rely on worker isolation today. For this task we accept that trade-off; if needed later, we can add an explicit opt-out boundary instead of preserving the current surprising default.

## Files expected to change

- `src/agents/workspace.ts`
- tests around `src/agents/workspace.ts`
- `src/agents/spawned-context.ts` and/or `src/agents/subagent-spawn.ts`
- tests around spawned workspace inheritance
- retrieval/bootstrap policy docs or prompt-building fixtures as needed for the QMD first-pass behavior

## Out of scope

- Rewriting or vendoring the upstream `@tobilu/qmd` MCP package
- Rebuilding Docker images
- Broad memory-backend architecture changes (`memory.backend = builtin` stays as-is)
