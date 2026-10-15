---
summary: "Visible reply delivery, automation turns, and bounded final-answer recovery"
read_when:
  - You are choosing between automatic and message-tool replies
  - A Codex turn finished tool work without a visible answer
title: "Codex replies and final answers"
sidebarTitle: "Replies and final answers"
---

How final assistant text reaches the source conversation, and what happens when a Codex turn settles without one. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

<a id="visible-replies-and-heartbeats" />

## Visible replies and scheduled checks

Direct/source chat turns through the Codex harness default to automatic final
assistant delivery for internal WebChat surfaces, matching the Pi harness
contract: the agent replies normally and OpenClaw posts the final text to the
source conversation. Set `messages.visibleReplies: "message_tool"` to keep
final assistant text private unless the agent calls `message(action="send")`.

Commentary follows the conversation's progress settings and may be hidden or
temporary. When a question arrives while work continues, the agent is instructed
to send its answer with `message(action="send", final=false)` and continue the
task. The final response covers answers and results that have not already been
delivered. This does not enable commentary or change streaming settings.

Native Codex messages explicitly marked for asynchronous delivery use an
independent delivery intent. They are delivered separately from optional progress
and from the eventual final answer, including when block streaming is disabled.

Scheduled checks are ordinary automation turns. Return a normal final reply for
a visible result or `NO_REPLY` for silence. During a job's run, the `automations`
tool provides self-scoped scratch and `record_result` actions; the retired
`heartbeat_respond` tool is unavailable. Present job scratch is included in the
bounded run context. See [Job scratch and quiet results](/automation/cron-jobs/payloads#job-scratch-and-quiet-results).

## Attachments in a remote workspace

With `appServer.remoteWorkspaceRoot`, final and asynchronous replies can use
`MEDIA:./report.pdf` or an absolute path inside the remote workspace. Before
releasing the app-server connection, the Codex plugin reads the attachment with
bounded `command/exec` requests. The host's
[reply-media capability](/plugins/sdk-agent-harness/attempt-runtime#reply-attachments-from-a-remote-workspace)
applies read policy and stages the bytes for delivery. The original reply remains
in the transcript; Gateway workspace copies are not used as a fallback.
Files outside the remote workspace produce a labeled attachment failure. Copy
them into the workspace before sending. HTTP references and managed `media://`
attachments continue to work.

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
If the native turn failed and finalization cannot produce an answer, the reply
instead explains the failure and the next step. For example, model capacity
errors suggest waiting and retrying or choosing another model. The turn remains
failed in chat and task progress; completed actions are not repeated. An explicit
Stop remains a canceled turn.
Native turns that return a final answer are delivered normally. The ordinary
`homeScope: "user"` opt-in retains its documented private host-auth finalization;
see [Auth and environment isolation](/plugins/codex-harness-reference#auth-and-environment-isolation).
