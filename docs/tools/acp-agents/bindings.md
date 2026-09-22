---
summary: "Bind a conversation or thread to an ACP session, and configure persistent bindings[] entries"
title: "ACP agents bindings"
read_when:
  - Binding a message-channel conversation to a persistent ACP session
  - Setting up conversation-bound ACP sessions on messaging channels
  - You are configuring top-level bindings[] entries with type acp
---

## Bound sessions

### Mental model

- **Chat surface** - where people keep talking (Discord channel, Telegram topic, iMessage chat).
- **ACP session** - the durable Codex/Claude/Gemini runtime state OpenClaw routes to.
- **Child thread/topic** - an optional extra messaging surface created only by `--thread ...`.
- **Runtime workspace** - the filesystem location (`cwd`, repo checkout, backend workspace) where the harness runs. Independent of the chat surface.

### Current-conversation binds

`/acp spawn <harness> --bind here` pins the current conversation to the
spawned ACP session - no child thread, same chat surface. OpenClaw keeps
owning transport, auth, safety, and delivery. Follow-up messages in that
conversation route to the same session; `/new` and `/reset` reset the session
in place; `/acp close` removes the binding.

Examples:

```text
/codex bind                                              # native Codex bind, route future messages here
/codex model gpt-5.4                                     # tune the bound native Codex thread
/codex stop                                              # control the active native Codex turn
/acp spawn codex --bind here                             # explicit ACP fallback for Codex
/acp spawn codex --thread auto                           # may create a child thread/topic and bind there
/acp spawn codex --bind here --cwd /workspace/repo       # same chat binding, Codex runs in /workspace/repo
```

<AccordionGroup>
  <Accordion title="Binding rules and exclusivity">
    - `--bind here` and `--thread ...` are mutually exclusive.
    - `--bind here` only works on channels that advertise current-conversation binding; OpenClaw returns a clear unsupported message otherwise. Bindings persist across gateway restarts.
    - On Discord, `spawnSessions` gates child thread creation for `--thread auto|here` - not `--bind here`.
    - If you spawn to a different ACP agent without `--cwd`, OpenClaw inherits the **target agent's** workspace by default. Missing inherited paths (`ENOENT`/`ENOTDIR`) fall back to the backend default; other access errors (e.g. `EACCES`) surface as spawn errors.
    - Gateway management commands stay local in bound conversations - `/acp ...` commands are handled by OpenClaw even when normal follow-up text routes to the bound ACP session; `/status` and `/session` also stay local whenever command handling is enabled for that surface.

  </Accordion>
  <Accordion title="Thread-bound sessions">
    When thread bindings are enabled for a channel adapter:

    - OpenClaw binds a thread to a target ACP session.
    - Follow-up messages in that thread route to the bound ACP session.
    - ACP output is delivered back to the same thread.
    - `/session unbind`, close, archive, idle timeout, or max-age expiry removes the binding. `/session unbind` detaches only the current conversation and leaves the ACP session running.
    - `/acp close`, `/acp cancel`, `/acp status`, `/status`, and `/session` are Gateway commands, not prompts to the ACP harness.

    Required feature flags for thread-bound ACP:

    - `acp.enabled=true`
    - `acp.dispatch.enabled` is on by default (set `false` to pause automatic ACP thread dispatch; explicit `sessions_spawn({ runtime: "acp" })` calls still work).
    - Channel-adapter thread session spawns enabled (default: `true`):
      - Discord/Telegram: `session.threadBindings.spawnSessions=true`

    Thread binding support is adapter-specific. If the active channel adapter
    does not support thread bindings, OpenClaw returns a clear
    unsupported/unavailable message.

  </Accordion>
  <Accordion title="Thread-supporting channels">
    - Any channel adapter that exposes session/thread binding capability.
    - Current built-in support: **Discord** threads/channels, **Telegram** topics (forum topics in groups/supergroups and DM topics).
    - Plugin channels can add support through the same binding interface.

  </Accordion>
</AccordionGroup>

## Persistent channel bindings

For non-ephemeral workflows, configure persistent ACP bindings in top-level
`bindings[]` entries.

### Binding model

<ParamField path="bindings[].type" type='"acp"'>
  Marks a persistent ACP conversation binding.
</ParamField>
<ParamField path="bindings[].match" type="object">
  Identifies the target conversation. Per-channel shapes:

- **Discord channel/thread:** `match.channel="discord"` + `match.peer.id="<channelOrThreadId>"`
- **Slack channel/DM:** `match.channel="slack"` + `match.peer.id="<channelId|channel:<channelId>|#<channelId>|userId|user:<userId>|slack:<userId>|<@userId>>"`. Prefer stable Slack ids; channel bindings also match replies inside that channel's threads.
- **Telegram forum topic:** `match.channel="telegram"` + `match.peer.id="<chatId>:topic:<topicId>"`
- **WhatsApp DM/group:** `match.channel="whatsapp"` + `match.peer.id="<E.164|group JID>"`. Use E.164 numbers such as `+15555550123` for direct chats and WhatsApp group JIDs such as `120363424282127706@g.us` for groups.
- **iMessage DM/group:** `match.channel="imessage"` + `match.peer.id="<handle|chat_id:*|chat_guid:*|chat_identifier:*>"`. Prefer `chat_id:*` for stable group bindings.

</ParamField>
<ParamField path="bindings[].agentId" type="string">
  The owning OpenClaw agent id.
</ParamField>
<ParamField path="bindings[].acp.mode" type='"persistent" | "oneshot"'>
  Optional ACP override.
</ParamField>
<ParamField path="bindings[].acp.label" type="string">
  Optional operator-facing label.
</ParamField>
<ParamField path="bindings[].acp.cwd" type="string">
  Optional runtime working directory.
</ParamField>
<ParamField path="bindings[].acp.backend" type="string">
  Optional backend override.
</ParamField>

### Runtime defaults per agent

Use `agents.entries.*.runtime` to define ACP defaults once per agent:

- `agents.entries.*.runtime.type="acp"`
- `agents.entries.*.runtime.acp.agent` (harness id, e.g. `codex` or `claude`)
- `agents.entries.*.runtime.acp.backend`
- `agents.entries.*.runtime.acp.mode`
- `agents.entries.*.runtime.acp.cwd`

**Override precedence for ACP bound sessions:**

1. `bindings[].acp.*`
2. `agents.entries.*.runtime.acp.*`
3. Global ACP defaults (e.g. `acp.backend`)

Configured bindings also forward the owning agent's explicit model and thinking
policy. Thinking uses the agent's `thinkingDefault`, then per-model
`agents.defaults.models["provider/model"].params.thinking`, then
`agents.defaults.thinkingDefault`. Without configured policy, the external
harness keeps its own defaults.

Changing a configured model or thinking value updates the existing session
before its next turn without replacing the conversation. Each option is saved
only after the harness accepts it; a rejected option returns an error and keeps
that option's previous selection. Model and thinking changes are independent,
not an atomic batch. Removing a default
uses any remaining configured policy; if none remains, OpenClaw retains the
session's last selection. Omission is not a backend reset. To change thinking
explicitly, use `/acp set thinking <level>` with a level supported by the harness.
For Codex ACP, `off` only omits a fresh session's startup override. Switching an
existing session to `off` is unsupported and returns an error without clearing
its current reasoning effort or conversation.

### Example

```json5
{
  agents: {
    ownership: "explicit",
    entries: {
      codex: {
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
      claude: {
        runtime: {
          type: "acp",
          acp: { agent: "claude", backend: "acpx", mode: "persistent" },
        },
      },
    },
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
    {
      type: "acp",
      agentId: "claude",
      match: {
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-1001234567890:topic:42" },
      },
      acp: { cwd: "/workspace/repo-b" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "discord", accountId: "default" },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "telegram", accountId: "default" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": { requireMention: false },
          },
        },
      },
    },
    telegram: {
      groups: {
        "-1001234567890": {
          topics: { "42": { requireMention: false } },
        },
      },
    },
  },
}
```

### Behavior

- OpenClaw ensures the configured ACP session exists after channel-specific admission and before use.
- Messages in that channel, topic, or chat route to the configured ACP session.
- Configured ACP bindings own their session route. Channel broadcast fan-out does not replace the configured ACP session for a matched binding.
- In bound conversations, `/new` and `/reset` reset the same ACP session key in place.
- Runtime bindings created by thread-bound spawns still apply where present.
- For cross-agent ACP spawns without an explicit `cwd`, OpenClaw inherits the target agent workspace from agent config.
- Missing inherited workspace paths fall back to the backend default cwd; non-missing access failures surface as spawn errors.
