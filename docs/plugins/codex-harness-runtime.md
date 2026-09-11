---
summary: "Runtime boundaries, hooks, tools, permissions, and diagnostics for the Codex harness"
title: "Codex harness runtime"
read_when:
  - You need the Codex harness runtime support contract
  - You are debugging native Codex tools, hooks, compaction, or feedback upload
  - You are changing plugin behavior across OpenClaw and Codex harness turns
---

Runtime contract for Codex harness turns. For setup and routing, see
[Codex harness](/plugins/codex-harness). For config fields, see
[Codex harness reference](/plugins/codex-harness-reference).

## Overview

Codex owns the native model loop, native thread resume, native tool
continuation, and native compaction. OpenClaw owns channel routing, session
files, visible message delivery, OpenClaw dynamic tools, approvals, media
delivery, and a transcript mirror around that boundary.

Successful `/btw` side questions report aggregate usage to reply usage hooks and,
when diagnostics are enabled, `model.usage` events. Totals include cache reads,
cache writes, and every completed model call in the side thread's native tool
loop; replayed response IDs are counted once. The visible reply still contains
only the last answer, and the main session's usage and context snapshot stay unchanged.

For native connected apps, Codex also owns the final per-thread app and tool
policy. OpenClaw caches a runtime-and-workspace-scoped `plugin/installed`
snapshot, reads exact configured plugin details, provisionally admits only
explicitly allowed, ownership-proven apps, and creates a deny-by-default
native thread. One `app/installed` request verifies the actual thread ID
without forcing an inventory refresh. Missing, disabled, or non-callable apps
produce one warning; the conversation continues with the remaining tools.
Codex still enforces app and tool permissions for the actual thread.

This check finishes before OpenClaw injects history, starts a turn, or commits a
thread binding. If the snapshot request fails, persistent provisional threads
are deleted and ephemeral threads are unsubscribed. OpenClaw retires the app-server connection when safe
cleanup cannot be confirmed. Supervised branches also clean up their temporary
probe and preserve recovery state if cleanup fails.

Account-wide app access cannot override an explicitly disabled configured
workspace plugin. OpenClaw uses its installed snapshot and reads only that
exact plugin's details to identify and deny its apps; it never scans unrelated
marketplaces or activates the plugin.

Prompt routing follows the selected runtime, not just the provider string. A
native Codex turn gets Codex app-server developer instructions; an explicit
OpenClaw compatibility route keeps the normal OpenClaw system prompt even when
it uses Codex-flavored OpenAI auth or transport.

OpenClaw starts and resumes native Codex threads with Codex's built-in
personality disabled (`personality: "none"`) so workspace personality files
and OpenClaw agent identity stay authoritative. Native Codex keeps Codex-owned
base/model instructions and project-doc loading otherwise. An ordinary
policy-restricted turn has no native filesystem environment, so OpenClaw carries
the bounded workspace `AGENTS.md` snapshot as thread-level developer
instructions instead. Lightweight, ring-zero, message-only, and tool-disabled
internal turns suppress project-doc loading and that fallback carrier.

OpenClaw developer instructions cover OpenClaw runtime concerns: source-channel
delivery, OpenClaw dynamic tools, ACP delegation, adapter context, and the
active agent workspace profile files. With the OpenClaw-managed bundled stdio
app-server using standard OpenAI endpoints, skill catalogs, persona files, and tool-routed `MEMORY.md` guidance
are appended to the parent model request instructions by a private inference
relay. Native base and catalog instructions remain unchanged; this new context
is not written to native conversation history or automatically inherited by
native subagents. Active `BOOTSTRAP.md` and, when memory tools are unavailable,
bounded `MEMORY.md` content travel as plain turn input references. They are
introduced on a new native thread, after a cold resume or native compaction,
and when their rendered content changes. Consecutive warm turns omit unchanged
references once the complete block has been submitted. References dropped or
truncated by prompt fitting are introduced again on a later turn. Process-local
tracking resets when the Gateway restarts.

Custom commands, Desktop attachments, external Unix/WebSocket app-server
connections, non-OpenAI native providers, custom upstream endpoints, unsupported
native accounts, locked upstreams, and native `features.respect_system_proxy` profiles retain their existing
collaboration carrier. Managed relay requests use the Gateway's HTTP(S) proxy
and TLS configuration instead of changing native networking settings. OpenClaw reports that
the parent-local workaround is unavailable there rather than replacing another
application's live configuration. Existing history, including any older embedded
persona or explicitly shared task text, is preserved; this is not a retroactive
history scrub. See [Workspace bootstrap files](/plugins/codex-harness-reference#workspace-bootstrap-files).

Delivery mode and the current message target requirement arrive as compact
application context before each user turn. They explicitly supersede earlier
delivery guidance while preserving permission and temporal context. With the
same available tools, switching between automatic replies and message-tool-only
replies keeps the static instructions and message tool definition unchanged.
If the message tool is unavailable on a message-tool-only turn, final text stays
private to the invoking workflow; it is not delivered to the source conversation.

When `openclaw_direct.sessions_yield` is available, those instructions also
tell a native Codex parent to end the current turn when a child's result should
arrive in a later turn. Native `wait_agent` remains for an intentional same-turn
wait when the immediate next step is blocked on the child; completion polling
loops are not a substitute.

Most OpenClaw dynamic tools use the searchable `openclaw` namespace. Tools
marked `catalogMode: "direct-only"` use `openclaw_direct`, which Codex keeps
directly model-visible as `DirectModelOnly` instead of exposing it to nested
Code Mode execution.

Tool-schema repairs preserve literal property and definition names, including
`__proto__`. The schema advertised to Codex and the schema used to validate
OpenClaw tool calls retain the same required fields and constraints.

For a [managed GitHub identity](/gateway/config-tools#tools.github), `gateway_exec` uses OpenClaw's private local process-launch credential binding. Native Codex shell instead receives only the non-secret `GH_CONFIG_DIR` and token-clearing overlay; a missing or tokenless profile can still let GitHub CLI fall back to the OS keyring. Status and Gateway-owned publication guarantees do not cover that native shell path. Use `gateway_exec` when launch-bound managed GitHub credentials are required.

## Media and delivery

OpenClaw continues to own media delivery and media provider selection. Image,
video, music, PDF, TTS, and media understanding use matching provider/model
settings such as `agents.defaults.mediaModels.image`,
`agents.defaults.mediaModels.video`, `pdfModel`, and `tts`.

Text, images, video, music, TTS, approvals, and messaging-tool output continue
through the normal OpenClaw delivery path; media generation does not require
the legacy runtime. When Codex emits a native image-generation item with a
`savedPath`, OpenClaw forwards that exact file through the normal reply-media
path even if the Codex turn has no assistant text.

## Where each section moved

Every section of the single-page version now lives on this page or on one of the
nine child pages below. The anchors from the single-page version still resolve here.

### Codex process recovery

[Codex process recovery](/plugins/codex-harness-runtime/recovery) — Orphaned Codex app-server process detection and cleanup after a hard Gateway stop.

- <a id="recovery-after-a-hard-gateway-stop"></a>[Recovery after a hard Gateway stop](/plugins/codex-harness-runtime/recovery#recovery-after-a-hard-gateway-stop)

### Codex thread bindings and supervision

[Codex thread bindings and supervision](/plugins/codex-harness-runtime/threads) — How OpenClaw binds native Codex threads, changes models, and continues supervised sessions.

- <a id="thread-bindings-and-model-changes"></a>[Thread bindings and model changes](/plugins/codex-harness-runtime/threads#thread-bindings-and-model-changes)
- <a id="supervision-and-safe-continuation"></a>[Supervision and safe continuation](/plugins/codex-harness-runtime/threads#supervision-and-safe-continuation)

### Codex replies and final answers

[Codex replies and final answers](/plugins/codex-harness-runtime/replies) — Visible reply delivery, heartbeat turns, and bounded final-answer recovery.

- <a id="visible-replies-and-heartbeats"></a>[Visible replies and heartbeats](/plugins/codex-harness-runtime/replies#visible-replies-and-heartbeats)
- <a id="final-answers-after-settled-tool-work"></a>[Final answers after settled tool work](/plugins/codex-harness-runtime/replies#final-answers-after-settled-tool-work)

### Codex hook boundaries

[Codex hook boundaries](/plugins/codex-harness-runtime/hooks) — Which hook layer owns each Codex turn event, and what the native hook relay can do.

- <a id="hook-boundaries"></a>[Hook boundaries](/plugins/codex-harness-runtime/hooks#hook-boundaries)

### Codex sandbox process streaming

[Codex sandbox process streaming](/plugins/codex-harness-runtime/sandbox-streaming) — Experimental native sandbox execution streaming and node-backed remote exec.

- <a id="experimental-sandbox-process-streaming"></a>[Experimental sandbox process streaming](/plugins/codex-harness-runtime/sandbox-streaming#experimental-sandbox-process-streaming)

### Codex runtime v1 support contract

[Codex runtime v1 support contract](/plugins/codex-harness-runtime/v1-support-contract) — What is and is not supported in Codex runtime v1, with the reason for each boundary.

- <a id="v1-support-contract"></a>[V1 support contract](/plugins/codex-harness-runtime/v1-support-contract#v1-support-contract)

### Codex native permissions and elicitations

[Codex native permissions and elicitations](/plugins/codex-harness-runtime/permissions) — Native permission decisions, remembered approvals, and MCP elicitation limits.

- <a id="native-permissions-and-mcp-elicitations"></a>[Native permissions and MCP elicitations](/plugins/codex-harness-runtime/permissions#native-permissions-and-mcp-elicitations)

### Codex queue steering and feedback upload

[Codex queue steering and feedback upload](/plugins/codex-harness-runtime/queue-and-feedback) — Active-run queue steering on Codex turns and the Codex feedback upload path.

- <a id="queue-steering"></a>[Queue steering](/plugins/codex-harness-runtime/queue-and-feedback#queue-steering)
- <a id="codex-feedback-upload"></a>[Codex feedback upload](/plugins/codex-harness-runtime/queue-and-feedback#codex-feedback-upload)

### Codex compaction and transcript mirror

[Codex compaction and transcript mirror](/plugins/codex-harness-runtime/compaction) — Native Codex compaction, the OpenClaw transcript mirror, and continuity projection.

- <a id="compaction-and-transcript-mirror"></a>[Compaction and transcript mirror](/plugins/codex-harness-runtime/compaction#compaction-and-transcript-mirror)

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex supervision](/plugins/codex-supervision)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Plugin hooks](/plugins/hooks)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Agent runtimes](/concepts/agent-runtimes)
- [Diagnostics export](/gateway/diagnostics)
- [Trajectory export](/tools/trajectory)
- [ACP agents](/tools/acp-agents) — how ACP agents are configured and bound
