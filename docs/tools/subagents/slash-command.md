---
summary: "Inspect sub-agent runs with /subagents, use the thread-binding commands, and follow the completion-delivery path"
title: "Sub-agent slash command"
read_when:
  - You want to inspect or log a sub-agent run from chat
  - You need the thread-binding slash commands
  - You are debugging how a completed child reaches the requester
---

## Slash command

`/subagents` inspects sub-agent runs for the **current session**:

```text
/subagents list
/subagents log <id|#> [limit] [tools]
/subagents info <id|#>
```

`/subagents info` shows run metadata (status, timestamps, session id,
transcript path, cleanup). `/subagents log` prints recent chat turns for a
run; add the `tools` token to include tool-call/result messages (omitted
by default). Use `sessions_history` for a bounded, safety-filtered recall
view from within an agent turn, or inspect the transcript path on disk for
the raw full transcript.

In the Control UI, parent sessions with recent child runs have an expandable
sidebar row. The nested rows show child status and runtime, and selecting one
opens that child's chat while preserving the parent hierarchy. Failed or timed-out
children retain a bounded failure reason, including failures during worktree
preparation before any model reply. The child's transcript includes a durable
failure notice when no assistant reply was recorded for that run. A later
successful run clears the previous failure reason.

### Thread binding controls

These commands work on channels with persistent thread bindings. See
[Thread supporting channels](/tools/subagents/thread-bound-sessions#thread-supporting-channels).

```text
/session unbind
/agents
/session idle <duration|off>
/session max-age <duration|off>
```

### Spawn behavior

Agents start background sub-agents with the `sessions_spawn` tool. Follow the
completion path described in the accepted receipt:

- Ordinary announcing runs return an internal completion event to the requester,
  which reviews the result and decides whether a user-facing update is needed.
- [Swarm collectors](/tools/swarm) return results through explicit collection,
  not completion notifications; reserve them for large parallel fan-out (several
  similar children, about five or more), and use ordinary spawns for one or a few.
- Thread-bound session runs with a deliverable bound route reply directly to that
  thread, without a separate parent announcement.
- Caller-managed quiet runs send no completion notification.

When [execution identity auditing](/gateway/audit#run-identity-inspection) is
enabled, each native or ACP child receives a new immutable identity context.
Its lineage links the exact parent context/run when available and records
bounded references for the parent grant, local policy, runtime assurance, and
target policy that constrained the spawn. Neither the private identity token
nor task text appears in the tool schema, result, transcript-derived evidence,
or public plugin API. External ACP-native actions without a callback remain
explicitly unsupported even though the ACP spawn and child are observable.

<AccordionGroup>
  <Accordion title="Non-blocking, push-based completion">
    - `sessions_spawn` returns a run id after startup is accepted, without waiting for the child task to finish. Spawns from an OpenClaw cloud worker can first wait for child provisioning and node enrollment.
    - Announcing sub-agents report back to the parent/requester session on completion.
    - Agent turns that need those announced results should call `sessions_yield` when available. That ends the current turn and lets the completion event arrive as the next model-visible message. Collectors instead require explicit result collection.
    - Announced completion is push-based. Once spawned, do **not** poll `/subagents list`, `sessions_list`, or `sessions_history` in a loop just to wait for it to finish; check status on-demand only when debugging.
    - Child output is a report/evidence for the requester agent to synthesize. It is not user-authored instruction text and cannot override system, developer, or user policy.
    - A child run ending does not by itself complete the requester's user-facing goal. The requester compares the result with the requested outcome and continues in-scope work, including review findings and failed checks, before replying. Persistent child sessions can be continued with `sessions_send`.
    - Report the overall goal as blocked only when continuation requires new user authority or an unavailable external decision. Ordinary fixable findings are continuation work, not a terminal blocker.
    - On completion, OpenClaw best-effort closes tracked browser tabs/processes opened by that sub-agent session before the announce cleanup flow continues.

  </Accordion>
  <Accordion title="Completion delivery">
    - OpenClaw hands completions back to the requester session through an `agent` turn with a stable idempotency key.
    - If the requester run is still active, OpenClaw first tries to wake/steer that run instead of starting a second visible reply path.
    - If an active requester cannot accept steering, including a busy CLI run, the handoff waits in the same session lane and starts after the current turn releases its claim. A failed wake does not start a competing turn or discard the completion.
    - A successful in-session parent handoff completes sub-agent delivery even when the parent decides no visible user update is needed. External completion delivery requires a confirmed send, not merely an answer saved in the requester transcript.
    - Native sub-agents do not get the message tool. They return plain assistant text to the parent/requester agent; human-visible replies stay owned by the parent/requester agent's normal delivery policy.
    - Queue acceptance is not delivery. If direct handoff cannot be used, delivery falls back to queue routing; the completion remains `session_queued`, rather than delivered, until the durable queue settles.
    - Automatic completion delivery retries for up to 30 minutes, starting around 15 seconds and capping the backoff at 5 minutes. Permanent failure or deadline expiry leaves the successful child task visibly blocked instead of discarding its result.
    - Missing or empty external delivery receipts remain unconfirmed and follow that bounded retry policy. An adapter-reported unconfirmed send remains ambiguous, never intentional suppression. Empty requester output still uses the existing completion fallback; it is not an outbound-hook cancellation. A confirmed message-tool send to the requester still counts as delivery.
    - If an outbound hook intentionally suppresses a completion, the child can remain completed while its task delivery is marked `failed` with the suppression reason. OpenClaw does not retry or start another requester turn to bypass that decision. Inspect the task error and hook policy before manually retrying.
    - Blocked canonical results are retained for 7 days. Operators can retry or intentionally dismiss them from the Tasks page or with `openclaw tasks retry` / `openclaw tasks dismiss`; retry can duplicate a visible result after an ambiguous provider acknowledgement.
    - Delivery keeps the resolved requester route: thread-bound or conversation-bound completion routes win when available. If the completion origin only provides a channel, OpenClaw fills the missing target/account from the requester session's recorded delivery context so direct delivery still works.

  </Accordion>
  <Accordion title="Completion handoff metadata">
    The completion handoff to the requester session is runtime-generated
    internal context (not user-authored text) and includes:

    - `Result` — the latest visible `assistant` reply text from the child. Tool/toolResult output is not promoted into child results. Terminal failed runs do not reuse captured reply text.
    - `Model route change` — when the terminal producer proves that fallback changed the requested model, one bounded and redacted route fact is carried separately from `Result`. Local and nested parents preserve it in their update. External channel parents keep it as private orchestration context, and raw direct-delivery fallback sends only `Result`.
    - `Status` — `completed; ready for parent review` / `failed` / `timed out` / `unknown`.
    - Compact runtime/token stats.
    - A review instruction telling the requester agent to verify the result before deciding whether the original task is done.
    - Follow-up guidance telling the requester agent to continue the task or record a follow-up when the child result leaves more action.
    - A final-update instruction for the no-more-action path, written in normal assistant voice without forwarding raw internal metadata.

  </Accordion>
  <Accordion title="Modes and ACP runtime">
    - `--model` and `--thinking` override defaults for that specific run.
    - Use `info`/`log` to inspect details and output after completion.
    - For persistent thread-bound sessions, use `sessions_spawn` with `thread: true` and `mode: "session"`.
    - If the requester channel does not support thread bindings, use `mode: "run"` instead of retrying an impossible thread-bound combination.
    - For ACP harness sessions (Claude Code, Gemini CLI, OpenCode, or explicit Codex ACP/acpx), use `sessions_spawn` with `runtime: "acp"` when the tool advertises that runtime. See [ACP delivery model](/tools/acp-agents#delivery-model) when debugging completions or agent-to-agent loops. When the `codex` plugin is enabled, Codex chat/thread control should prefer `/codex ...` over ACP unless the user explicitly asks for ACP/acpx.
    - OpenClaw hides `runtime: "acp"` until ACP is enabled, the requester is not sandboxed, and a backend plugin such as `acpx` is loaded. `runtime: "acp"` expects an external ACP harness id, or an `agents.entries.*` entry with `runtime.type="acp"`; use the default sub-agent runtime for normal OpenClaw config agents from `agents_list`.

  </Accordion>
</AccordionGroup>
