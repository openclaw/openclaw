---
summary: "Visible reply delivery, heartbeat turns, and bounded final-answer recovery"
read_when:
  - You are choosing between automatic and message-tool replies
  - A Codex turn finished tool work without a visible answer
title: "Codex replies and final answers"
sidebarTitle: "Replies and final answers"
---

How final assistant text reaches the source conversation, and what happens when a Codex turn settles without one. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Visible replies and heartbeats

Direct/source chat turns through the Codex harness default to automatic final
assistant delivery for internal WebChat surfaces, matching the Pi harness
contract: the agent replies normally and OpenClaw posts the final text to the
source conversation. Set `messages.visibleReplies: "message_tool"` to keep
final assistant text private unless the agent calls `message(action="send")`.

Codex heartbeat turns get `heartbeat_respond` in the searchable OpenClaw tool
catalog by default so the agent can record whether the wake should stay quiet
or notify. Heartbeat turns use the same Codex Default collaboration mode as
ordinary chat turns. The heartbeat monitor's cron scratch is appended to the
scheduled heartbeat user message when present.

## Attachments in a remote workspace

With `appServer.remoteWorkspaceRoot`, final and asynchronous replies can use
`MEDIA:./report.pdf` or an absolute path inside the remote workspace. Before
releasing the app-server connection, the Codex plugin reads the attachment with
bounded `command/exec` requests. The host's
[reply-media capability](/plugins/sdk-agent-harness/attempt-runtime#reply-attachments-from-a-remote-workspace)
applies read policy and stages the bytes for delivery. The original reply remains
in the transcript; Gateway workspace copies are not used as a fallback.

## Final answers after settled tool work

For ordinary host-authenticated Codex turns that finish tool work without a
visible answer, OpenClaw can request a bounded final-answer turn in a private
temporary home. It uses the completed thread's model selection and the original
host auth route or resolved profile, rather than selecting a model from outer
request metadata. The existing environment, dynamic-tool, MCP, and native-hook
restrictions remain. Completed actions are transcript evidence, not instructions
to replay. Preserving a native model does not, by itself, disable host-authenticated
finalization.

Hidden background-task completion messages remain eligible for this recovery
when they are part of the model's context. The host records their native turn
identity on the admitted prompt while keeping them hidden in chat. Native
transcript mirroring reuses that prompt as evidence; it cannot recreate an
admitted prompt that disappeared. Messages explicitly excluded from model
context remain outside native prompt annotation.

Recovery reserves its existing limits for the complete current turn, then keeps
the nearest whole earlier exchanges that fit. Older exchanges can be omitted,
including a whole exchange that is too large. A notice identifies missing history
when space permits; the finalizer is always instructed to state uncertainty about
missing facts. Current evidence that exceeds the limits, invalid tool pairs, or
unsupported content still makes recovery unavailable. Existing conversation
history stays intact, and completed actions are never repeated.

A Chat created through Codex Sessions is different: its private supervision
connection owns native authentication. Stock Codex does not expose a generic
tool-free summary operation that preserves that connection's account. OpenClaw
marks this finalization context unavailable instead of choosing host credentials,
copying native credentials, or starting another native turn. If a final reply is
required, the host delivers its existing fallback:

> The tool run finished, but no final summary was produced. I did not repeat any completed actions.

The original completed outcome, native binding, and tool receipts remain intact.
Native turns that return a final answer are delivered normally. The ordinary
`homeScope: "user"` opt-in retains its documented private host-auth finalization;
see [Auth and environment isolation](/plugins/codex-harness-reference#auth-and-environment-isolation).
