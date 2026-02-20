---
summary: "Bind Discord threads to subagent sessions — zoom in/out UX for direct subagent interaction"
owner: "onutc"
status: "draft"
last_updated: "2026-02-20"
title: "Thread-Bound Subagents"
---

# Thread-Bound Subagents

## 1. Problem and goal

When the main agent spawns subagents (via `sessions_spawn`), the user has no direct way to interact with them. Subagents run in the background and announce results back to the parent session. If a subagent is doing something wrong mid-task, the only options are `subagents steer` (indirect, parent-mediated) or `subagents kill`.

The goal is to let users "zoom in" to a subagent session directly from Discord by binding a thread to that session. Messages in the thread route to the subagent, not the main agent. Subagent responses appear in the thread with a distinct identity (custom name/avatar via webhooks). The user can zoom back out at any time.

## 2. Scope and boundaries

- Discord-only for v1. Other surfaces (Telegram, Slack) are out of scope.
- Builds on existing primitives: `sessions_send`, `sessions_spawn`, `subagents`, Discord threads, Discord webhooks.
- Does not require changes to the ACP protocol or subagent runtime.
- Does not create new bot accounts or Discord applications.
- Does not change how `sessions_spawn` works internally — this is a routing/UX layer on top.

## 3. Concepts

### Thread-session binding

A mapping between a Discord thread ID and a subagent session key. While a binding is active, messages in the thread bypass the main agent and route directly to the bound session.

### Focus / unfocus

The user action of binding (focus) or unbinding (unfocus) a thread to a subagent. This can be triggered by:

- A slash command (`/focus <subagent-label>`)
- A tool call from the main agent (`message.thread-create` + bind)
- An automatic bind when `sessions_spawn` is called with a `thread: true` option

### Webhook persona

Each subagent posts to Discord via a webhook with a custom username and avatar, so the user can visually distinguish which agent is speaking. The main agent keeps its normal bot identity.

## 4. Architecture

### 4.1 Binding table

A new in-memory (and optionally persisted) mapping:

```
threadId → {
  sessionKey: string,
  agentId: string,
  label: string,
  webhookId: string,
  webhookToken: string,
  boundAt: timestamp,
  boundBy: userId
}
```

Stored in the gateway process. Persisted to disk for crash recovery (same pattern as session state).

### 4.2 Message routing

The Discord inbound message handler currently routes all messages to the main agent session. With thread bindings:

1. Message arrives in a Discord thread.
2. Check binding table for `threadId`.
3. If bound → route to `sessions_send(sessionKey, message)` instead of main agent.
4. If not bound → normal routing (main agent).

Mentions of the bot in a bound thread still go to the subagent, not the main agent.

### 4.3 Outbound response routing

When a bound subagent session produces output:

1. Look up the binding by `sessionKey`.
2. If a binding exists → post to the thread via webhook (custom name/avatar).
3. If no binding → normal announce-back-to-parent behavior.

### 4.4 Webhook management

- Create one webhook per guild (or per channel) on first use. Reuse it for all subagent personas.
- Each message sent through the webhook specifies `username` and `avatar_url` per the subagent's identity.
- Webhook is created via Discord API (`POST /channels/{channelId}/webhooks`).
- Webhook ID/token cached in binding table.

### 4.5 Lifecycle

#### Binding

```
User: /focus codex-task-42
→ Find subagent session by label "codex-task-42"
→ Create Discord thread (or use existing)
→ Create/reuse webhook for the channel
→ Store binding: threadId → sessionKey
→ Post intro message in thread via webhook: "Codex session active. Messages here go directly to the agent."
```

#### Unbinding

Triggered by:

- `/unfocus` in the thread
- Subagent session completing (cleanup: "delete")
- Subagent session being killed (`subagents kill`)
- Thread being archived/deleted

On unbind:

- Remove binding from table.
- Post farewell message: "Session ended. Messages here will no longer be routed."
- Optionally archive the thread.

#### Subagent completion

When a subagent finishes its task:

- If bound to a thread → post final result in the thread AND announce to parent.
- Unbind the thread.
- If `cleanup: "keep"` → thread stays open, user can re-bind later.

## 5. User interface

### Slash commands

| Command          | Description                                      |
| ---------------- | ------------------------------------------------ |
| `/focus <label>` | Bind current or new thread to a subagent session |
| `/unfocus`       | Unbind the current thread                        |
| `/agents`        | List active subagents with their thread bindings |

### Main agent tool integration

The main agent can also create bindings programmatically:

```js
// Spawn a subagent and immediately bind it to a thread
sessions_spawn({ task: "...", label: "codex-refactor" });
message({ action: "thread-create", threadName: "codex-refactor" });
// New: bind the thread to the spawned session
```

This could be a new parameter on `sessions_spawn`:

```js
sessions_spawn({
  task: "...",
  label: "codex-refactor",
  thread: true, // auto-create and bind a Discord thread
});
```

### Visual indicators

- Thread name includes agent identity: `🤖 codex-refactor`
- Webhook messages show agent name and distinct avatar
- Status messages on bind/unbind/completion

## 6. Implementation layers

### Layer 1: Binding table and message routing

- Add `ThreadBindingManager` to gateway
- Hook into Discord inbound message handler
- Route bound-thread messages to `sessions_send`
- Route unbound-thread messages normally

### Layer 2: Webhook outbound

- Webhook creation and caching
- Subagent responses posted via webhook with persona
- Fallback to normal bot message if webhook fails

### Layer 3: Slash commands

- Register `/focus`, `/unfocus`, `/agents`
- Permission checks (only the user who bound can unbind, or admins)

### Layer 4: Lifecycle automation

- Auto-unbind on session completion/kill
- Auto-bind via `sessions_spawn({ thread: true })`
- Thread archival on unbind
- Crash recovery (reload bindings from disk on gateway restart)

### Layer 5: Agent-side awareness

- Subagent system prompt includes context about being in a direct thread
- Parent agent notified when user focuses/unfocuses a subagent
- Parent can still see subagent output via `sessions_history`

## 7. Open questions

1. **Thread creation**: should `/focus` always create a new thread, or can it bind to an existing one?
2. **Multiple bindings**: can the same subagent be bound to multiple threads (e.g. cross-channel)?
3. **Permission model**: who can focus/unfocus? Only the spawner? Any user in the channel?
4. **Rate limits**: Discord webhook rate limits (30/min per channel). Sufficient for most agent output but could be an issue for verbose agents.
5. **Thread vs channel**: should we support binding to a full channel instead of a thread?
6. **Bidirectional tool access**: should the subagent get access to `message` tool scoped to its thread?

## 8. Dependencies

- Discord webhook API access (bot needs `MANAGE_WEBHOOKS` permission)
- Existing: `sessions_send`, `sessions_spawn`, `subagents`, `thread-create`, `thread-reply`
- Gateway message routing hooks (need to identify the right interception point)

## 9. Risks

- **Webhook rate limits** could throttle verbose agents. Mitigation: batch/buffer messages.
- **Thread proliferation** if users spawn many subagents. Mitigation: auto-archive on unbind.
- **Stale bindings** if gateway crashes without cleanup. Mitigation: persist bindings, validate on restart.
- **Confused routing** if user expects main agent in a thread but it's bound. Mitigation: clear visual indicators, `/unfocus` always available.

## 10. Exact implementation touchpoints

### 10.1 Binding table bootstrap and persistence

| Hook point                                 | Exact location                                                                                                                                                                                                                      | What to add/modify                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| State dir resolution                       | `src/config/paths.ts:60` (`resolveStateDir`)                                                                                                                                                                                        | Use this for the binding file root so behavior matches existing session/subagent state resolution.                                           |
| JSON persistence primitives                | `src/infra/json-file.ts:4` (`loadJsonFile`), `src/infra/json-file.ts:16` (`saveJsonFile`)                                                                                                                                           | Reuse these for binding table disk IO (atomic-enough write style + `0600` file mode).                                                        |
| Existing persisted-store pattern to mirror | `src/agents/subagent-registry.store.ts:44` (`resolveSubagentRegistryPath`), `src/agents/subagent-registry.store.ts:48` (`loadSubagentRegistryFromDisk`), `src/agents/subagent-registry.store.ts:119` (`saveSubagentRegistryToDisk`) | Implement the same pattern for thread bindings: versioned payload + migration-friendly loader + save on mutation.                            |
| Discord provider boot path                 | `src/discord/monitor/provider.ts:548` (`createDiscordMessageHandler({...})`) and `src/discord/monitor/provider.ts:431` (`createDiscordNativeCommand({...})`)                                                                        | Instantiate one binding manager per account in `monitorDiscordProvider` and inject it into both inbound text and native slash-command flows. |

**Recommended binding file location**

- Persist at: `path.join(resolveStateDir(process.env), "discord", "thread-bindings.json")`.
- Canonical persisted shape (versioned):

```ts
{
  version: 1,
  bindings: {
    [threadId: string]: {
      accountId: string,
      channelId: string,
      threadId: string,
      sessionKey: string,
      agentId: string,
      label?: string,
      webhookId?: string,
      webhookToken?: string,
      boundBy: string,
      boundAt: number,
    }
  }
}
```

- In-memory indexes should be:
  - `byThreadId: Map<string, ThreadBindingRecord>`
  - `bySessionKey: Map<string, Set<string>>` (for fast unbind on completion/kill)

### 10.2 Inbound routing hooks (user -> subagent)

| Hook point                          | Exact location                                                                                                                                                                                | What to add/modify                                                                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message handler dependency shape    | `src/discord/monitor/message-handler.ts:14` (`type DiscordMessageHandlerParams`), `src/discord/monitor/message-handler.ts:19` (`createDiscordMessageHandler`)                                 | Add `threadBindings: ThreadBindingManager` to params and pass it through both `preflightDiscordMessage(...)` calls at `:63` and `:94`.                                                                                                                         |
| Preflight input/output typing       | `src/discord/monitor/message-handler.preflight.types.ts:84` (`DiscordMessagePreflightParams`), `src/discord/monitor/message-handler.preflight.types.ts:17` (`DiscordMessagePreflightContext`) | Add binding manager on input and resolved binding metadata on output (for example `threadBinding`, `boundSessionKey`, `boundAgentId`).                                                                                                                         |
| Route resolution interception       | `src/discord/monitor/message-handler.preflight.ts:243` (`const route = resolveAgentRoute({...})`)                                                                                             | Before/around this line, resolve binding by current thread id (`messageChannelId` when in thread). If bound, override effective session routing to bound subagent session key while keeping existing allowlist/auth checks intact.                             |
| Preflight context return            | `src/discord/monitor/message-handler.preflight.ts:602` (`return { ... }`)                                                                                                                     | Include bound-thread fields in returned context so `processDiscordMessage` can set final inbound context correctly.                                                                                                                                            |
| Final inbound context for agent run | `src/discord/monitor/message-handler.process.ts:518` (`finalizeInboundContext({...})`)                                                                                                        | Set `SessionKey` to bound subagent session when binding exists (before fallback to `autoThreadContext` / `threadKeys`). Also add `MessageThreadId` (currently missing in Discord path) so downstream routing/hook/session logic receives the actual thread id. |
| Session key assignment line         | `src/discord/monitor/message-handler.process.ts:526` (`SessionKey: autoThreadContext?.SessionKey ?? threadKeys.sessionKey`)                                                                   | Change to `SessionKey: boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey`.                                                                                                                                                             |
| Thread metadata propagation         | `src/auto-reply/reply/dispatch-from-config.ts:181`, `src/auto-reply/reply/dispatch-from-config.ts:217`, `src/auto-reply/reply/dispatch-from-config.ts:268`                                    | These already forward `ctx.MessageThreadId`; Discord must populate it in `finalizeInboundContext` for correct thread-aware hooks and routed replies.                                                                                                           |
| Session persistence of thread route | `src/auto-reply/reply/session.ts:211` (`resolveThreadFlag`), `src/auto-reply/reply/session.ts:272` (`lastThreadIdRaw`), `src/auto-reply/reply/session.ts:311` (`deliveryContext`)             | No logic change required if `MessageThreadId` is set correctly; these lines will then persist thread delivery context for follow-up routing.                                                                                                                   |

**Specific imports to add in this area**

- `src/discord/monitor/message-handler.preflight.ts`: import `resolveAgentIdFromSessionKey` from `../../routing/session-key.js` to derive effective agent id from a bound session key.
- `src/discord/monitor/message-handler.preflight.ts`: import binding manager types/helpers from the new thread-binding module.

### 10.3 Native slash-command routing hooks (for `/focus`, `/unfocus`, `/agents`)

| Hook point                           | Exact location                                                                              | What to add/modify                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Native command constructor signature | `src/discord/monitor/native-command.ts:407` (`createDiscordNativeCommand(params)`)          | Add `threadBindings` to params; wire from provider at `src/discord/monitor/provider.ts:431`.                                       |
| Slash interaction dispatch entry     | `src/discord/monitor/native-command.ts:481` (`dispatchDiscordCommandInteraction`)           | Resolve binding for thread interactions (`rawChannelId` when `isThreadChannel`) and compute effective target session from binding. |
| Slash route lookup                   | `src/discord/monitor/native-command.ts:725` (`resolveAgentRoute({...})`)                    | Keep for auth/policy fallback, but override effective session target when binding exists.                                          |
| Slash inbound context assembly       | `src/discord/monitor/native-command.ts:743` (`finalizeInboundContext({...})`)               | Set `SessionKey` and `CommandTargetSessionKey` to bound session when present; set `MessageThreadId` for thread commands.           |
| Current slash session keys           | `src/discord/monitor/native-command.ts:755` and `src/discord/monitor/native-command.ts:756` | Replace current defaults with bound-session values when bound; fallback to existing behavior otherwise.                            |

### 10.4 Outbound routing hooks (subagent -> thread)

| Hook point                                                     | Exact location                                                                                  | What to add/modify                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord reply delivery call site                               | `src/discord/monitor/message-handler.process.ts:615` (`deliverDiscordReply({...})`)             | Pass bound-thread identity data (or at minimum session/thread binding metadata) so delivery layer can decide webhook-vs-bot send path.                                                                                                                    |
| Discord reply delivery function                                | `src/discord/monitor/reply-delivery.ts:10` (`deliverDiscordReply(params)`)                      | Extend params with binding/persona info; route through webhook send when session is thread-bound.                                                                                                                                                         |
| Current bot-send callsites                                     | `src/discord/monitor/reply-delivery.ts:49`, `:74`, `:83`, `:94`, `:102`                         | Replace direct `sendMessageDiscord(...)` usage with a small helper that chooses webhook send for bound sessions and falls back to `sendMessageDiscord`.                                                                                                   |
| Existing send primitive                                        | `src/discord/send.outbound.ts:104` (`sendMessageDiscord`)                                       | Keep as fallback; add a webhook-specific sender in a Discord send module and call it from `reply-delivery.ts` when bound.                                                                                                                                 |
| Generic outbound adapter (optional but recommended for parity) | `src/channels/plugins/outbound/discord.ts:11` and `src/channels/plugins/outbound/discord.ts:31` | This adapter currently ignores `threadId`/`identity`; update to consume both from `ChannelOutboundContext` (`src/channels/plugins/types.adapters.ts:78`) similarly to Slack adapter behavior (`src/channels/plugins/outbound/slack.ts:61`, `:80`, `:96`). |

### 10.5 Lifecycle hooks (auto-unbind, kill, completion)

| Hook point                            | Exact location                                                                                                                                                         | What to add/modify                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------- |
| Completion event listener             | `src/agents/subagent-registry.ts:273` (`ensureListener`), especially `:295-317`                                                                                        | On `phase === "end"                                                                                                                                      |     | "error"`, call `threadBindings.unbindBySessionKey(entry.childSessionKey)` before/alongside cleanup announce flow. |
| Gateway wait completion fallback      | `src/agents/subagent-registry.ts:554` (`waitForSubagentCompletion`) and `:604`                                                                                         | Mirror unbind-by-session-key here too, since this path handles cross-process completion.                                                                 |
| Kill path in registry                 | `src/agents/subagent-registry.ts:716` (`markSubagentRunTerminated`)                                                                                                    | Unbind all thread bindings for the terminated child session key(s).                                                                                      |
| Kill command user path                | `src/auto-reply/reply/commands-subagents.ts:341` (kill branch) and `:395` (`markSubagentRunTerminated`)                                                                | No new lookup needed if registry kill path unbinds; this call will trigger auto-unbind transitively.                                                     |
| Spawn origin capture (thread context) | `src/agents/subagent-spawn.ts:81` (`requesterOrigin`), `src/agents/subagent-spawn.ts:255` (RPC `threadId`), `src/agents/subagent-spawn.ts:284` (`registerSubagentRun`) | Keep/extend this for `sessions_spawn({ thread: true })` so initial requester origin includes thread metadata and lifecycle cleanup can map back cleanly. |
| Spawn tool schema                     | `src/agents/tools/sessions-spawn-tool.ts:8` (`SessionsSpawnToolSchema`) and `src/agents/subagent-spawn.ts:20` (`SpawnSubagentParams`)                                  | Add optional `thread: boolean` and carry to spawn flow so spawn can auto-create + bind thread after run registration succeeds.                           |

### 10.6 Slash command registration: exact path and insertion points

1. Add command definitions in `src/auto-reply/commands-registry.data.ts:131` (`buildChatCommands`) using `defineChatCommand({...})` entries near existing `subagents` command at `:266`.
2. If Discord-specific naming overrides are needed, add to `NATIVE_NAME_OVERRIDES` in `src/auto-reply/commands-registry.ts:121`.
3. Native specs are generated by `listNativeCommandSpecsForConfig(...)` at `src/auto-reply/commands-registry.ts:168`.
4. Discord provider pulls these specs at `src/discord/monitor/provider.ts:411`, builds runtime commands at `src/discord/monitor/provider.ts:431`, and deploys at `src/discord/monitor/provider.ts:527` via `deployDiscordCommands(...)` defined at `src/discord/monitor/provider.ts:120`.
5. Native command execution enters `createDiscordNativeCommand` (`src/discord/monitor/native-command.ts:407`) and dispatches via `dispatchDiscordCommandInteraction` (`src/discord/monitor/native-command.ts:481`).
6. Command handler implementation should be added in `src/auto-reply/reply/commands-subagents.ts:236` (`handleSubagentsCommand`) because it already has:
   - requester session resolution (`resolveRequesterSessionKey` at `:136`),
   - subagent target resolution (`resolveSubagentTarget` at `:152`),
   - existing command prefix parsing (`handledPrefix` at `:241-249`).
7. Extend command prefix constants at `src/auto-reply/reply/commands-subagents.ts:48-52` and action parsing blocks (`:260+`) to handle `/focus`, `/unfocus`, `/agents` directly.

### 10.7 Data flow (exact runtime path)

**Inbound: user message -> bound subagent session**

1. Discord gateway event enters `DiscordMessageListener.handle(...)` at `src/discord/monitor/listeners.ts:87`.
2. `createDiscordMessageHandler` preflights the event at `src/discord/monitor/message-handler.ts:63` / `:94`.
3. `preflightDiscordMessage` resolves thread and route at `src/discord/monitor/message-handler.preflight.ts:219-255`; binding lookup is inserted here.
4. `processDiscordMessage` builds `ctxPayload` via `finalizeInboundContext(...)` at `src/discord/monitor/message-handler.process.ts:518`, with bound `SessionKey` (`:526`) and `MessageThreadId`.
5. `dispatchInboundMessage(...)` at `src/auto-reply/dispatch.ts:35` runs the normal agent pipeline using that bound session key.
6. Replies are delivered back through `deliverDiscordReply(...)` at `src/discord/monitor/message-handler.process.ts:615`.

**Outbound: subagent response -> Discord thread**

1. Reply payload enters `deliverDiscordReply(params)` at `src/discord/monitor/reply-delivery.ts:10`.
2. Delivery helper checks `threadBindings.getBySessionKey(ctxPayload.SessionKey)` (new) and chooses:
   - webhook send with persona when bound,
   - existing `sendMessageDiscord(...)` fallback (`src/discord/monitor/reply-delivery.ts:49` et al).
3. For completion/kill cleanup, subagent lifecycle updates in `src/agents/subagent-registry.ts:273`, `:554`, and `:716` trigger `unbindBySessionKey(...)` so bindings do not outlive the run.

### 10.8 Minimal import/signature changes checklist

- `src/discord/monitor/provider.ts`
  - add `import { createThreadBindingManager } from "./thread-bindings.js"` (new module)
  - pass `threadBindings` into both `createDiscordMessageHandler` and `createDiscordNativeCommand`
- `src/discord/monitor/message-handler.ts`
  - extend `DiscordMessageHandlerParams` with `threadBindings`
- `src/discord/monitor/message-handler.preflight.types.ts`
  - extend `DiscordMessagePreflightParams` and `DiscordMessagePreflightContext` with binding fields
- `src/discord/monitor/message-handler.preflight.ts`
  - add binding lookup + `resolveAgentIdFromSessionKey` import
- `src/discord/monitor/message-handler.process.ts`
  - use bound session key in `finalizeInboundContext` and add `MessageThreadId`
- `src/discord/monitor/native-command.ts`
  - extend `createDiscordNativeCommand(params)` and `dispatchDiscordCommandInteraction` for bound thread routing
- `src/auto-reply/commands-registry.data.ts`
  - add `focus` / `unfocus` / `agents` command definitions in `buildChatCommands`
- `src/auto-reply/reply/commands-subagents.ts`
  - extend prefix/action parser and implement focus/unfocus/agents behavior using existing subagent lookup helpers
