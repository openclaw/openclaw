---
summary: "iMessage DM and group policy, mention gating, per-group prompts, ACP bindings, and config writes"
read_when:
  - Deciding who can message the bot
  - Debugging ignored DMs or ignored group messages
  - Binding an iMessage chat to an ACP session
title: "iMessage access control and routing"
sidebarTitle: "Access control"
---

Who is admitted, how messages route to sessions, and which chats can write config.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.imessage.dmPolicy` controls direct messages:

    - `pairing` (default)
    - `allowlist` (requires at least one `allowFrom` entry)
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    Allowlist field: `channels.imessage.allowFrom`.

    Allowlist entries must identify senders: handles or static sender access groups (`accessGroup:<name>`). Use `channels.imessage.groupAllowFrom` for chat targets such as `chat_id:*`, `chat_guid:*`, or `chat_identifier:*`; use `channels.imessage.groups` for numeric `chat_id` registry keys.

  </Tab>

  <Tab title="Group policy + mentions">
    `channels.imessage.groupPolicy` controls group handling:

    - `allowlist` (default)
    - `open`
    - `disabled`

    Group sender allowlist: `channels.imessage.groupAllowFrom`.

    `groupAllowFrom` entries can also reference static sender access groups (`accessGroup:<name>`).

    Runtime fallback: if `groupAllowFrom` is unset, iMessage group sender checks use `allowFrom`; set `groupAllowFrom` when DM and group admission should differ. An explicitly empty `groupAllowFrom: []` does not fall back — it blocks all group senders under `allowlist`.
    Runtime note: if `channels.imessage` is completely missing, runtime falls back to `groupPolicy="allowlist"` and logs a warning (even if `channels.defaults.groupPolicy` is set).

    <Warning>
    Group routing under `groupPolicy: "allowlist"` runs **two** gates back-to-back:

    1. **Sender allowlist** (`channels.imessage.groupAllowFrom`) — handle, `accessGroup:<name>`, `chat_guid`, `chat_identifier`, or `chat_id`. An empty effective list (no `groupAllowFrom` and no `allowFrom` fallback) blocks every group sender.
    2. **Group registry** (`channels.imessage.groups`) — enforced once the map has entries: the chat must match an explicit per-`chat_id` entry or a `groups: { "*": { ... } }` wildcard. When `groups` is empty or missing, the sender allowlist alone decides admission.

    If no effective group sender allowlist is configured, every group message is dropped before the registry gate. Each gate has its own `warn`-level signal at the default log level, and each names a different fix:

    - one-time per account at startup, when the effective group sender allowlist is empty: `imessage: groupPolicy="allowlist" for account "<id>" but no group sender allowlist is configured ...` — fix by setting `channels.imessage.groupAllowFrom` (or `allowFrom`); adding `groups` entries alone leaves gate 1 blocking every sender.
    - one-time per `chat_id` at runtime, when a sender passed gate 1 but the chat is missing from a populated `groups` registry: `imessage: dropping group message from chat_id=<id> ...` — fix by adding that `chat_id` (or `"*"`) under `channels.imessage.groups`.

    DMs are unaffected — they take a different code path.

    Recommended config for group flow under `groupPolicy: "allowlist"`:

    ```json5
    {
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15555550123"],
          groups: { "*": { "requireMention": true } },
        },
      },
    }
    ```

    `groupAllowFrom` alone admits those senders in any group; add the `groups` block to scope which chats are allowed (and to set per-chat options like `requireMention`).
    </Warning>

    Mention gating for groups:

    - iMessage has no native mention metadata
    - mention detection uses `agents.entries.*.groupChat.mentionPatterns`, then `messages.groupChat.mentionPatterns`; when neither is set, patterns are derived from the routed agent's `identity.name` and `identity.emoji`
    - groups require a mention by default, even when no patterns were explicitly configured; an allowlisted sender's message can therefore be skipped unless it contains the agent's name or emoji
    - an explicit `mentionPatterns: []` at the selected agent or global level suppresses identity-derived patterns; iMessage cannot enforce mention gating when no usable patterns remain
    - control commands from authorized senders bypass mention gating

    To process every message from allowed senders in one group, set that chat's `requireMention` to `false`:

    ```json5
    {
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15555550123", "+15555550124"],
          groups: {
            "*": {},
            "123": { requireMention: false },
          },
        },
      },
    }
    ```

    Replace `123` with the numeric chat ID from `imsg chats --limit 20 --json`. Edit the map already supplying that account's group policy: `channels.imessage.groups`, or `channels.imessage.accounts.<account-id>.groups` when it overrides the root map. This also applies to `accounts.default.groups`; merely having an account entry does not mean its own `groups` map is needed. An empty account map inherits the root map only when at most one account is configured.

    Preserve the existing wildcard and every per-group setting, changing only the target chat's `requireMention`. Account maps replace the whole inherited map, so if you intentionally create an account-specific override, first copy the complete inherited map, including all wildcard and per-group policies. When no map previously applied, `"*": {}` preserves admission to other groups while keeping their default mention requirement. Keep a restricted map restricted. `groupAllowFrom` still controls sender access.

    A skipped message with no mention produces a warning at the default log level with the chat ID and the `requireMention: false` fix. Repeated warnings for the same chat are suppressed by a bounded in-memory cache; restarting the channel or evicting a cache entry allows the warning again.

    Per-group `systemPrompt`:

    Each entry under `channels.imessage.groups.*` accepts an optional `systemPrompt` string, injected into the agent's system prompt on every turn that handles a message in that group. Resolution mirrors `channels.whatsapp.groups`:

    1. **Group-specific system prompt** (`groups["<chat_id>"].systemPrompt`): used when the specific group entry exists in the map **and** its `systemPrompt` key is defined. If `systemPrompt` is an empty string (`""`) the wildcard is suppressed and no system prompt is applied to that group.
    2. **Group wildcard system prompt** (`groups["*"].systemPrompt`): used when the specific group entry is absent from the map entirely, or when it exists but defines no `systemPrompt` key.

    ```json5
    {
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15555550123"],
          groups: {
            "*": { systemPrompt: "Use British spelling." },
            "8421": {
              requireMention: true,
              systemPrompt: "This is the on-call rotation chat. Keep replies under 3 sentences.",
            },
            "9907": {
              // explicit suppression: the wildcard "Use British spelling." does not apply here
              systemPrompt: "",
            },
          },
        },
      },
    }
    ```

    Per-group prompts only apply to group messages — direct messages are unaffected.

  </Tab>

  <Tab title="Sessions and deterministic replies">
    - DMs use direct routing; groups use group routing.
    - With default `session.dmScope=main`, iMessage DMs collapse into the agent main session.
    - Group sessions are isolated (`agent:<agentId>:imessage:group:<chat_id>`).
    - Replies route back to iMessage using originating channel/target metadata.

    Group-ish thread behavior:

    Some multi-participant iMessage threads can arrive with `is_group=false`.
    If that `chat_id` is explicitly configured under `channels.imessage.groups`, OpenClaw treats it as group traffic (group gating + group session isolation).

  </Tab>
</Tabs>

## ACP conversation bindings

iMessage chats can be bound to ACP sessions.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the DM or allowed group chat.
- Future messages in that same iMessage conversation route to the spawned ACP session.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

Configured persistent bindings use top-level `bindings[]` entries with `type: "acp"` and `match.channel: "imessage"`.

`match.peer.id` can use:

- normalized DM handle such as `+15555550123` or `user@example.com`
- `chat_id:<id>` (recommended for stable group bindings)
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

Example:

```json5
{
  agents: {
    entries: {
      codex: {
        default: true,
        runtime: {
          type: "acp",
          acp: { agent: "codex", backend: "acpx", mode: "persistent" },
        },
      },
    },
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "imessage",
        accountId: "default",
        peer: { kind: "group", id: "chat_id:123" },
      },
      acp: { label: "codex-group" },
    },
  ],
}
```

See [ACP Agents](/tools/acp-agents) for shared ACP binding behavior.

## Config writes

iMessage allows channel-initiated config writes by default (for `/config set|unset` when `commands.config: true`).

Disable:

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```
