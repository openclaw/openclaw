---
summary: "Override the model, shape the prompt, and persist plugin-owned session state"
read_when:
  - You are overriding the provider or model for an agent turn
  - You are adding prompt context or narrowing the tool surface for a turn
  - You need authorized post-policy prompt enrichment
  - You are persisting session extensions or queuing next-turn injections
title: "Prompt and session hooks"
sidebarTitle: "Prompt and session"
---

Model resolution, prompt construction, finalization, and durable
plugin-owned session state. Part of the [Plugin hooks](/plugins/hooks) guide.

## Debug runtime hooks

Use `before_model_resolve` to switch provider or model for an agent turn - it
runs before model resolution. `llm_output` describes an attempt's output when
the runtime emits it; `assistantTexts` can be empty and `lastAssistant` absent,
so the event alone does not prove a successful final answer.

For proof of the effective session model, inspect runtime registrations, then
use `openclaw sessions` or the Gateway session/status surfaces. To debug
provider payloads, start the Gateway with `--raw-stream` and
`--raw-stream-path <path>` to write raw model stream events to a jsonl file.

## Prompt and model hooks

Use the phase-specific hooks for new plugins:

- `before_model_resolve`: receives only the current prompt and attachment
  metadata. Return `providerOverride` or `modelOverride`.
- `agent_turn_prepare`: receives the current prompt, prepared session
  messages, and queued injections consumed for this session.
  Return `prependContext` or `appendContext`.
- `before_prompt_build`: receives the current prompt and session messages.
  Return `prependContext`, `appendContext`, `systemPrompt`,
  `prependSystemContext`, `appendSystemContext`, or `toolsAllow`. `toolsAllow`
  can only narrow the host-resolved tool surface for the current turn; `[]`
  submits no optional tools, while omitting it leaves the existing surface unchanged.
  Restrictions returned by multiple hooks are intersected. The embedded runner
  and Copilot harness apply this field to their turn-scoped submitted tool
  surfaces. The Codex app-server harness rejects restrictive values because its
  dynamic tools are thread-scoped and Codex `turn/start` has no tool-surface
  override; use the embedded or Copilot runtime when a plugin requires this
  policy.
- `before_prompt_build` with `{ requiresToolAuthority: true }`: runs in a
  second, post-policy phase. Use it when prompt enrichment reads data through
  a tool-backed capability and the same turn must be allowed to call that
  tool. See [Authorized prompt
  enrichment](/plugins/hooks/prompt-and-session#authorized-prompt-enrichment).
- `heartbeat_prompt_contribution`: runs only for heartbeat turns and returns
  `prependContext` or `appendContext`. Intended for background monitors that
  need to summarize current state without changing user-initiated turns.

On the embedded and CLI prompt-preparation paths, ordering is: drain queued
injections → `agent_turn_prepare` → heartbeat contribution (if applicable) →
ordinary `before_prompt_build` → finalized tool policy → authorized prompt
enrichment. `agent_turn_prepare` and queued-injection draining are not currently
wired into the Codex or Copilot prompt paths.

For multiple registrations, the first defined provider/model override and
`systemPrompt` win. Context additions concatenate in priority order, and tool
restrictions intersect. A nested ordinary `before_prompt_build` dispatch on
the same runner is skipped while its outer dispatch is active; other hook
families and independent turns remain available.

Message-consuming prompt hooks receive a detached model-context snapshot. Mutating nested messages does not change the caller's history, including when a handler retains its input after returning. Registrations within one dispatch share that snapshot in priority order; prepare, ordinary prompt-build, authorized enrichment, and subsequent prompt rebuilds receive separate snapshots. Storage-only native prompt text and tool-result details are excluded from these snapshots.

### Authorized prompt enrichment

Register `before_prompt_build` with `requiresToolAuthority: true` when a plugin
must verify the finalized per-turn tool policy before retrieving context:

```typescript
api.on(
  "before_prompt_build",
  async (event, ctx) => {
    const authority = ctx.toolAuthority;
    if (!authority?.allows("memory_search")) {
      return;
    }

    const recalledContext = await recallForPrompt(event.prompt);
    authority.assertActive();
    return { prependContext: recalledContext };
  },
  { requiresToolAuthority: true },
);
```

The host excludes this handler from the ordinary prompt-build phase. After all
ordinary hooks and tool restrictions settle, a supported runtime invokes it
with `ctx.toolAuthority` bound to that exact active turn and finalized tool
surface. Embedded, CLI, Copilot, and Codex runtimes support this phase. If a
runtime cannot prove the authority, it skips the handler.

Treat `toolAuthority` as an ephemeral capability:

- `allows(toolName)` checks a canonical tool id against the finalized surface
  and also verifies that the capability is still active.
- `assertActive()` rejects after abort, cancellation, run replacement,
  lifecycle rotation, or hook dispatch completion. Call it after awaited work
  and before committing plugin-owned side effects.
- `fingerprint` is opaque cache-partitioning input. It is not a bearer token or
  authorization proof; never persist, transmit, or compare it as authority.
- Return only `prependContext` or `appendContext` from this phase. It cannot
  replace the system prompt or change `toolsAllow` after policy has settled.

The host revalidates authority after each awaited handler and discards stale
enrichment. A retained `toolAuthority` object fails closed after dispatch.

This option requires a host that implements the post-policy phase. Published
plugins must set `package.json` `openclaw.compat.pluginApi` to a range beginning
with the first OpenClaw version they build against for this contract. Older
hosts skip incompatible packages during discovery and reject incompatible
installs or updates. Do not publish a package that uses this option while
claiming compatibility with an older plugin API; an older host may otherwise
treat an unknown option as an ordinary pre-policy hook.

On the embedded and CLI runners, `before_agent_run` runs after prompt
construction and before model submission, including `llm_input` observation.
On the embedded path it also precedes prompt-local image loading. It receives
the current user input as `prompt`, plus loaded session history in `messages`
and the active system prompt. Return `{ outcome: "block", reason, message? }`
to stop the run before the model reads the prompt. `reason` is internal;
`message` is the user-facing replacement. Only `pass` and `block` outcomes are
supported; unsupported decision shapes fail closed.

When a run is blocked, OpenClaw stores only the replacement text in
`message.content` plus non-sensitive block metadata such as the blocking
plugin id and timestamp. The original user text is not retained in transcript
or future context. Internal block reasons are treated as sensitive and
excluded from transcript, history, broadcast, log, and diagnostics payloads.
Observability should use sanitized fields such as blocker id, outcome,
timestamp, or a safe category.

Hooks that expose `event.runId`, such as `agent_end` and
`before_agent_finalize`, receive it when OpenClaw can identify the active run;
the same value is also on `ctx.runId`. Prompt hooks do not all have an event
`runId` field, so use their typed context for correlation. Cron-driven
runs can also expose `ctx.jobId` (the originating cron job id) when supplied
by the emitter, so hooks can scope metrics, side effects, or state to a specific
scheduled job. Do not assume every agent event carries it. `ctx.jobId` is not
part of the `before_tool_call` tool context.

For channel-originated runs, `ctx.channel` and `ctx.messageProvider` identify
the provider surface such as `discord` or `telegram`, while `ctx.channelId` is
the conversation target identifier when OpenClaw can derive one from the
session key or delivery metadata.

When sender identity is available, agent hook contexts also include:

- `ctx.senderId` - channel-scoped sender ID (e.g. Feishu `open_id`, Discord
  user ID). Populated when the run originates from a user message with known
  sender metadata.
- `ctx.chatId` - transport-native conversation identifier (e.g. Feishu
  `chat_id`, Telegram `chat_id`). Populated when the originating channel
  provides a native conversation ID.
- `ctx.channelContext.sender.id` - the same sender ID as `ctx.senderId`, under
  a channel-owned object plugins can extend with channel-specific fields.
- `ctx.channelContext.chat.id` - the same conversation ID as `ctx.chatId`,
  under a channel-owned object plugins can extend with channel-specific
  fields.

Core only defines the nested `id` fields. Channel plugins that pass richer
sender or chat metadata through the inbound helper can augment
`PluginHookChannelSenderContext` or `PluginHookChannelChatContext` from
`openclaw/plugin-sdk/channel-inbound`:

```ts
declare module "openclaw/plugin-sdk/channel-inbound" {
  interface PluginHookChannelSenderContext {
    unionId?: string;
    userId?: string;
  }
}
```

Channel plugins pass those fields through the inbound SDK helper:

```ts
buildChannelInboundEventContext({
  // ...
  channelContext: {
    sender: { id: senderOpenId, unionId, userId },
    chat: { id: chatId },
  },
});
```

These fields are optional and absent for system-originated runs (heartbeat,
cron, exec-event).

`ctx.senderExternalId` remains as a deprecated source-compatibility field for
older plugins. Core does not populate it; new channel-specific sender
identities should live under `ctx.channelContext.sender` through module
augmentation.

`agent_end` is an observation hook. Channel-backed paths generally run
it fire-and-forget after the turn, while local one-shot paths can wait
for the hook promise before process cleanup so trusted plugins can flush
terminal observability or capture state. The hook runner applies a 30 second
default per-handler timeout so a wedged plugin or embedding endpoint cannot
leave the hook promise pending forever. A timeout is logged and OpenClaw continues; it does not
cancel plugin-owned network work unless the plugin also uses its own abort
signal.

Use `model_call_started` and `model_call_ended` for provider-call telemetry
that should not receive raw prompts, history, responses, headers, request
bodies, or provider request IDs. These hooks include stable metadata such as
`runId`, `callId`, `provider`, `model`, optional `api`/`transport`, terminal
`durationMs`/`outcome`, and `upstreamRequestIdHash` when OpenClaw can derive a
bounded provider request-id hash. When the runtime has resolved
context-window metadata, the hook event and context also include
`contextTokenBudget`, the effective token budget after model configuration,
fixed model contracts, and runtime discovery, plus `contextWindowSource` and
`contextWindowReferenceTokens` when a lower cap was applied.

These provider-call hooks are currently emitted by the embedded model-call
path. A harness exposing `llm_input` / `llm_output` does not automatically
expose the same provider-call telemetry. In external harnesses, LLM events
describe adapter-visible input and output, not necessarily the raw provider
request or complete native history.

`before_agent_finalize` runs only when a harness is about to accept a natural
final assistant answer. It is not the `/stop` cancellation path and does not
run when the user aborts a turn. Return `{ action: "revise", reason }` to ask
the harness for one more model pass before finalization, `{ action:
"finalize", reason? }` to force finalization, or omit a result to continue.
Handlers have a 15s default budget; on timeout, OpenClaw logs the failure and
keeps decisions from other handlers. With no revision decision, normal
finalization continues. Multiple `revise` reasons are combined; any `finalize`
decision overrides revision requests. This hook requires a finalization
integration: the embedded runner and native hook relay provide it, but the
Copilot harness does not currently dispatch it.
Codex native `Stop` hooks are relayed into this hook as OpenClaw
`before_agent_finalize` decisions.

When returning `action: "revise"`, plugins can include `retry` metadata to
bound repeated revision requests within a run:

```typescript
type BeforeAgentFinalizeRetry = {
  instruction: string;
  idempotencyKey?: string;
  maxAttempts?: number;
};
```

`instruction` is appended to the revision reason sent to the harness.
`idempotencyKey` lets the host count retries across equivalent finalize
decisions within a run; without a key, it hashes the instruction.
`maxAttempts` defaults to one extra pass for that key. Use a plugin-specific
key to avoid sharing a budget with another plugin. A harness can apply a
tighter overall revision limit; the embedded runner allows at most three.

Conversation access and prompt mutation have separate permission gates; see
[Permissions and scope](/plugins/hooks#permissions-and-scope) before enabling these hooks.

### Session extensions and next-turn injections

Workflow plugins can persist small JSON-compatible session state with
`api.session.state.registerSessionExtension(...)` and update it through the
Gateway `sessions.pluginPatch` method. Session rows project registered
extension state through `pluginExtensions`, letting Control UI and other
clients render plugin-owned status without learning plugin internals.
`api.registerSessionExtension(...)` still works but is deprecated in favor of
the `api.session.state` namespace.

Use `api.session.workflow.enqueueNextTurnInjection(...)` when a plugin needs
durable context queued for the next prompt build (the top-level
`api.enqueueNextTurnInjection(...)` is a deprecated alias with the same
behavior). On the embedded and CLI prompt-preparation paths, OpenClaw drains
queued injections before prompt hooks. It drops expired entries and entries
whose plugin is inactive or has prompt injection disabled. `idempotencyKey`
deduplicates unexpired pending entries for the same plugin and session; the
key can be reused after consumption. Drained entries are reused across retries
within the active run, but consuming an entry is not a receipt that the model
saw it: a later failure can prevent submission. This is the right seam for
approval resumes, policy summaries, background monitor
deltas, and command continuations that should be visible to the model on the
next turn but should not become permanent system prompt text.

Pass `agentId` with an unscoped `sessionKey`, such as `global`, when multiple
agents are configured. Enqueueing, consumption, and plugin session state stay in
that agent's store; the owner selector is not part of the persisted injection.

Cleanup semantics are part of the contract. Session extension cleanup and
runtime lifecycle cleanup callbacks receive `reset`, `delete`, `disable`, or
`restart`. The host removes the owning plugin's persistent session extension
state and pending next-turn injections for reset/delete/disable; restart
keeps durable session state while cleanup callbacks let plugins release
scheduler jobs, run context, and other out-of-band resources for the old
runtime generation.

Disable cleanup preserves model-locked sessions owned by that plugin's
harness. Restart preserves extension state and pending injections, but can
clear stale promoted top-level session fields.
