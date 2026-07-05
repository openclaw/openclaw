# Aerith OpenClaw Runtime Resilience

## Status

This dossier covers the Aerith/OpenClaw runtime incident class observed on
2026-07-05: native hook relay loss, stuck sessions, blocked tool calls, and
oversized memory bootstrap payloads.

The phoning.ai voice pipeline is out of scope. Do not edit, rollback, simplify,
or redeploy it while this infrastructure work is active.

## Root Cause

The native hook relay is an in-process bridge owned by the OpenClaw Gateway
process that is running the active Codex turn.

The sequence is:

1. Telegram receives a message.
2. OpenClaw Gateway routes it to the main Aerith session.
3. The Codex app-server thread is started or resumed.
4. OpenClaw registers a native hook relay in Gateway memory.
5. OpenClaw writes a short-lived relay record under
   `/tmp/openclaw-native-hook-relays-<uid>/`.
6. Codex receives hook commands in thread config.
7. Before native tools such as shell/git/apply_patch, Codex launches
   `openclaw hooks relay ...`.
8. The hook CLI posts to the localhost relay record, or falls back to
   `nativeHook.invoke` through Gateway RPC.
9. Gateway runs OpenClaw policy hooks and returns allow/deny/noop.

The failure appears when the Gateway process is restarted or its relay state is
lost while a Codex turn or resumed thread still contains hook commands pointing
to the previous relay id.

The observed hard failure path is:

1. Codex invokes the old native hook command.
2. The direct bridge record is missing, expired, points to a dead pid, or points
   to a port that no longer answers.
3. The hook CLI falls back to Gateway RPC.
4. The restarted Gateway has no in-memory registration for that relay id.
5. Gateway returns `native hook relay not found`.
6. The CLI renders `Native hook relay unavailable`.
7. For `PreToolUse`, the hook fails closed unless the command recorded a safe
   unavailable mode.
8. Codex reports `blocked_tool_call` or refuses shell/git/apply_patch before the
   tool runs.

This is not a phoning.ai defect. It is a lifecycle mismatch between durable
Codex thread hook config and non-durable Gateway relay state.

## Related Failure Modes

`native hook relay not found`

: Gateway RPC reached a live Gateway, but that process did not have the relay id
registered in memory.

`Native hook relay unavailable`

: The CLI could not use either the direct bridge or Gateway fallback. For
PreToolUse this can block the tool call.

`thread not found`

: The Codex app-server binding references a thread id that the current Codex
app-server process cannot resume. This can happen after app-server restart,
thread eviction, auth/profile rotation, or binding drift. Recovery should start a
fresh thread and rewrite the binding.

`blocked_tool_call`

: Diagnostic classification for a session where a model/tool handoff is blocked
by a tool authorization or hook result and the active run cannot complete.

`queued_work_without_active_run`

: Session queue contains work, but no active embedded run owns it. This usually
means a previous run ended without draining or releasing the session lane.

`stuck session`

: A session is old enough, queued enough, or internally inconsistent enough that
OpenClaw diagnostics classify it as stale. Recovery may release the lane or abort
a genuinely stale embedded run.

`release_lane`

: Recovery action used when no live embedded run should still own the lane. It
frees queued work so a new run can start.

## Code Change

The relay now distinguishes two safe PreToolUse unavailable modes:

- `noop`: no before-tool policy and no loop detector work existed.
- `loop-detection-only`: no before-tool policy existed; only loop detection was
  expected.

If the relay disappears in `loop-detection-only` mode, the CLI returns a no-op
instead of permanently blocking native shell/git/apply_patch. If an actual
`before_tool_call` policy exists, the behavior stays fail-closed.

This preserves the authority boundary while preventing a lost in-memory relay
from freezing ordinary tool execution.

## Diagnostic Command

Run:

```bash
cd /home/node/.openclaw/workspace/openclaw-src
node scripts/aerith-runtime-resilience.mjs
```

JSON mode:

```bash
node scripts/aerith-runtime-resilience.mjs --json
```

The diagnostic reports:

- native hook relay records;
- stale relay records;
- pid and localhost port reachability;
- Codex binding generation presence;
- installed Codex runtime generation persistence;
- `MEMORY.md` bootstrap size risk.

## Termius Operator Runbook

Use this runbook when Telegram says tools are blocked by the native hook relay.

Diagnostic:

```bash
cd /home/node/.openclaw/workspace/openclaw-src
pwd
git status --short
node scripts/aerith-runtime-resilience.mjs
ls -la /tmp/openclaw-native-hook-relays-$(id -u) 2>/dev/null || true
```

Backup before recovery:

```bash
mkdir -p /home/node/.openclaw/agents/main/sessions-backup-$(date -u +%Y%m%dT%H%M%SZ)
cp -a /home/node/.openclaw/agents/main/sessions/*.jsonl* /home/node/.openclaw/agents/main/sessions-backup-$(date -u +%Y%m%dT%H%M%SZ)/ 2>/dev/null || true
```

Recovery:

```bash
# Restart only the OpenClaw Gateway process by the deployment method currently
# used on the host. Do not touch phoning.ai services.
```

Validation:

```bash
cd /home/node/.openclaw/workspace
pwd
git status --short
```

If both commands return through Telegram/Codex, the native relay path is back.

Resume:

```text
Tell Aerith: NATIVE_RELAY_RESTORED
```

## Memory Architecture Recommendation

`MEMORY.md` is currently too large for fast, stable bootstrap. The durable memory
should be split into:

- `MEMORY.active.md`: compact current operating memory loaded at bootstrap.
- `memory/archive/YYYY-MM.md`: historical detailed records not loaded by default.
- `memory/index.jsonl`: machine-readable index with ids, dates, projects, and
  source files.
- `memory/ontology/graph.jsonl`: durable relation graph for retrieval/path
  reasoning.
- daily files: append-only raw session logs.

Bootstrap should load only active memory plus a small retrieval index. Historical
details should be pulled on demand.

## Success Gate

`AERITH_RUNTIME_RESILIENCE_OK=1` requires:

- native hook relay survives normal long turns or degrades safely when only loop
  detection is unavailable;
- Gateway restart no longer creates permanent tool blockage;
- session recovery can release stale lanes;
- Codex bindings preserve relay generation for resumed threads;
- memory bootstrap is split below high-risk size;
- operator documentation exists;
- tests pass;
- phoning.ai pipeline files remain unchanged;
- no secrets are printed.
