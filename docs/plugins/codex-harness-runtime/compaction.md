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
transcript mirror. When `agents.defaults.compaction.maxActiveTranscriptBytes`
is set to a positive value, OpenClaw checks that mirror before ordinary and
heartbeat turns. When the byte guard trips, OpenClaw requires semantic
compaction through its selected host context engine before admitting the turn.
This host compaction does not itself replace or rewrite Codex's canonical
native thread.

After host mirror compaction commits, OpenClaw may request
`thread/compact/start` to synchronize an eligible native thread. This request
is secondary: OpenClaw does not send it for host-isolated operations or
bindings with restricted native authority, and unavailable or failed native
synchronization does not roll back committed host compaction.

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
failed compaction turn returns a failed operation. Automatic native
token-pressure compaction remains Codex's job. Outside the secondary
synchronization described above, OpenClaw starts native compaction only for
explicit manual requests.

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

When OpenClaw projects an existing session's continuity into a fresh Codex
thread, it includes saved compaction and branch summaries, even when no
earlier user messages remain. Context-engine projections preserve those
summary entries too. Summaries stay quoted as prior context, separate from
the current request, and remain subject to the projection's size limits;
oversized summaries or older context can be truncated. This handoff does not
change native Codex compaction ownership.

When a context engine requests Codex thread-bootstrap projection, OpenClaw
projects tool-call names and ids, input shapes, and redacted tool-result
content into the fresh Codex thread. It does not copy raw tool-call argument
values into that projection.

The mirror includes the user prompt, final assistant text, and lightweight
Codex reasoning records when the app-server emits them. Reasoning retains
typed `thinking` content rather than ordinary final-answer text, so OpenClaw's
existing reasoning visibility and history controls apply. OpenClaw records
the native compaction start and terminal status, but it does not
expose a human-readable compaction summary or an auditable list of which
entries Codex kept after compaction.

Because Codex owns the canonical native thread, `tool_result_persist` does
not rewrite Codex-native tool result records. It only applies when OpenClaw
writes an OpenClaw-owned session transcript tool result.
