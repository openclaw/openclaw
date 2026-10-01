---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Explaining why steering does not cancel an already-running tool
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt queue modes
title: "Steering queue"
---

When a normal prompt arrives while a session run is active and the queue mode is `steer` (the default, no config needed), OpenClaw tries to send that prompt into the active runtime, including during tool execution. OpenClaw and the native Codex app-server harness implement the delivery details differently.

This page covers queue-mode steering for normal inbound messages in `steer` mode. In `followup` or `collect` mode, normal messages skip this path and wait until the active run finishes. For the explicit `/steer <message>` command, see [Steer](/tools/steer).

An older followup does not disable steering for later input. OpenClaw tries each new steer against the active run after earlier steering attempts settle. Messages that the runtime declines remain queued in their original order; accepted steering goes to the active turn.

## Runtime boundary

Steering does not interrupt a tool call that is already running. The OpenClaw runtime checks at tool-launch boundaries as well as model boundaries:

1. The assistant asks for tool calls.
2. In sequential mode, OpenClaw checks immediately before each call starts, including after asynchronous resolution, validation, and pre-execution hooks.
3. A running call finishes. If a steer is waiting afterward, the unstarted sequential tail is skipped.
4. In parallel mode, OpenClaw prepares calls first, then checks once immediately before launching the prepared calls. Calls that have crossed that checkpoint continue together.
5. Every skipped call receives paired tool start/end events and a synthetic result (`Skipped to process an incoming message.`), in assistant source order. The result tells the model that the tool did not run, and the Control UI labels it **Skipped**.
6. OpenClaw appends the exact drained steering message before the next LLM call.

This keeps every requested tool call paired with a result while ensuring accepted steering is model-visible before any later tool can start.

Internal updates, including subagent completion reports, also use this steering boundary. These updates can be hidden from the chat transcript and do not appear in the user message queue. A skipped tool therefore does not necessarily mean a user message is waiting; the agent processes the incoming update before deciding which tools to call next.

In the built-in runtime, each steered user input gets its own delivered answer in order. A later answer does not replace a completed answer to an earlier input, even when steering skipped its pending tools.

A steered channel reply carries that message's quoted or forwarded context into
the model input. Quoted content stays conversation data; commands and answers to
pending questions use the literal incoming text. Text-only transcript entries
also retain the literal input.

The native Codex app-server harness exposes `turn/steer` instead of OpenClaw runtime's internal steering queue. OpenClaw batches queued prompts for the configured quiet window, then sends a single `turn/steer` request with all collected user input in arrival order. Codex's upstream turn scheduler owns its tool scheduling and drains pending input at model boundaries; OpenClaw does not add per-tool preemption to that runtime. A transcript commit confirms persistence, not that a later model request has read the input.

Codex review and manual compaction turns reject same-turn steering. When a runtime cannot accept steering in `steer` mode, OpenClaw waits for the active run to finish before starting the prompt.

On Codex installs without native hook admission, another person's message queues as a follow-up instead of steering the active turn when native sub-agent spawning is available. If the thread's policy already disables native spawning, including ChatGPT token sharing and report-only delegation, other people can still steer the running turn.

Once an OpenClaw turn has finished or handed off, new prompts wait for the next turn even while cleanup is still running. Retries and compaction within the current turn can still receive steering.

## Tool launch boundaries

OpenClaw distinguishes started work from requested work:

- A sequential call that is already running completes. Later calls have not started, so OpenClaw returns synthetic skipped results for them and lets the model reconsider with the steer visible.
- A parallel batch has one atomic launch checkpoint. A steer present before it suppresses all prepared calls; a steer arriving after it does not recall any of them.
- Validation or policy outcomes finalized before the parallel checkpoint remain truthful. Only executable calls that did not start receive the steering skip result.
- The transcript stays append-only and structurally paired: assistant tool calls, real or synthetic tool results, then the steering user message.

Stopping already-running work is a different intent from redirecting future work. Use `/queue interrupt` (or `/stop`) when the newest message should abort the active run instead of steering it.

## Modes

| Mode        | Active-run behavior                                    | Later behavior                                                                      |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `steer`     | Steers the prompt into the active runtime when it can. | Waits for the active run to finish if steering is unavailable.                      |
| `followup`  | Does not steer.                                        | Runs queued messages later after the active run ends.                               |
| `collect`   | Does not steer.                                        | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt` | Aborts the active run instead of steering it.          | Starts the newest message after aborting.                                           |

## Burst example

If four users send messages while the agent is executing a tool call:

- OpenClaw preserves the runtime's configured steering drain mode and FIFO order. One-at-a-time consumers keep later messages for later boundaries; `all` consumers inject the queued FIFO batch together. Codex receives messages collected during its quiet window as one batched `turn/steer`.
- With `/queue collect`, OpenClaw does not steer. It waits until the active run ends, then creates a followup turn with compatible queued messages after the debounce window.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest message instead of steering.

## Scope

Steering always targets the current active session run. It does not create a new session, change the active run's tool policy, or split messages by sender. In multi-user channels, inbound prompts already include sender and route context, so the next model call can see who sent each message.

Visible user turns started through the `agent` RPC can also receive compatible
steering. Direct background turns with optional replies leave new human messages
queued for a followup turn that can provide the required answer.

Different signed-in people with the same permissions can steer each other's
active turn, including from different browsers or after reconnecting. The turn
keeps its original owner's authority, tool bindings, and approval destination.
Personal tools (`screen` and `theme`) act for one named person. When several
people have steered the turn, the agent must pass that person's verified
`requester_profile.id` as `user` to choose whose view or appearance to change,
and ask if it is unclear. Each authenticated Control UI message includes its
requester's verified profile id in the agent's user-role conversation context.
Session tools and `sessions_spawn` also use the requester's verified
`requester_profile.id` as `user` when several people have steered the turn. Session
access and spawned-child authority use that person's permissions. Steered turns,
like later turns in the session, use the session's selected model account.
Unselected session calls in a multi-person turn may use the owner's authority only for that turn's own session; other targets and session-wide discovery require a session tool with the requester's `requester_profile.id` as `user`.
Personal instructions and other personal settings without a `user` selector
cannot be read or changed from a turn several people have steered. The person
should ask in their own turn with a new Control UI message. For Crabbox open-and-show requests in a
mixed-person turn, create the environment without `presentation`, then use
`screen` with `desktop_show` or `portal_show`, its `environmentId`, and the
requester's `requester_profile.id` as `user`.
Different permissions (role scopes, session access cap, sandbox requirement,
allowed agents, model access, access grant, or tool policy) queue the message as
a followup; changes to execution policy, workspace, or bound tools can also
require a followup.

Automatic credential rotation and model fallback also retain the active turn.
New input can steer that turn while the selected model remains unchanged, fallback
is still allowed, and the current permissions match. Selecting or locking a model,
pinning a different account, or changing tool permissions can require a followup
turn. Answers to a pending question still go to the question's original owner.

[Personal `USER.md` context](/concepts/user-model#personal-user-files-on-a-shared-gateway)
follows the session's assigned human owner, otherwise its authenticated human
creator. Another participant with the same permissions can steer without switching
that personal context, and collected messages keep the same session selection. Reassignment
takes effect on the next new turn; it does not replace the running turn's personal
instructions. Personal context selection does not grant tool permissions or
change the approval destination.

Accepted cross-session steering retains the selected sender's source authority
after the sending turn finishes. Access revocation can still block an input
before its transcript commit.

A visible message or send acknowledgment does not mean the active runtime has
consumed it. The Control UI shows specific notices when an accepted message is
waiting for worker setup or workspace sync.
Messages waiting for a followup turn appear in the queue above the composer,
including when the Gateway queues a message that could not be steered. They stay
there across reconnects until consumed or canceled, without being sent again.

While the selected session has an active run, **Steer** on a queued message asks that run to accept the original input. This works for both unsent browser messages and messages already accepted into the Gateway queue. Gateway-queued input keeps its original identity, attachments, and permissions; the browser does not cancel and resend it. If the active run cannot accept the input, it stays queued in its existing position and the UI explains the refusal. If the run finishes or the message starts first, the action does not create another copy.

Use `followup` or `collect` when you want messages to queue by default instead of steering the active run. Use `interrupt` when the newest prompt should replace the active run.

## Canceling a pending steer

An authorized Gateway client can withdraw a message still waiting in the OpenClaw
runtime's steering queue, before delivery starts, with `chat.abort({ sessionKey,
runId })`. Use the `runId` returned by that message's `chat.send`. This withdraws
that message without stopping the active run or retrying it as a followup.

Once delivery starts, cancellation cannot guarantee withdrawal or undo completed
work. If delivery cannot be confirmed, the existing steering safeguards can stop
the active run to avoid replaying input whose consumption is uncertain.

## Debounce

The built-in queue debounce applies to queued `followup` and `collect` delivery. In `steer` mode with the native Codex harness, it also sets the quiet window before sending batched `turn/steer`. OpenClaw active steering does not use the debounce timer; at tool-launch and model boundaries it drains FIFO according to the runtime's configured steering drain mode.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
- [Codex harness runtime](/plugins/codex-harness-runtime) - `turn/steer` behavior on the native Codex harness
