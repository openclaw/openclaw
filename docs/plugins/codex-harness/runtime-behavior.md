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

Codex dynamic tools default to `searchable` loading. OpenClaw normally does
not expose dynamic tools that duplicate Codex-native workspace operations:
`read`, `write`, `edit`, `apply_patch`, `exec`, `process`,
`get_goal`, `create_goal`, `update_goal`, `tool_call`, `tool_describe`,
`tool_search`, and `tool_search_code`. Goal operations stay native to Codex,
so OpenClaw does not project a second goal store into Codex turns. Most
remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, `progress_card`, and `heartbeat_respond` are available through
Codex tool search under the `openclaw` namespace, keeping the initial model
context smaller. The restricted-turn shell fallback is the exception for
`exec` and `process` when a finite allowlist disables native Code Mode;
runtime allowlists and `codexDynamicToolsExclude` still apply.
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
replaced by a selected managed provider. OpenClaw keeps Codex's standalone
`web.run` extension disabled because production app-server traffic rejects
its user-defined `web` namespace. `tools.web.search.enabled: false`
disables both paths, as do tool-disabled LLM-only runs. Codex treats
`"cached"` as a preference and resolves it to live external access for
unrestricted app-server turns. Automatic managed fallback fails closed when
native `allowedDomains` are set so the allowlist cannot be bypassed.
Persistent effective search-policy changes rotate the bound Codex thread
before the next turn; transient per-turn restrictions use a temporary
restricted thread and preserve the existing binding for later resume.

`sessions_yield`, `sessions_spawn`, and message-tool-only source replies stay
direct because they are turn-control or delegation contracts. Guidance still
prefers Codex's native `spawn_agent` as the primary Codex subagent surface,
while explicit OpenClaw or ACP delegation remains directly callable through
`sessions_spawn`. In Codex Code Mode, generic OpenClaw
dynamic-tool results are JSON text rather than JavaScript objects, so parse
JSON-looking results before reading fields. Codex also serializes nested
dynamic calls; submit several `sessions_spawn` calls in a bounded loop rather
than expecting `Promise.all` to launch them concurrently. Already-accepted
children can still overlap while later calls are submitted. See
[Swarm](/tools/swarm#use-swarm-from-other-harnesses) for a complete pattern.
Scheduled heartbeat user messages identify `heartbeat_respond` when structured
responses are enabled; the tool remains discoverable through Codex tool search.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when
debugging the full tool payload.

## Image loader ownership

For image-capable models with Codex native tools enabled, Codex owns
`view_image` and OpenClaw suppresses its duplicate loader. The native Codex
schema accepts one local filesystem `path`. For text-only models, or when the
native tool surface is disabled, OpenClaw supplies `view_image` with its
`path`/`paths` schema and delegated vision route. Callers must use the schema
advertised for the active run.

## Turn liveness and timeouts

Codex owns provider-stream liveness and native turn completion. OpenClaw waits
for the exact `turn/completed` outcome rather than interrupting a quiet turn or
treating assistant output as completion. The existing
`agents.defaults.timeoutSeconds` limit is an elapsed execution budget per
attempt: progress does not reset it, and `0` means unlimited execution.
OpenClaw still bounds its own requests, dynamic tools, cancellation, and local
settlement. See [Timeouts](/plugins/codex-harness-reference#timeouts) for those
budgets, Stop and replay behavior, and Doctor migration of retired idle settings.

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

OpenAI declines some defensive-cyber work on its general models and directs
approved workspaces to a Daybreak model instead. When a turn ends in a
cyber-policy refusal, OpenClaw retries it once on the configured Daybreak model
so the refused work reaches the tier allowed to answer it. This is on by
default and is configured under
`plugins.entries.codex.config.appServer.cyberFailover`.

Daybreak trails the general models in capability, so escalation stays scoped to
work that was actually refused:

- At most one escalated attempt per turn. A second refusal under Daybreak keeps
  the block and stops.
- A turn already running on the configured Daybreak model is never escalated.
- A turn that already acted is never retried. Escalation requires the attempt's
  own replay-safe verdict, so a turn refused after it sent a message, added a
  cron entry, spawned a session, started a native continuation, or generated
  media keeps its result. Cancellation, timeout, or a later failure also prevents
  escalation even if the result retains a refusal diagnostic.
- Only a refused turn is ever routed to Daybreak. Every turn starts on the model
  the session selected, and a turn that was not refused never reaches the weaker
  tier.
- The retry does not mirror the prompt into the transcript a second time. The
  refused attempt's own terminal row is discarded with its result rather than
  staged, so a successful escalation returns the Daybreak answer; the refused
  turn still exists upstream in the native Codex thread, which OpenClaw does not
  rewrite.
- Only OpenAI's own cyber refusal on the current attempt escalates. Another
  provider's refusal, another category, and a refusal inherited from an earlier
  turn all leave the result untouched.
- Escalation never changes the session's stored model selection, and the only
  retained state is the unauthorized-target record below, which is process-local
  rather than persisted.

Authorization stays server-owned. `model/list` advertises Daybreak to every
client, so catalog presence does not prove entitlement: an unentitled workspace
still receives `401`/`403` on use, and each such attempt costs the transport's
full reconnect ladder. OpenClaw therefore treats the retry itself as the only
evidence and reports an `unavailable` notice rather than a silent block. If the
fallback target is denied without tool activity, side effects, native
continuation, or interruption, OpenClaw keeps the original refusal even when
the fallback produced no assistant message. Otherwise, its result is preserved
so those facts reach the runner.

Because entitlement belongs to the authenticated workspace and the target model
rather than to any one conversation, an unauthorized target is remembered once
for every session under that workspace and cannot be displaced by session churn.
A separate workspace that is entitled keeps escalating normally, and the record
releases on its own once `cooloffMs` elapses. Only one probe runs at a time for a
given workspace and target, so sibling sessions refused at the same moment do not
each pay the reconnect ladder before the first result lands.

## Parallel chats and thread ownership

Independent chats can share a Codex app-server and run concurrently. Resuming
an idle chat does not require unrelated chats, model discovery, or tool-catalog
reads to finish. OpenClaw coordinates its own lifecycle operations for each
native thread and preserves that thread's identity across ordinary resumes.
A closed, replaced, or retired client still cannot complete a stale handoff.

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
