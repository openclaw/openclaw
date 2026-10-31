---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Explaining why steering does not cancel an already-running tool
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt queue modes
title: "Steering queue"
---

When a prompt arrives in the same conversation and the queue mode is `steer` (the default, no config needed), OpenClaw tries to send that prompt into the active runtime, including during tool execution. Collaborative steering is enabled by default; operators can disable it explicitly. OpenClaw and the native Codex app-server harness implement the delivery details differently.

This page covers queue-mode steering for normal inbound messages in `steer` mode. In `followup` or `collect` mode, normal messages skip this path and wait until the active run finishes. For the explicit `/steer <message>` command, see [Steer](/tools/steer).

An older followup does not disable steering for later input. OpenClaw tries each new steer against the active run after earlier steering attempts settle. When the runtime cannot accept steering, messages remain queued in their original order; accepted steering goes to the active turn. When collaborative steering is disabled, another requester’s input queues quietly as their own turn. An explicit `collaborativeSteeringFallback: "reject"` instead refuses it.

## Runtime boundary

Steering does not interrupt a tool call that is already running. An assistant message's tool calls are a committed plan until one of them starts executing:

1. The assistant asks for tool calls.
2. In sequential mode, OpenClaw launches the first executable call without checking steering. After a call from that assistant message has started, OpenClaw checks before each later call, including after asynchronous resolution, validation, and pre-execution hooks.
3. A running call finishes. If a steer is waiting afterward, the unstarted sequential tail is skipped.
4. In parallel mode, OpenClaw prepares and launches calls together without a steering checkpoint. Waiting steering never skips a parallel batch.
5. Every skipped call receives paired tool start/end events and a synthetic result (`Skipped to process an incoming message.`), in assistant source order. The result tells the model that the tool did not run, and the Control UI labels it **Skipped**.
6. After either kind of batch settles, OpenClaw checks steering before stop hooks or the next model call. It appends the exact drained steering messages after the tool results, before the next LLM call.

This keeps every requested tool call paired with a result without discarding a freshly requested plan before any tool executes.

Internal updates, including subagent completion reports, also use this steering boundary. These updates can be hidden from the chat transcript and do not appear in the user message queue. A skipped tool therefore does not necessarily mean a user message is waiting; the agent processes the incoming update before deciding which tools to call next.

In the built-in runtime, each steered user input gets its own delivered answer in order. A later answer does not replace a completed answer to an earlier input, even when steering skipped its pending tools.

Recording a steering receipt while another input is being persisted keeps the active turn running. Accepted inputs remain in order and reach the next available model boundary.

A steered channel reply carries that message's quoted or forwarded context into
the model input. Quoted content stays conversation data; commands and answers to
pending questions use the literal incoming text. Text-only transcript entries
also retain the literal input.

The native Codex app-server harness exposes `turn/steer` instead of OpenClaw runtime's internal steering queue. OpenClaw batches queued prompts for the configured quiet window, then sends a single `turn/steer` request with all collected user input in arrival order. Codex's upstream turn scheduler owns its tool scheduling and drains pending input at model boundaries; OpenClaw does not add per-tool preemption to that runtime. A transcript commit confirms persistence, not that a later model request has read the input.

A plugin-owned CLI runtime accepts steering when it offers an input sink through `registerMessageInjection` (see [CLI backend plugins](/plugins/cli-backend-plugins)). The local Claude backend supports text-only input through its persistent stream-JSON process. This applies to `messages.queue.mode: "steer"`, channel queue overrides, per-session `/queue steer`, and explicit `/steer` (`/tell`) regardless of the stored queue mode. Session settings take precedence over channel settings, which take precedence over the global mode; the default is `steer`.

OpenClaw waits for Claude's input lifecycle acknowledgement before recording acceptance and the user transcript. Native scheduling determines whether text joins the current answer or starts another native answer inside the same attached OpenClaw run; steering does not promise a single answer or interrupt a running tool. Before initial prompt submission, after finalization, on runtimes without input lifecycle support, or when native refuses unconsumed input, normal queue fallback remains available. Already-consumed input is not replayed. Images and incompatible permissions remain followup input; node/process alternatives do not gain text steering from this plugin capability.

Codex review and manual compaction turns reject same-turn steering. When a runtime cannot accept steering in `steer` mode, OpenClaw waits for the active run to finish before starting the prompt.

Once an OpenClaw turn has finished or handed off, new prompts wait for the next turn even while cleanup is still running. Retries and compaction within the current turn can still receive steering. When a model request fails while a steered message is still waiting, that message does not take over the turn: OpenClaw retries or falls back for the original message, and the steered message runs as its own turn afterwards.

## Tool launch boundaries

OpenClaw tracks whether a tool has actually started across the whole assistant message:

- Before any tool in the assistant message has started, steering cannot skip a sequential call. Validation or policy rejection alone does not count as execution starting.
- A sequential call that is already running completes. Waiting steering can skip the unstarted sequential tail and let the model reconsider with the steer visible.
- Parallel batches never skip calls for steering. Prepared calls launch together, and steering is checked after the batch settles.
- Streamed tool batches and any remaining calls at the end of the same assistant message share this started state. A later sequential batch can be skipped after an earlier call started; a later parallel batch still runs.
- The transcript stays append-only and structurally paired: assistant tool calls, real or synthetic tool results, then the steering user message.

A tool skipped for steering does not trigger a failure warning. A genuine tool
failure remains reportable even if a later call is skipped.

Stopping already-running work is a different intent from redirecting future work. Use `/queue interrupt` (or `/stop`) when the newest message should abort the active run instead of steering it.

## Modes

| Mode        | Active-run behavior                                    | Later behavior                                                                      |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `steer`     | Steers the prompt into the active runtime when it can. | Waits for the active run to finish if steering is unavailable.                      |
| `followup`  | Does not steer.                                        | Runs queued messages later after the active run ends.                               |
| `collect`   | Does not steer.                                        | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt` | Aborts the active run instead of steering it.          | Starts the newest message after aborting.                                           |

Messages with separate durable ingress admission, including Discord and Telegram messages, are not compatible for batching: `collect` keeps them as separate followup turns. Compatible Gateway `chat.send` inputs can still combine. See [Queue modes](/concepts/queue#queue-modes).

## Burst example

If several messages arrive while the agent is executing a tool call:

- With collaborative steering enabled, messages from another admitted participant can join the active turn under its original requester and prepared permissions. With an explicit `messages.queue.allowCollaborativeSteering: false`, another person’s input queues quietly for their own turn.
- For accepted steering, OpenClaw preserves the runtime's configured steering drain mode and FIFO order. One-at-a-time consumers keep later messages for later boundaries; `all` consumers inject the queued FIFO batch together. Codex receives messages collected during its quiet window as one batched `turn/steer`.
- With `/queue collect`, OpenClaw does not steer. It waits until the active run ends, then creates followup turns after the debounce window, combining only compatible queued messages.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest message instead of steering.

## Scope

`messages.queue.allowCollaborativeSteering` defaults to `true`. Operators can set it to `false` to keep participants’ executions separate. When Bob's admitted human input joins Alice's active turn in the same conversation, the execution keeps Alice's identity and prepared permissions. Bob can influence actions using permissions Alice has that Bob does not. Bob remains identified as the message author; steering does not switch the execution to Bob, combine their permissions, or attribute subsequent actions to individual messages.

With the option set to `false` and quiet fallback selected, another person’s input queues for a separate execution under their identity and current policy. The active turn is unchanged. No warning or queue status message is sent for this expected fallback. Ordinary guidance from the same authenticated requester in the same conversation retains the active execution’s prepared permissions, regardless of this option. Reconnecting with different client capabilities or caller tool bindings does not replace that execution or its permissions. Unidentified input cannot borrow the active execution's authority. Current conversation access, the original execution’s live authority, backend compatibility, cancellation, and current-owner checks always apply.

For strict opt-in refusal, set `messages.queue.collaborativeSteeringFallback: "reject"`. Only this mode sends the following refusal without invoking the model:

> Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as `/followup <message>` to run it afterward.
>
> Admins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.

The refused message is settled without executable queue or recovery custody. It does not run after the active turn ends, and redelivery does not turn it into new work. This does not require removing conversation history. `/followup <message>` is a fresh, one-message request for a new execution under its submitter’s identity. It respects existing queued work and resolves current policy at admission, without changing the persistent queue mode.

This option permits steering only when the queue mode attempts it. `followup`, `collect`, and `interrupt` keep their existing behavior. If steering is unavailable, Bob's input remains Bob's when it starts a new execution. Conversation history stays shared; queueing does not isolate future turns from that history.

Automatic queue fallback is quiet, including when steering is unavailable or permissions differ. The runtime acknowledges queueing only when the user explicitly requests `/followup`:

> Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.

A queued or steered natural-language request to stop work does not confirm that the active turn stopped. Authorized stop commands use the separate cancellation path and report its actual outcome. Approval responses and explicit control commands retain their existing authorization; collaboration does not let another requester answer or cancel a pending question.

Visible user turns started through the `agent` RPC can also receive compatible
steering. A visible subagent announcement in a Control UI conversation requires a
result (`result-required`), so compatible human input can join that announcement's
active execution. The execution keeps its existing permissions and required result;
steering does not cancel the announcement. The human input keeps its author and
must be answered without duplicating the announcement. Use `/followup <message>`
for a separate turn instead.

Visible optional completion turns, including subagent completion and command
announcements, can accept compatible human input in a supporting embedded runtime.
Only runtime acceptance promotes that turn to require a visible reply. Hidden
turns, unsupported backends, and input requiring a different execution route leave
new human messages queued for a followup turn that can provide the required answer.
When steering is unavailable, the message runs automatically after the announcement
and its cleanup finish. The input remains queued and can still be canceled while
it waits.

The same signed-in person can steer after reconnecting without reproducing the original connection’s policy snapshot. Browser connections and display names do not define a new requester. The turn keeps its original authority, tool bindings, capabilities, approval destination, and reply routing; incoming caller differences do not expand or retarget them.

A verified personal requester can also guide that exact active session from another transport when an administrator has [linked their channel identity](/concepts/user-model#channel-identity-links). This works even if the arriving channel has fewer permissions or collaborative steering is disabled. Normal channel admission and session access still apply, and the incoming identity link must remain current through admission. Shared token/password ownership, display names, and contributor attribution do not establish that two senders are the same person.

Shared-credential WebUI/WebChat access has a separate owner-authorized continuation rule. In the exact same authorized active session, a channel participant can guide a turn started by Shared Owner, and Shared Owner can guide a channel turn. With collaborative steering enabled, ordinary channel admission suffices. With it disabled, the shared WebUI principal must have current `operator.admin` authority and the channel participant must be a current owner through `commands.ownerAllowFrom` or a linked personal identity with effective `operator.admin` and any required access grant. Pairing or channel allowlisting alone does not grant this exception. Owner or grant revocation before final admission blocks injection.

This does not link identities or identify the human behind a shared credential. Message authors stay distinct, and the active execution keeps its original requester, permissions, personal context, and delegation rules. Two different personal administrators do not gain this exception. Other different-person collaboration remains limited to the same channel, account, conversation, and thread.

Authorized cross-transport continuation also retains the active execution's task-suggestion tools and delivery setting. Channel guidance does not remove a WebUI execution's suggestion tools, and WebUI guidance does not add them to a channel execution. A queued new execution uses its submitting transport's setting.

This continuation rule applies to ordinary human guidance. It does not change questions, approvals, cancellation, or explicit cross-session `sessions_send` authorization. It does not bypass access revocation or authorize a new execution configuration. Explicit execution-setting changes, including a different workspace, execution policy, or selected model, can require a followup.

This also applies when a subagent completion resumes the conversation: compatible guidance from the same person joins that completion without changing its capabilities, rather than waiting for a separate turn.

An authenticated Gateway owner with `operator.admin` can steer an active automation,
loop, or visible subagent turn in the same authorized session, even when collaborative
steering is disabled. The incoming message keeps the owner's provenance and live
authorization; the running turn keeps its existing permissions and tool bindings.
This guidance does not answer pending questions under the automation's authority.
The owner-guidance exception does not apply to system-authored direct commands in
a parent conversation, including subagent completion reports. Those commands keep
normal requester-compatibility checks, so a browser correction to a system-owned
direct command stays a followup. A child's active execution is distinct from its
completion report to the parent.

Configured permissions are resolved when each new execution is admitted and remain stable for that execution. Human messages waiting for admission use current policy. Already admitted native work retains its prepared policy while waiting to run. A new delegation resolves current destination policy for the original requester, or for an explicitly selected authenticated participant on a tool that supports `user`. Native delegation retains the original requester. A delegation may intentionally use a more capable agent; selecting a participant does not establish that person’s intent or approval. Cancellation and current-owner checks still apply, and accepted asynchronous work survives normal source-turn completion.

This setting does not broaden cross-session authorization. Explicit `sessions_send(mode="steer")` keeps its requested operation: incompatible steering is refused with guidance to use `mode="followup"`, rather than silently queueing a different operation.

Automatic credential rotation and model fallback also retain the active turn.
New input can steer that turn while the selected model remains unchanged, fallback
is still allowed, and the applicable steering policy permits it. Selecting or locking a model
or pinning a different account can require a followup turn. Answers to a pending question still go to the question's original owner.

[Personal `USER.md` context](/concepts/user-model#personal-user-files-on-a-shared-gateway)
follows the session's assigned human owner, otherwise its authenticated human
creator. Collaboratively steered input retains the active turn's personal instructions; queued or collected messages keep the same session selection. Reassignment
takes effect on the next new turn; it does not replace the running turn's personal
instructions. Personal context selection does not grant tool permissions or
change the approval destination.

Accepted cross-session steering retains the selected sender's source authority
after the sending turn finishes. Access revocation can still block an input
before its transcript commit.

A visible message or send acknowledgment does not mean the active runtime has
consumed it. Gateway chat sends acknowledge saved input custody without waiting
for steering admission behind older queued messages or for the active turn to end.
Steering and followup delivery retain their original order, and later events report
the input's outcome. The Control UI shows specific notices when an accepted message is
waiting for worker setup or workspace sync.
A steer sent while a turn is creating its worktree or preparing its runtime stays
pending for that turn. Once the runtime is ready, OpenClaw checks whether it can
accept the input. If the turn ends or cannot accept it, the message stays queued
for a followup.
An input already accepted by an embedded run is settled promptly if preparation
ends before it can be consumed, such as when a policy hook blocks the run. Saved
interrupted input follows the existing recovery rules.
Messages waiting for a followup turn appear in the queue above the composer,
including when the Gateway queues a message that could not be steered. They stay
there across reconnects until consumed or canceled, without being sent again.

The `runId` returned by `chat.send` remains that input's public identity when
steering falls back to a followup. Queue admission does not complete it. Its
terminal event arrives when the followup execution finishes, with that
execution's success, failure, or cancellation outcome. A `collect` batch completes
every consumed input's `runId` with the batch's outcome. An input rejected,
canceled, or dropped before consumption, including queue overflow, receives its
terminal outcome immediately. Steering accepted into the active turn still
completes the input's `runId` after its transcript receipt, without completing the
active turn.

Use `followup` or `collect` when you want messages to queue by default instead of steering the active run. Use `interrupt` when the newest prompt should replace the active run.

## Canceling a pending steer

An authorized Gateway client can withdraw a message still waiting in the OpenClaw
runtime's steering queue or the followup queue, before delivery starts, with `chat.abort({ sessionKey,
runId })`. Use the `runId` returned by that message's `chat.send`. This withdraws
that message without stopping the active run or retrying it as a followup.

Once delivery starts, cancellation cannot guarantee withdrawal or undo completed
work. If delivery cannot be confirmed, OpenClaw reports the uncertainty and retains
the input without replaying it. An uncertain steering receipt does not stop the
active run or its running tools. Use `/stop` to stop that work explicitly.

## Debounce

The built-in queue debounce applies to queued `followup` and `collect` delivery. In `steer` mode with the native Codex harness, it also sets the quiet window before sending batched `turn/steer`. OpenClaw active steering does not use the debounce timer; at tool-launch and model boundaries it drains FIFO according to the runtime's configured steering drain mode.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
- [Codex harness runtime](/plugins/codex-harness-runtime) - `turn/steer` behavior on the native Codex harness
