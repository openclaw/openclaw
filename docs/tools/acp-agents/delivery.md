---
summary: "How ACP output is delivered for interactive and parent-owned sessions, and the sandbox boundary"
title: "ACP agents delivery model"
read_when:
  - Troubleshooting ACP completion delivery or agent-to-agent loops
  - You are resuming an existing ACP session
  - You need the ACP sandbox security boundary
---

## Delivery model

ACP sessions can be either interactive workspaces or parent-owned background
work. The delivery path depends on that shape.

<AccordionGroup>
  <Accordion title="Interactive ACP sessions">
    Interactive sessions are meant to keep talking on a visible chat surface:

    - `/acp spawn ... --bind here` binds the current conversation to the ACP session.
    - `/acp spawn ... --thread ...` binds a channel thread/topic to the ACP session.
    - Persistent configured `bindings[].type="acp"` route matching conversations to the same ACP session.

    Follow-up messages in the bound conversation route directly to the ACP
    session, and ACP output is delivered back to that same
    channel/thread/topic.

    When an ACP agent requests structured input during a delivered turn,
    OpenClaw presents supported form fields as transient Gateway questions in
    batches of up to three. Single- and multi-select fields support up to four
    choices. URL requests show the literal HTTP(S) URL with explicit Continue
    and Decline choices; OpenClaw does not fetch or open it. Explicitly secret
    fields use a warned, ephemeral text-reply prompt and are never stored in a
    Gateway question record. Malformed or unsupported requests produce a
    visible explanation and are declined instead of returning empty answers.

    What OpenClaw sends to the harness:

    - Normal bound follow-ups are sent as prompt text, plus attachments only when the harness/backend supports them.
    - `/acp` management commands and local Gateway commands are intercepted before ACP dispatch.
    - Runtime-generated completion events are materialized per target. OpenClaw agents get OpenClaw's internal runtime-context envelope; external ACP harnesses get a plain prompt with the child result and instruction. The raw `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` envelope should never be sent to external harnesses or persisted as ACP user transcript text.
    - ACP transcript entries use the user-visible trigger text or the plain completion prompt. Internal event metadata stays structured in OpenClaw where possible and is not treated as user-authored chat content.

  </Accordion>
  <Accordion title="Parent-owned one-shot ACP sessions">
    One-shot ACP sessions spawned by another agent run are background
    children, similar to sub-agents:

    - The parent asks for work with `sessions_spawn({ runtime: "acp", mode: "run" })`.
    - The child runs in its own ACP harness session.
    - Child turns run on the same background lane used by native sub-agent spawns, so a slow ACP harness does not block unrelated main-session work.
    - Completion reports back through the task-completion announce path. OpenClaw converts internal completion metadata into a plain ACP prompt before sending it to an external harness, so harnesses do not see OpenClaw-only runtime context markers.
    - The parent rewrites the child result in normal assistant voice when a user-facing reply is useful.

    Do **not** treat this path as a peer-to-peer chat between parent and
    child. The child already has a completion channel back to the parent.

  </Accordion>
  <Accordion title="sessions_send and A2A delivery">
    `sessions_send` can target another session after spawn. For normal peer
    sessions, OpenClaw uses an agent-to-agent (A2A) follow-up path after
    injecting the message:

    - Wait for the target session's reply.
    - Optionally let requester and target exchange a bounded number of follow-up turns.
    - Ask the target to produce an announce message.
    - Deliver that announce to the visible channel or thread.

    That A2A path is a fallback for peer sends where the sender needs a
    visible follow-up. It stays enabled when an unrelated session can see and
    message an ACP target, for example under broad `tools.sessions.visibility`
    settings.

    OpenClaw skips the A2A follow-up only when the requester is the parent of
    its own parent-owned one-shot ACP child. In that case, running A2A on top
    of task completion can wake the parent with the child's result, forward
    the parent's reply back into the child, and create a parent/child echo
    loop. Accepted `sessions_send` results report target admission separately
    from announcement delivery: `targetDisposition` is `queued` or `steered`,
    while `delivery.status` is `pending` or `skipped`. For this owned-child case,
    `delivery.status="skipped"` because the completion path is already responsible
    for the result.

  </Accordion>
  <Accordion title="Resume an existing session">
    Use `resumeSessionId` to continue a previous ACP session instead of
    starting fresh. The agent replays its conversation history via
    `session/load`, so it picks up with full context of what came before.

    ```json
    {
      "task": "Continue where we left off - fix the remaining test failures",
      "runtime": "acp",
      "agentId": "codex",
      "resumeSessionId": "<previous-session-id>"
    }
    ```

    Common use cases:

    - Hand off a Codex session from your laptop to your phone - tell your agent to pick up where you left off.
    - Continue a coding session you started interactively in the CLI, now headlessly through your agent.
    - Pick up work that was interrupted by a gateway restart or idle timeout.

    Notes:

    - `resumeSessionId` only applies when `runtime: "acp"`; the default sub-agent runtime ignores this ACP-only field.
    - `streamTo` only applies when `runtime: "acp"`; the default sub-agent runtime ignores this ACP-only field.
    - `resumeSessionId` is a host-local ACP/harness resume id, not an OpenClaw channel session key; OpenClaw still checks ACP spawn policy and target agent policy before dispatch, while the ACP backend or harness owns authorization for loading that upstream id.
    - `resumeSessionId` restores the upstream ACP conversation history; `thread` and `mode` still apply normally to the new OpenClaw session you are creating, so `mode: "session"` still requires `thread: true`.
    - The target agent must support `session/load` (Codex and Claude Code do).
    - If the session id is not found, the spawn fails with a clear error - no silent fallback to a new session.

  </Accordion>
  <Accordion title="Post-deploy smoke test">
    After a gateway deploy, run a live end-to-end check rather than trusting
    unit tests:

    1. Verify the deployed gateway version and commit on the target host.
    2. Open a temporary ACPX bridge session to a live agent.
    3. Ask that agent to call `sessions_spawn` with `runtime: "acp"`, `agentId: "codex"`, `mode: "run"`, and task `Reply with exactly LIVE-ACP-SPAWN-OK`.
    4. Verify `accepted=yes`, a real `childSessionKey`, and no validator error.
    5. Clean up the temporary bridge session.

    Keep the gate on `mode: "run"` and skip `streamTo: "parent"` -
    thread-bound `mode: "session"` and stream-relay paths are separate richer
    integration passes.

  </Accordion>
</AccordionGroup>

## Sandbox compatibility

ACP sessions currently run on the host runtime, **not** inside the OpenClaw
sandbox.

<Warning>
**Security boundary:**

- The external harness can read/write according to its own CLI permissions and the selected `cwd`.
- OpenClaw's sandbox policy does **not** wrap ACP harness execution.
- OpenClaw still enforces ACP feature gates, allowed agents, session ownership, channel bindings, and Gateway delivery policy.
- Use `runtime: "subagent"` for sandbox-enforced OpenClaw-native work.

</Warning>

Current limitations:

- If the requester session is sandboxed, ACP spawns are blocked for both `sessions_spawn({ runtime: "acp" })` and `/acp spawn`.
- `sessions_spawn` with `runtime: "acp"` does not support `sandbox: "require"`.
