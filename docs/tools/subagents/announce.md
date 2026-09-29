---
summary: "How a sub-agent reports its result back, the announce context block, and why sessions_history is preferred"
title: "Sub-agent announce"
read_when:
  - You are debugging a missing or duplicated completion
  - You need the fields in the announce context block
  - You are reading a child transcript from inside an agent turn
---

## Announce

Sub-agents report back via an announce step:

- The announce step runs inside the sub-agent session (not the requester session).
- Runs spawned with `expectsCompletionMessage: false` skip the announce step entirely; the run registry records their delivery as not required.
- An exact `ANNOUNCE_SKIP` response suppresses announce output.
- For completion-required runs, an exact child `NO_REPLY` response or no output is a missing deliverable handed to the requester/parent for visible representation or retry; it is not credited as silent delivery.
- Optional, duplicate, already-visible, or otherwise non-required paths may use exact `NO_REPLY` for intentional silence.

By default, delivery depends on requester depth:

- Top-level requester sessions use a follow-up `agent` call with external delivery (`deliver=true`).
- Nested requester subagent sessions receive an internal follow-up injection (`deliver=false`) so the orchestrator can synthesize child results in-session.
- If a nested requester subagent session is gone, OpenClaw falls back to that session's requester when available.

For top-level requester sessions, completion-mode direct delivery first
resolves any bound conversation/thread route and hook override, then fills
missing channel-target fields from the requester session's stored route.
That keeps completions on the right chat/topic even when the completion
origin only identifies the channel. When an override selects a different
chat or topic, it does not inherit the previous route's thread. An explicit
thread from the binding or hook is preserved.

Child completion aggregation is scoped to the current requester run when
building nested completion findings, preventing stale prior-run child
outputs from leaking into the current announce. Announce replies preserve
thread/topic routing when available on channel adapters.

After `sessions_yield`, the frozen batch waits for its own children and their
descendants to settle. A still-running child from an earlier requester turn does
not delay that batch's result; the earlier batch retains its own completion wake.

Completion inputs retain their own turn identity across compaction and runtime
context messages. If transcript persistence rejects a completion because its
keyed input belongs to a closed turn, delivery records a permanent failure with
the error. It does not retry other models or keep scheduling the same completion.

If a chunk in a direct-message text fallback fails or is aborted after earlier
chunks were sent, OpenClaw records an incomplete delivery. It stops automatic
retries to avoid duplicating chunks the recipient already received. A successful
child's result remains available for recovery.

### Private parent completion

Set `completionTarget: "parent"` on `sessions_spawn` to return the result in a
private turn of the original requester session. The parent can inspect the result,
start another child, or reply `NO_REPLY`. OpenClaw does not automatically send the
child result, parent final, or generated media to a channel. The parent can still
choose to send a message through its permitted tools.

This option supports hidden, native, one-shot runs only. It cannot be combined
with ACP, `collect: true`, `visible: true`, `thread: true`, `mode: "session"`, or
`expectsCompletionMessage: false`. It does not change the default completion mode.

Finished private results remain in the registry until the spawning parent turn
settles. A normal parent finish releases each ready result for private review;
`sessions_yield` hands the results to its existing child batch instead. A reset or
removed parent does not transfer the result to another session. When a settled
batch contains a private result, its combined review stays private; ordinary
siblings retain their individual completion delivery.

Waiting for the spawning parent turn does not consume a private result's delivery
retry window. A normal parent finish starts that window when it releases the
result. After `sessions_yield`, the yielded batch owns delivery; individual child
cleanup cannot expire or suspend that batch's result.

Use a build that supports this option throughout the run. Older builds cannot
resume private completion handoffs and may discard them after a downgrade;
existing session transcripts remain separate.

### Announce context

Announce context is normalized to a stable internal event block:

| Field          | Source                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Source         | `subagent` or `cron`                                                                                     |
| Session ids    | Child session key/id                                                                                     |
| Type           | Announce type + task label                                                                               |
| Status         | Derived from runtime outcome (`ok`, `error`, `timeout`, or `unknown`) — **not** inferred from model text |
| Result content | Latest visible assistant text from the child                                                             |
| Follow-up      | Instruction describing when to reply vs stay silent                                                      |

The result is the child's complete visible final answer for the completed run.
OpenClaw preserves prompt-data escaping and stable order when it delivers several
results together. It does not shorten an answer to fit the former announce
projection limits. The bounded lifecycle snapshot remains separate from the
complete answer sent to the parent.

For nested work, descendant findings help the child form its answer. The child's
own final answer is what travels onward to its parent. If the child sends its
final answer through the message tool and then returns `NO_REPLY`, that final
answer remains authoritative.

Completion delivery can read an existing registered archive when child cleanup
finishes before the parent resumes. The Control UI's **Tasks** inspector also
reads the completed run's retained transcript after cleanup removes its live
session. Paging stays bound to that run's archive, even if the session key is reused.
After deletion, child-specific sharing metadata is no longer available. Archived
previews therefore require existing session access that does not depend on that
metadata, such as Gateway administrator access. Profile-scoped readers cannot
recover a deleted child's entitlement from access to its parent task. Keeping the
child session preserves its normal sharing checks.
Oversized text records use the normal history size notice. A single archived
record above 8 MiB makes Tasks history unavailable before the reader decodes it,
to bound per-record decoding memory. This limit also applies to other retained
generations with the same session key: run membership is stored inside transcript
records, so an unreadable candidate prevents the reader from establishing a unique
match, even when the requested run's own archive is small. The reader reports
unavailable rather than skipping an unclassified generation. This read limit does
not change retained archives or completion delivery's final-answer scanner.
Tasks reports this as a non-retryable preview limit; refreshing cannot resolve it.

Terminal failed runs report failure status without replaying captured
reply text. Tool/toolResult output is not promoted into child result text.

### Stats line

Default announce payloads include a stats line at the end (even when wrapped).
Private parent completions omit mutable usage statistics so a retried handoff
keeps the same input:

- Runtime (e.g. `runtime 5m12s`).
- Token usage (input/output/total).
- Estimated cost when model pricing is configured (`models.providers.*.models[].cost`).
- `sessionKey`, `sessionId`, and transcript path so the main agent can fetch history via `sessions_history` or inspect the file on disk.

Internal metadata is meant for orchestration only; user-facing replies
should be rewritten in normal assistant voice.

### Why prefer `sessions_history`

`sessions_history` is the safer orchestration path for reading a child's
transcript from within an agent turn:

- Redacts credential/token-like text even when general-purpose log redaction is disabled.
- Truncates long text blocks (4000 chars per block) and drops thinking signatures, reasoning replay payloads, and inline image data.
- Caps returned messages at 80 KB; older rows can be dropped or an oversized row replaced with `[sessions_history omitted: message too large]`.
- Use `nextOffset` when present to page backward through older transcript windows.
- Returns structured history rather than `/subagents log`'s plain chat lines. Reasoning tags, `<relevant-memories>` / `<relevant_memories>` scaffolding, and tool-call XML can remain in message text: `sessions_history` does not apply the log command's assistant prose sanitizer. See [Session tools](/concepts/session-tool#listing-and-reading-sessions) for the recall guarantees.
- Raw on-disk transcript inspection is the fallback when you need the full byte-for-byte transcript.
