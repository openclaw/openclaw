---
summary: "Dynamic tools, web search, image loading, turn liveness, and runtime boundaries"
read_when:
  - You want to know which OpenClaw tools reach a Codex turn
  - You are debugging turn liveness or parallel chats
  - You need the ownership split between OpenClaw and Codex
title: "Codex runtime behavior"
sidebarTitle: "Runtime behavior"
---

What the Codex harness owns during a turn, and what stays with OpenClaw. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Dynamic tools and web search

OpenClaw exposes `skills_search` and `skills_read` as host-owned dynamic tools
when eligible installed skills and tool policy permit them. Search includes
skills omitted from OpenClaw's bounded prompt directory. Reads use an exact
installed name and return complete instructions or an explicit refusal if the
turn's dynamic-tool output budget cannot hold them. These tools do not change
Codex's native `skills` namespace or install marketplace skills. See
[installed skill search](/tools/skills#search-installed-skills).

Codex dynamic tools default to `searchable` loading when the native surface is
enabled. When it is disabled, OpenClaw publishes allowed dynamic tools directly,
including session UI tools and managed shell paths. Tool policy, argument
validation, session authority, and effect ownership still apply. Dashboard and
widget actions use these session-bound tools; a shell CLI connection and device
pairing do not replace them. OpenClaw normally does
not expose dynamic tools that duplicate Codex-native workspace operations:
`read`, `write`, `edit`, `apply_patch`, `exec`, `process`,
`get_goal`, `create_goal`, `update_goal`, `dispatch_action`, `tool_describe`,
and `tool_search`. Goal operations stay native to Codex,
so OpenClaw does not project a second goal store into Codex turns. Most
remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, and `progress_card` are available through
Codex tool search under the `openclaw` namespace, keeping the initial model
context smaller. The restricted-turn shell fallback is the exception for
`exec` and `process` when a finite allowlist disables native Code Mode;
runtime allowlists and `codexDynamicToolsExclude` still apply.
Strict [`agent exec`](/cli/agent#agent-exec) runs also use OpenClaw's tools so
their process cleanup stays with the one-shot run owner.
When native shell remains active and Gateway access is policy-eligible,
OpenClaw instead publishes the distinct `gateway_exec` and `gateway_process`
names so native shell and the OpenClaw-managed environment path cannot be
confused.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool, use the `openclaw_direct` namespace instead. Codex treats that namespace
as `DirectModelOnly`, so those tools stay directly model-visible in normal and
code-mode-only threads rather than crossing nested Code Mode `tools.*` calls.

Web search uses Codex's hosted `web_search` tool by default when search is
enabled and no managed provider is selected. Native hosted search and
OpenClaw's managed `web_search` dynamic tool are mutually exclusive so
managed search cannot bypass native domain restrictions. OpenClaw uses the
managed tool when hosted search is unavailable, explicitly disabled, or
replaced by a selected managed provider. A custom provider can use Codex's
standalone `web.run` extension when it is the app-server's configured provider,
its native `model_providers.<id>.supports_standalone_web_search` setting is
`true`, and the capability RPC permits search. OpenClaw enables standalone
search only for that verified provider; ordinary OpenAI traffic keeps hosted
search. The provider must implement the standalone search endpoint as well as
inference; Responses compatibility alone does not establish support.
`tools.web.search.enabled: false`
disables both paths, as do tool-disabled LLM-only runs. Codex treats
`"cached"` as a preference and resolves it to live external access for
unrestricted app-server turns. Automatic managed fallback is blocked when
native `allowedDomains` are set so the allowlist cannot be bypassed.
Persistent effective search-policy changes rotate the bound Codex thread
before the next turn; transient per-turn restrictions use a temporary
restricted thread and preserve the existing binding for later resume.
Requester policy and parent lineage remain bound to preparation: revoking or
reassigning the requester before native thread or turn dispatch rejects the
operation before that request reaches Codex. This also applies to `/btw`. Hosted
search runs inside Codex; OpenClaw validates admission of the search-enabled
native turn, rather than receiving a separate callback for each hosted search.
Pending native supervision without a selected model has no hosted search tool.
Retry after the native session selects a model to prepare its search policy.
Missing prepared policy also disables hosted search; Codex does not resolve it
later while building native tools.

When a binding preserves its native model, `/btw` prepares model, credentials,
and search policy for that bound provider and model, even if the chat's outer
model differs. A native model change after preparation rejects the side question
before dispatch; retry to prepare for the current model.
Supervised native models use Codex's model and authentication ownership, including
models configured only in Codex; they do not require a host catalog entry or host
credentials. Side questions use reasoning capabilities from their selected model.

`sessions_yield`, `sessions_spawn`, and message-tool-only source replies stay
direct because they are turn-control or delegation contracts. Guidance uses
Codex's native `spawn_agent` for work using only Codex-native tools. New work
requiring OpenClaw tools goes through the available managed `sessions_spawn`
route from the start; existing native children stay with native collaboration.
See [dynamic tools](/plugins/codex-harness-reference/dynamic-tools) for runtime
selection. In Codex Code Mode, generic OpenClaw
dynamic-tool results are JSON text rather than JavaScript objects, so parse
JSON-looking results before reading fields. Codex also serializes nested
dynamic calls; submit several `sessions_spawn` calls in a bounded loop rather
than expecting `Promise.all` to launch them concurrently. Already-accepted
children can still overlap while later calls are submitted. See
[Swarm](/tools/swarm#use-swarm-from-other-harnesses) for a complete pattern.
Migrated heartbeat monitors use ordinary scheduled automation turns and their
configured delivery policy. The retired `heartbeat_respond` tool is not exposed.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when
debugging the full tool payload.

## Inspecting tool output

Long tool results have a collapsed preview in the Control UI. **Show full output**
opens the saved result as plain text; copy and download use that text, not the
preview. Reloading the conversation reads the same saved result. Inspection is
subject to the Gateway's message-size limits. Tool-result text is not secret-masked.
Tool-output inspection requests the supported maximum of 2,000,000 characters per
text field; a result that remains capped is explicitly marked unavailable.
A preview limit does not mean Codex truncated the model's input.

OpenClaw preserves the complete tool-response text exposed by Codex's
`rawResponseItem/completed` notification, including whitespace and Codex's own
truncation notices. Structured responses retain their text blocks as JSON;
non-text payloads are marked omitted rather than copied into the text inspector.
OpenClaw associates the response with its tool-call ID before checkpointing the result. If only an execution event is available, the result is
labeled as execution output instead. Code-mode response IDs are distinct from
nested command IDs.

If a native patch or command fails before Codex emits its native item, the mirror
can recover a failed `apply_patch` or `bash` receipt from a single-call Code Mode
wrapper with literal input and unmodified `text` output, including a local input
variable. A completed script can still contain a failed command: its structured
nonzero exit code owns that outcome. Existing native items retain their own IDs;
unsupported wrappers and unknown responses remain outer `exec` evidence.

Neither event proves the exact final model input. Codex can apply additional
history truncation and context normalization after constructing the response;
its app-server does not expose that final request representation here. OpenClaw
labels this limitation rather than treating raw stdout as model-visible output.

Older records with the `OpenClaw truncated Codex native tool output` notice lost
the omitted text before persistence. They explicitly show that the full output
is unavailable. The same limitation applies when only a bounded execution
stream was received and no complete response or completion output arrived.
Opening, copying, or downloading such a record cannot recover its missing text.

## Background text completions

With local stdio transport and the default `appServer.homeScope: "agent"`, Codex
completions for memory narratives and session titles run in a fresh private Codex
home and workspace. They retain the selected model and scoped
authentication, with a read-only sandbox and no model-callable tools, apps, or MCP
servers. Ordinary user and project hooks cannot enter that private process;
administrator-managed hooks remain active.

Private completions support directly executable launchers and Node script
wrappers. Inline shell/eval commands and ambiguous launcher arguments fail with
an isolation error; use a directly executable wrapper for those custom launches.

User-home mode retains the native Codex account, even when an OpenClaw auth
profile also exists. Stdio proxies and remote transports retain their configured
server. These connections keep their existing restricted completion behavior
and reject managed hooks when their isolation cannot be verified. Managed
requirements that force a conflicting tool capability still reject the completion.

## Image loader ownership

For image-capable models with Codex native tools enabled, Codex owns
`view_image` and OpenClaw suppresses its duplicate loader. The native Codex
schema accepts one local filesystem `path`. For text-only models, or when the
native tool surface is disabled, OpenClaw supplies `view_image` with its
`path`/`paths` schema and delegated vision route. Callers must use the schema
advertised for the active run.

When OpenClaw restores conversation history into a Codex thread, saved images
stay beside their original messages inside the quoted history. This includes
managed images saved with assistant answers when the selected model accepts
image input. Restoration verifies the owning agent, physical session, and
assistant source before reading the saved original. The current
request and its attachments follow that history, so a later text or voice turn
does not present old screenshots as newly attached images. If context limits
remove an image's original message, its image input is omitted too; the saved
transcript and attachment remain unchanged.

Sending another attachment does not suppress generated images from the final
reply. OpenClaw omits a generated image only when it can match confirmed delivery
of that image to the reply destination. A partial delivery with uncertain
attachment outcomes can leave a duplicate image rather than lose an unsent one.

## Turn liveness and timeouts

Codex owns provider-stream liveness and native turn completion. OpenClaw waits
for the exact `turn/completed` outcome rather than interrupting a quiet turn or
treating assistant output as completion. Malformed completion payloads do not end
the run: OpenClaw waits for a valid native outcome instead of inventing missing
items, tool arguments, or completion states. The existing
`agents.defaults.timeoutSeconds` limit is an elapsed execution budget per
attempt: progress does not reset it, and `0` means unlimited execution.
OpenClaw still bounds its own requests, dynamic tools, cancellation, and local
settlement. See [Timeouts](/plugins/codex-harness-reference#timeouts) for those
budgets, Stop and replay behavior, and Doctor migration of retired idle settings.

If the app-server connection is lost before the turn completes, the conversation
retains a visible failure outcome even when Codex already sent commentary or
partial output. Reloading the Control UI or opening the conversation on another
client preserves that outcome. The live error and saved notice both explain
that the task may still be running and tell you to check the conversation before
trying again. The original error remains in diagnostic details.
Check any command's effects before retrying: a
lost connection does not prove that its work stopped. A later turn can reconnect
to the app-server normally.

Failed app-server startup waits for child shutdown before returning its error.
If startup times out or is canceled during process registration, cleanup joins
that registration and closes any late child. Cleanup can extend beyond the
startup deadline. A registration failure keeps its specific error when it settles
during that cleanup, instead of becoming a generic initialization timeout.
Shared startup has its own deadline. Canceling a shared-client waiter leaves
service-owned startup running even if it was the only waiter. Later callers can
join it; once ready, an unused client retires after the idle grace. Isolated
startup remains caller-owned. See
[startup budgets](/plugins/codex-harness-reference/timeouts#timeouts).

Temporary capability, native-hook, and tool-catalog probes wait for their isolated
app-server to close before returning, including after a failed or timed-out read.
Probes using a shared connection release their lease so other work can continue.

OpenClaw preserves assistant text supplied with the initial native item and
reasoning supplied with a completed item, even when Codex sends no text deltas.
Completed items, including empty messages, reconcile the transcript with Codex's
final content. Raw provider copies cannot restore text that Codex removed. Messages
marked for asynchronous delivery remain separate from the final reply when
Codex repeats them in the turn-completion summary.

Reasoning streams to the Control UI as separate native items while a turn runs.
Completed items retain their place among commentary and tools in saved history;
OpenClaw does not combine the turn's reasoning into one message. The existing
`/reasoning on|off|stream` and **View → Reasoning** controls select visibility.
These are the reasoning summaries exposed by Codex, separate from assistant
commentary. Previously saved aggregate summaries remain in their original form.

## Cyber safety notices

The Control UI shows a notice above the composer when Codex reports cyber
safety buffering, a cyber-policy refusal, or a provider model reroute for
high-risk cyber activity. These notices use structured app-server events;
OpenClaw does not infer classifier activity from the assistant's wording.

Buffering means the provider is still processing the request. Its notice clears
when assistant output starts or the turn ends. A blocked notice remains until
the next turn or a session reset. A reroute notice reports the model selected
by the provider.

Gateway agent-event consumers receive these updates on the `notice` stream
with `phase: "provider_policy"`, `provider: "openai"`, `category: "cyber"`, and
a `state` of `buffering`, `blocked`, `fallback`, `escalated`, `unavailable`, or
`cleared`. Model fields are present when the upstream event provides them. A
suggested fallback model is informational and does not prove that the account
can use it.

## Automatic Daybreak escalation

When OpenAI returns a structured cyber-policy refusal, the default automatic policy
retries once with **Blue Access on the same model**. It does not choose a replacement
model or use the retiring Blue/Red model aliases. The native request changes only the
turn-scoped `cyberAccessProgram` to `daybreakBlue`; provider, model, runtime, account,
effort, and speed stay selected. Exact model pins and empty model fallback lists do
not disable this Access configuration retry.

Escalation stays scoped to work that was actually refused:

- Only the current attempt's structured OpenAI cyber refusal qualifies. Other providers,
  policy categories, and historical refusals do not trigger a retry.
- At most one escalated attempt runs per turn. A turn already using Blue or Red is not
  retried or downgraded; a second refusal stops.
- The attempt must be replay-safe. Sent messages, scheduled work, spawned sessions,
  native continuations, generated media, cancellation, timeout, and later failures keep
  their existing no-replay behavior.
- Every new turn starts with the session's selected Access setting. Neither the model
  nor Access override is permanently changed, and the user prompt is not mirrored into
  the transcript a second time. The refused turn remains in the native Codex thread.
- `plugins.entries.codex.config.appServer.cyberFailover.mode: "off"` disables this
  automatic retry. Doctor removes the retired `cyberFailover.model` setting and keeps
  `mode` and `cooloffMs`; ordinary configured model fallbacks remain separate.

Before `turn/start`, the request owner checks the same native client's authenticated
ChatGPT account and its model-specific `availableAccessPrograms`. Unknown or absent Blue
capability leaves the original refusal intact without sending a Blue request. This
integration does not support native API-key Access requests; use the OpenClaw Responses
runtime for Platform API-key access. Catalog metadata is a prerequisite, not permission
to ignore a later server denial or changed account.

A server authorization denial is remembered for the authenticated workspace/model for
`cooloffMs`, so sibling sessions do not repeat the failed Blue request. This process-local
record does not disable ordinary Standard requests. A separate workspace remains
independent, and expired records release automatically. If a failed retry has tool
activity, side effects, native continuation, or interruption, its own result and receipts
are retained rather than replaced with the original refusal.

## Parallel chats and thread ownership

Independent chats can share a Codex app-server and run concurrently. Resuming
an idle chat does not require unrelated chats, model discovery, or tool-catalog
reads to finish. OpenClaw coordinates its own lifecycle operations for each
native thread and preserves that thread's identity across ordinary resumes.
A closed, replaced, or retired client still cannot complete a stale handoff.
When native interruption and subscription cleanup are confirmed, stopping one
chat leaves other chats running on the shared client. A follow-up can resume the
stopped thread without waiting for those chats to finish.

If native children are still running when their parent stops or calls
`sessions_yield`, OpenClaw keeps the parent's subscription to observe their
results. The same conversation can accept another message after Codex confirms
that exact parent turn has ended. Child results stay attached to the original
session lifecycle; a reset, replaced binding, or revoked source cannot inherit
its retained authority.

Native child completion delivery stops permanently when its retry budget is
exhausted or requester recovery blocks it. OpenClaw retires that child turn's
pending assignment and follow-up receipt together, so later parent registrations
and Gateway restarts do not restart delivery. A bounded system note in the parent
transcript identifies the child, its status, and its result session key; a warning
records retirement even if the transcript note cannot be written. Other pending
turns of the same child remain independent. Parent subscription retention during
ordinary completion retries is unchanged.

If a chat's previous client was retired while other chats still use it, the
next turn waits for its exact thread to close or for that client to exit before
resuming. If a plugin reload missed the thread's closure notification, OpenClaw
reads the exact old client's thread status once. A matching `notLoaded` status
allows the handoff; a still-loaded thread keeps waiting. Native resume retains
its exclusive persistence writer lock. Stopping the waiting turn cancels its
read and wait without closing sibling sessions or a healthy new client. A
startup deadline also ends the wait, but retires the startup client.

Managed local connections share a bounded inference relay. Up to 16 request
preparations and uploads run at once, with another 16 waiting in arrival order.
Responses keep streaming after their upload capacity is released, so a long
response does not block a seventeenth chat or native child from starting.

The relay allows up to 80 combined HTTP operations and WebSocket connections,
with room for 16 pending or closing admissions. It retains up to 64 usable
WebSockets and reclaims the oldest completed idle connection when either
transport needs room. Active responses and newly opened connections awaiting
their first request are not evicted. HTTP connections close after each response;
native WebSocket reuse remains intact. Separately, each inference relay admits at
most 64 active root contexts. Additional turns wait in arrival order for a root
to be released; cancellation removes a waiting turn, and relay shutdown rejects
its waiters. Admission rechecks the turn and transport ownership before starting.
Debug logs identify the root limit and waiting count. A completed, failed,
aborted, or yielded turn releases its root; retained parent subscriptions and
prepared context do not occupy active roots. Transport capacity is not a count
of saved conversations.

A new WebSocket waits before opening its upstream connection; admission and its
handshake share a 10-second deadline. HTTP admission and queued WebSocket
uploads wait at most 30 seconds. Cancelled or superseded queued work does not
reach the provider. Already-started preparation and transport cleanup keep their
capacity until their owning operation settles.

These limits apply across chats and native child agents sharing the relay.
Queue capacity or deadline exhaustion returns a retryable busy response.
Sustained overload can still fail a turn after Codex exhausts its retries.

If an admitted WebSocket cannot connect upstream, the relay returns HTTP `502`;
an upstream handshake deadline returns `504`. These errors use a fixed message
without credentials or model content. Native Codex keeps control of retries and
HTTPS fallback. Provider HTTP failures retain their original status and body.

After a completed provider failure, you can continue in the same chat with its
existing configuration. OpenClaw retains the configured native thread, including
for `/codex resume` of that chat's already-bound thread. Native provider policy refusals
end the current attempt without a native retry. OpenClaw's configured cyber
fallback described above is a separate attempt. A later user message is a
separate turn; it does not supply a native policy override or user confirmation.

With Codex app-server `0.153.4`, first-time adoption or changed configuration of a
loaded failed thread still requires native unloading. OpenClaw preserves the
thread and reports missing configuration confirmation instead of assuming the
changes took effect. Existing active-turn and parent-controlled-thread checks
still apply.

This coordination does not make native configuration replacement atomic against
Codex-internal controllers. Native subagent reloads or another native controller
can operate outside OpenClaw's thread queue. Avoid concurrently reconfiguring the
same native thread through multiple controllers; observing native teardown alone
does not reserve it against a subsequent native reload.

## Runtime boundaries

Native provider throttling and overload retain their structured status whether
Codex rejects turn startup or reports a failed turn. Both paths use OpenClaw's
shared retry and failure guidance in channel chats and the Control UI. Temporary
throttling does not inherit a subscription usage-limit reset cooldown.

The Codex harness changes the low-level embedded agent executor only.

- OpenClaw dynamic tools are supported. Codex asks OpenClaw to execute
  those tools, so OpenClaw remains in the execution path.
- Codex-native shell, patch, MCP, and native app tools are owned by Codex.
  OpenClaw can observe or block selected native events through the
  supported relay, but it does not rewrite native tool arguments.
- `gateway_exec` and `gateway_process` are OpenClaw-owned dynamic tools. They
  deliberately re-enter Gateway exec preparation for agent-readable Secret
  Store environment and protected egress; those values never flow into Codex
  native shell.
- Codex owns native compaction. OpenClaw keeps a transcript mirror for
  channel history, search, `/new`, `/reset`, and future model or harness
  switching, but does not replace Codex compaction with an OpenClaw or
  context-engine summarizer.
  Completed commentary and tool activity are saved during the turn rather than
  waiting for its final answer, preserving completed work across Gateway interruption.
- Media generation, media understanding, TTS, approvals, and messaging-tool
  output continue through the matching OpenClaw provider/model settings.
- `tool_result_persist` applies to OpenClaw-owned transcript tool results,
  not Codex-native tool result records.

For hook layers, supported V1 surfaces, native permission handling, queue
steering, Codex feedback upload mechanics, and compaction details, see
[Codex harness runtime](/plugins/codex-harness-runtime).
