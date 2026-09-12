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

Delivery depends on requester depth:

- Top-level requester sessions use a follow-up `agent` call with external delivery (`deliver=true`).
- Nested requester subagent sessions receive an internal follow-up injection (`deliver=false`) so the orchestrator can synthesize child results in-session.
- If a nested requester subagent session is gone, OpenClaw falls back to that session's requester when available.

For top-level requester sessions, completion-mode direct delivery first
resolves any bound conversation/thread route and hook override, then fills
missing channel-target fields from the requester session's stored route.
That keeps completions on the right chat/topic even when the completion
origin only identifies the channel.

Child completion aggregation is scoped to the current requester run when
building nested completion findings, preventing stale prior-run child
outputs from leaking into the current announce. Announce replies preserve
thread/topic routing when available on channel adapters.

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

Terminal failed runs report failure status without replaying captured
reply text. Tool/toolResult output is not promoted into child result text.

### Stats line

Announce payloads include a stats line at the end (even when wrapped):

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
