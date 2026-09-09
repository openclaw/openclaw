---
summary: "Which hook layer owns each Codex turn event, and what the native hook relay can do"
read_when:
  - You are writing a plugin hook that must run on Codex turns
  - You need the native hook relay and approval bridge rules
title: "Codex hook boundaries"
sidebarTitle: "Hook boundaries"
---

The three hook layers around a Codex turn and the events each one owns. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Hook boundaries

For ordinary persistent conversations, a `before_prompt_build` result containing
`systemPrompt` replaces the complete OpenClaw generic developer policy. An explicit
empty string withdraws that policy. Unchanged, configuration-proven warm threads
stay warm, with the retained subscription and host authority rechecked after plugin
policy awaits. A closed or archived thread cannot be reused merely because its
connection is still open. Cold resumes and changed-policy resumes preserve the native thread and
history, verify that Codex unloaded the previous configuration, then append a
complete superseding policy message before admitting the turn. Historical policy
text can remain in the transcript; the later policy explicitly supersedes it.

If another client lease, subscriber, or failed native unload prevents configuration
proof, the turn stops before inference. A prewrite ownership refusal keeps the
healthy shared client and its other conversations available. External WebSocket,
Unix-socket, and stdio-proxy connections do not prove exclusive native-process
ownership, so ordinary conversations cannot perform this guarded cold refresh on
those transports. Use OpenClaw-managed local stdio; for lease contention, stop
competing native work before reconnecting. Policy refusals and uncertain or
acknowledged policy-write failures preserve the conversation and stop automatic
auth-profile, model-fallback, and whole-turn retries.

Supervised external connections retain their existing shared connection-lease
semantics; existing native-home and tool-catalog restrictions still apply. Those
lease checks do not establish exclusive ownership
of the external native process; strengthening that guarantee is a separate
limitation, not part of ordinary policy refresh. Manual ordinary adoption still
requires its agent-home and tool-catalog checks as well as native-process proof.

Ordinary incognito conversations retain their live ephemeral history. Stock Codex
cannot update their generic session configuration or resume them from disk, so a
changed or explicitly emptied generic policy stops the next turn before inference.
Restore the previous policy to continue the conversation, or start a
new incognito conversation for the new policy. Unchanged-policy turns continue;
this check adds no idle expiry or persistence to incognito history.

Preflight refusals keep the normal external-chat diagnostic privacy and group
silence policy. Verbose mode can show bounded recovery detail; Control UI retains
its usual diagnostic rendering. An externally closed ephemeral thread cannot be
promised recoverable.

| Layer                                 | Owner                    | Purpose                                                             |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| OpenClaw plugin hooks                 | OpenClaw                 | Product/plugin compatibility across OpenClaw and Codex harnesses.   |
| Codex app-server extension middleware | OpenClaw bundled plugins | Per-turn adapter behavior around OpenClaw dynamic tools.            |
| Codex native hooks                    | Codex                    | Low-level Codex lifecycle and native tool policy from Codex config. |

OpenClaw does not use project or global Codex `hooks.json` files to route
plugin behavior. For the native tool and permission bridge, OpenClaw injects
per-thread Codex config for `PreToolUse`, `PostToolUse`, `PermissionRequest`,
and `Stop`.

When Codex app-server approvals are enabled (`approvalPolicy` is not
`"never"`), the default injected native hook config omits `PermissionRequest`
so Codex's app-server reviewer and OpenClaw's approval bridge handle real
escalations after review. Add `permission_request` to
`nativeHookRelay.events` to force the compatibility relay anyway. Other Codex
hooks such as `SessionStart` and `UserPromptSubmit` remain Codex-level
controls; they are not exposed as OpenClaw plugin hooks in the v1 contract.

For OpenClaw dynamic tools, OpenClaw executes the tool after Codex asks for
the call, so plugin and middleware behavior runs in the harness adapter. Codex
Code Mode receives generic dynamic results as text and serializes nested
dynamic calls; callers must parse JSON-looking results and cannot rely on
`Promise.all` for concurrent submission. For Codex-native tools, Codex owns the
canonical tool record; OpenClaw can mirror selected events but cannot rewrite
the native thread unless Codex exposes that through app-server or native hook
callbacks.

Codex app-server report-mode `PreToolUse` events defer plugin approval to the
matching app-server approval. If an OpenClaw `before_tool_call` hook returns
`requireApproval` while the native payload sets `openclaw_approval_mode:
"report"`, the native hook relay records the plugin approval requirement and
returns no native decision. When Codex later sends the app-server approval
request for the same tool use, OpenClaw opens the plugin approval prompt and
maps the decision back to Codex. Codex `PermissionRequest` events are a
separate approval path and can still route through OpenClaw approvals when
configured for that bridge.

Codex app-server item notifications also provide async `after_tool_call`
observations for native tool completions not already covered by the native
`PostToolUse` relay. These are telemetry/compatibility only; they cannot
block, delay, or mutate the native tool call.

Compaction and LLM lifecycle projections come from Codex app-server
notifications and OpenClaw adapter state, not native Codex hook commands.
`before_compaction`, `after_compaction`, `llm_input`, and `llm_output` are
adapter-level observations, not byte-for-byte captures of Codex's internal
request or compaction payloads.

Codex native `hook/started` and `hook/completed` app-server notifications are
projected as `codex_app_server.hook` agent events for trajectory and
debugging. They do not invoke OpenClaw plugin hooks.
