---
summary: "Native Codex compaction, the OpenClaw transcript mirror, and continuity projection"
read_when:
  - You are tuning host mirror compaction against native compaction
  - You need to know what the transcript mirror records
title: "Codex compaction and transcript mirror"
sidebarTitle: "Compaction and mirror"
---

Who owns compaction on a Codex turn, and what the OpenClaw transcript mirror keeps. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Compaction and transcript mirror

When the selected model uses the Codex harness, Codex app-server owns native
token-pressure and manual thread compaction. OpenClaw separately owns its
transcript mirror. Effective Ultrafast turns cap native automatic compaction at
260,000 total context tokens, preserving lower configured
`model_auto_compact_token_limit` values. OpenClaw applies this limit through the
native thread configuration before the turn; changing back to Fast or standard
restores the configured native limit on the next turn. Other tiers retain their
native compaction settings.

Native token-based compaction does not enforce the inference relay's request-byte
limit. Inline images can exceed that limit before token pressure triggers, and
the compaction request itself can be too large. See
[image-heavy conversation troubleshooting](/plugins/codex-harness/troubleshooting#image-heavy-conversations-exceed-the-request-size-limit).

An incognito thread has no persisted resume source, so its creation-time
compaction settings cannot change in place. If a speed change requires a different
limit, OpenClaw preserves the conversation and asks you to restore the previous
speed or start a new incognito conversation. No turn is sent with mismatched settings.

`agents.defaults.compaction.maxActiveTranscriptBytes` bounds older history when
seeding a **fresh** native thread, not during ordinary or heartbeat turns.
Before omitting history not covered by a summary, OpenClaw attempts one host
compaction using the seed's retained-history allowance and reserves a fitting summary.
Whole turns and tool/result pairs stay intact; required instructions and the
active request or runtime-refresh exchange are outside the historical cap.
With compaction disabled, older history is still omitted with a notice;
no-cap defaults and the full saved transcript are unchanged.
The notice appears in the seed and user-facing events. Native rollout/token
fuses and owning-engine compaction with native follow-up remain unchanged.

Explicit compaction requests, such as `/compact` or a plugin-requested manual
compact operation, start native Codex compaction with `thread/compact/start`.
OpenClaw keeps the request and shared-client lease open until Codex emits the
matching `contextCompaction` completion item and then reports the compaction
turn as completed. If that terminal turn exceeds the configured compaction
timeout, OpenClaw requests a native turn interrupt. The lease and per-thread
compaction fence remain held until Codex reports terminal state or confirms
the interrupt RPC. If Codex does not confirm within the interrupt grace
period, OpenClaw retires the connection before releasing the fence. Remote
connections also detach the matching thread binding so later work cannot
overlap an unconfirmed remote turn. Other turns on a retired connection fail
and can retry on a fresh client. Client closure, request cancellation, or a
failed compaction turn returns a failed operation.

A standalone cold compact operation does not run prompt-build hooks or establish
ordinary-turn configuration. It releases its subscription after the operation;
the next ordinary turn verifies configuration and refreshes generic policy through
the normal resume path. Warm compaction returns only the configuration ownership
it actually acquired.

If context-engine compaction rotates the OpenClaw session generation, the next
Codex turn, compaction, or side question continues the same native thread even if the Gateway stopped
immediately after committing the new generation. Only the recorded predecessor
under that session key can be adopted. Native tool catalogs, connection ownership,
and supervision checks still apply before the resumed thread executes.

A successful local rewind or branch switch is a context change. It invalidates
the old native binding as part of the transcript mutation and releases its
subscription before returning. The next Codex turn starts a fresh native thread
with the selected OpenClaw history; erased turns cannot return through a native
resume. Invalid cuts and rolled-back transcript mutations preserve the binding.

When OpenClaw projects an existing session's continuity into a fresh Codex
thread, it includes saved compaction and branch summaries, even when no
earlier user messages remain. Context-engine projections preserve those
summary entries too. Summaries stay quoted as prior context, separate from
the current request, and remain subject to the projection's size limits;
oversized summaries or older whole turns can be omitted. This handoff does not
change native Codex compaction ownership.

When a context engine requests Codex thread-bootstrap projection, OpenClaw
projects tool-call names and ids, input shapes, and tool-result content
without secret masking into the fresh Codex thread. It does not copy raw tool-call argument
values into that projection.

The mirror includes the user prompt, final assistant text, and lightweight
Codex reasoning records when the app-server emits them. Reasoning retains
typed `thinking` content rather than ordinary final-answer text, so OpenClaw's
existing reasoning visibility and history controls apply. OpenClaw records
the native compaction start and terminal status, but it does not
expose a human-readable compaction summary or an auditable list of which
entries Codex kept after compaction.

Repeated completion notifications for the same compaction item count once and
do not repeat completion hooks or active-plan restoration.

Because Codex owns the native thread, `tool_result_persist` does
not rewrite Codex-native tool result records. It only applies when OpenClaw
writes an OpenClaw-owned session transcript tool result.
