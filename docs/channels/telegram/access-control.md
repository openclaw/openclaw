---
summary: "DM policy, group allowlists, mention gating, and per-chat tool policy"
read_when:
  - Deciding who may DM the Telegram bot
  - Allowing a group or forum topic and its senders
  - Turning mention gating on or off for a group
title: "Telegram access control"
sidebarTitle: "Access control"
---

Who may talk to the Telegram bot, in DMs and in groups, and what they may make it do.

## Access control and activation

### Group bot identity

In groups and forum topics, an explicit mention of the configured bot handle addresses the selected OpenClaw agent. An example handle is `@my_bot`. This holds even when the agent persona name differs from the Telegram username. Group silence policy still applies to unrelated traffic, but the bot handle itself is never "someone else."

<Tabs>
  <Tab title="DM policy">
    `channels.telegram.dmPolicy` controls direct message access:

    - `pairing` (default)
    - `allowlist` (requires at least one sender ID in `allowFrom`)
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    `dmPolicy: "open"` with `allowFrom: ["*"]` lets any Telegram account that finds or guesses the bot username command the bot. Use it only for intentionally public bots with tightly restricted tools. One-owner bots should use `allowlist` with numeric user IDs.

    `channels.telegram.allowFrom` accepts numeric Telegram user IDs. `telegram:` / `tg:` prefixes are accepted and normalized.
    In multi-account configs, a restrictive top-level `channels.telegram.allowFrom` is a safety boundary. An account-level `allowFrom: ["*"]` does not make that account public unless the merged effective allowlist still contains an explicit wildcard.
    `dmPolicy: "allowlist"` with empty `allowFrom` blocks all DMs and is rejected by config validation.
    Setup asks for numeric user IDs only. Older setups may have `@username` allowlist entries. Run `openclaw doctor --fix` to resolve them to numeric IDs. That resolution is best-effort and requires a Telegram bot token.
    If you previously relied on pairing-store allowlist files, `openclaw doctor --fix` can recover entries into `channels.telegram.allowFrom` for allowlist flows. One such case is a `dmPolicy: "allowlist"` that has no explicit IDs yet.

    For one-owner bots, prefer `dmPolicy: "allowlist"` with explicit numeric `allowFrom` IDs over depending on previous pairing approvals.

    Common confusion: DM pairing approval does not mean "this sender is authorized everywhere." Pairing grants DM access only. If no command owner exists yet, the first approved pairing also sets `commands.ownerAllowFrom`. That gives owner-only commands and exec approvals an explicit operator account. Group sender authorization still comes from explicit config allowlists.
    To be authorized for both DMs and group commands with one identity, put your numeric Telegram user ID in `channels.telegram.allowFrom`. For owner-only commands, make sure `commands.ownerAllowFrom` contains `telegram:<your user id>`.

    Use `channels.telegram.direct.<chatId>.tools` to set the built-in tool policy for one DM. `toolsBySender` selects a sender-specific policy by typed sender key such as `channel:telegram:<userId>` or `id:<userId>`:

```json5
{
  channels: {
    telegram: {
      direct: {
        "*": { tools: { deny: ["write", "edit"] } },
        "603767951": { tools: {} },
      },
    },
  },
}
```

    A matching `toolsBySender` entry replaces `tools` for that DM. An exact chat entry replaces the whole `"*"` entry; it does not inherit wildcard fields. Account-level `direct` replaces the root `direct` map when present and inherits it only when omitted. The selected direct policy, global policy, per-agent policy, `tools.toolsBySender`, and `agents.<id>.tools.toolsBySender` apply as intersecting layers; a deny in any layer still blocks the tool. Codex uses policy-filtered OpenClaw tools for explicitly restricted turns and keeps its native tool surface for default profile narrowing. ACP-bound sessions reject a restrictive direct policy when their runtime cannot enforce it.

    ### Finding your Telegram user ID

    Safer (no third-party bot): with DM policy `pairing`, DM your bot and read `Your Telegram user id` in its pairing reply. You can also run `openclaw logs --follow` and read `senderUserId` in the `telegram pairing request` entry. Both come from the incoming message's `from.id`.

    Use your numeric user ID for `allowFrom`, not a phone number, username, chat/group ID, or the bot's ID. Stop following once you have the ID and keep unrelated log content private. If your current policy prevents this flow, use an already verified ID; do not broaden access just to discover it.

    Official Bot API method:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    Third-party (less private): `@userinfobot` or `@getidsbot`.

  </Tab>

  <Tab title="Group policy and allowlists">
    Two controls apply together:

    1. **Which groups are allowed** (`channels.telegram.groups`)
       - no `groups` config, `groupPolicy: "open"`: any group passes group-ID checks
       - no `groups` config, `groupPolicy: "allowlist"` (default): all groups blocked until you add `groups` entries (or `"*"`)
       - `groups` configured: acts as an allowlist (explicit IDs or `"*"`)

    2. **Which senders are allowed in groups** (`channels.telegram.groupPolicy`)
       - `open` / `allowlist` (default) / `disabled`

    `groupAllowFrom` filters group senders. If unset, Telegram falls back to `allowFrom`, not the pairing store. Group sender auth never inherits DM pairing-store approvals, a security boundary since `2026.2.25`.
    `groupAllowFrom` entries should be numeric Telegram user IDs, and `telegram:` / `tg:` prefixes are normalized. Non-numeric entries are ignored. Do not put group or supergroup chat IDs here — negative chat IDs belong under `channels.telegram.groups`.
    In multi-account configs, root `channels.telegram.groups` is the shared default for accounts that omit `groups`. An account-level `groups` map replaces the root map for that account. It is not deep-merged. An explicit empty account map (`groups: {}`) keeps that account isolated from the shared groups.
    Practical pattern for one-owner bots: set your user ID in `channels.telegram.allowFrom`, leave `groupAllowFrom` unset, and allow the target groups under `channels.telegram.groups`.
    If `channels.telegram` is entirely missing from config, runtime defaults to fail-closed `groupPolicy="allowlist"` unless `channels.defaults.groupPolicy` is explicitly set.

    Owner-only group setup:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: ["<YOUR_TELEGRAM_USER_ID>"],
      groupPolicy: "allowlist",
      groups: {
        "<GROUP_CHAT_ID>": {
          requireMention: true,
        },
      },
    },
  },
}
```

    Test from the group with `@<bot_username> ping`. Plain group messages do not trigger the bot while `requireMention: true`.

    Allow any member in one specific group:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

    Allow only specific users inside one specific group:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          requireMention: true,
          allowFrom: ["8734062810", "745123456"],
        },
      },
    },
  },
}
```

    <Warning>
      Common mistake: `groupAllowFrom` is not a group allowlist.

      - Negative Telegram group/supergroup chat IDs (`-1001234567890`) go under `channels.telegram.groups`.
      - Telegram user IDs (`8734062810`) go under `groupAllowFrom` to limit which people inside an allowed group can trigger the bot.
      - Use `groupAllowFrom: ["*"]` only to let any member of an allowed group talk to the bot.

    </Warning>

  </Tab>

  <Tab title="Mention behavior">
    Group replies require mention by default. A mention can come from:

    - a native `@botusername` mention, or
    - a mention pattern in `agents.entries.*.groupChat.mentionPatterns` or `messages.groupChat.mentionPatterns`

    Session-level toggles (state only, not persisted): `/activation always`, `/activation mention`. Use config for persistence:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    Group history context is always on and bounded by `historyLimit`. Set `channels.telegram.historyLimit: 0` to disable the group history window. `openclaw doctor --fix` removes the retired `includeGroupHistoryContext` key.

    Getting the group chat ID: forward a group message to `@userinfobot` / `@getidsbot`, read `chat.id` from `openclaw logs --follow`, inspect Bot API `getUpdates`, or (once the group is allowed) run `/whoami@<bot_username>`.

  </Tab>
</Tabs>
