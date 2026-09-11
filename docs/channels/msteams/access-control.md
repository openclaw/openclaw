---
summary: "Microsoft Teams DM and group policy, team and channel allowlists, and conversation IDs"
read_when:
  - Deciding who may DM or mention the Teams bot
  - Scoping replies to specific teams and channels
  - Looking up a Teams team or channel ID
title: "Microsoft Teams access control"
sidebarTitle: "Access control"
---

Who may talk to the Teams bot, which teams and channels it answers in, and where the IDs those rules use come from.

## Config writes

By default, Microsoft Teams can write config updates triggered by `/config set|unset` (requires `commands.config: true`).

Disable with:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Access control (DMs + groups)

Microsoft Teams has one account per channel configuration. Set policies directly under `channels.msteams`; an `accounts` map is not supported.

**DM access**

- Default: `channels.msteams.dmPolicy = "pairing"`. Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` should use stable AAD object IDs or static sender access groups such as `accessGroup:core-team`.
- Do not rely on UPN/display-name matching for allowlists; they can change. OpenClaw disables direct name matching by default; opt in with `channels.msteams.dangerouslyAllowNameMatching: true`.
- The wizard can resolve names to IDs via Microsoft Graph when credentials allow.

**Group access**

- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Set `channels.msteams.groupPolicy` explicitly to choose another policy; the root schema default takes precedence over `channels.defaults.groupPolicy`.
- `channels.msteams.groupAllowFrom` controls which senders, static sender access groups, or group/channel conversation IDs can trigger in group chats/channels (falls back to `channels.msteams.allowFrom`). Conversation IDs can use `19:...@thread.tacv2`, `19:...@thread.v2`, or `19:...@thread.skype`; preserve the exact ID casing. OpenClaw ignores `;messageid=...` suffixes. Conversation IDs never grant personal-DM access.
- Set `groupPolicy: "open"` to allow any member (still mention-gated by default).
- To block **all** channels, set `channels.msteams.groupPolicy: "disabled"`.

Example:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["00000000-0000-0000-0000-000000000000", "accessGroup:core-team"],
    },
  },
}
```

**Team + channel allowlist**

- Scope group/channel replies by listing teams and channels under `channels.msteams.teams`.
- Use stable Teams conversation IDs from Teams links as keys, not mutable display names (see [Team and Channel IDs](#team-and-channel-ids-common-gotcha)).
- When `groupPolicy="allowlist"` and a teams allowlist is present, only listed teams/channels are accepted (mention-gated).
- `groupAllowFrom` authorizes group senders, not delegated Graph reads of other channels. If an existing configuration only sets `groupAllowFrom`, keep the default `groupPolicy: "allowlist"` and configure the target under `channels.msteams.teams.<team>.channels`.
- Alternatively, deliberately set `groupPolicy: "open"` for broader delegated reads. This also admits **any group sender** (still mention-gated by default), so it is less restrictive than a scoped team/channel route.
- Direct-operator reads and reads in the current conversation do not require an additional team/channel route.
- The configure wizard accepts `Team/Channel` entries and stores them for you.
- On startup, OpenClaw resolves team/channel and user allowlist names to IDs (when Graph permissions allow) and logs the mapping. Unresolved names are kept as typed but ignored for routing unless `channels.msteams.dangerouslyAllowNameMatching: true` is set.

Example:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["00000000-0000-0000-0000-000000000000"],
      teams: {
        "19:team-id@thread.tacv2": {
          channels: {
            "19:channel-id@thread.tacv2": { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Team and Channel IDs (Common Gotcha)

The `groupId` query parameter in Teams URLs is **NOT** the team ID used for configuration. Extract IDs from the URL path instead:

**Team URL:**

```text
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team conversation ID (URL-decode this)
```

**Channel URL:**

```text
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**For config:**

- Team key = path segment after `/team/` (URL-decoded, e.g., `19:Bk4j...@thread.tacv2`; older tenants may show `@thread.skype`, which is also valid).
- Channel key = path segment after `/channel/` (URL-decoded).
- **Ignore** the `groupId` query parameter for OpenClaw routing. It is the Microsoft Entra group ID, not the Bot Framework conversation ID used in incoming Teams activities.

## Private channels

Bots have limited support in private channels:

| Feature                      | Standard channels | Private channels       |
| ---------------------------- | ----------------- | ---------------------- |
| Bot installation             | Yes               | Limited                |
| Real-time messages (webhook) | Yes               | May not work           |
| RSC permissions              | Yes               | May behave differently |
| @mentions                    | Yes               | If bot is accessible   |
| Graph API history            | Yes               | Yes (with permissions) |

**Workarounds if private channels do not work:**

1. Use standard channels for bot interactions.
2. Use DMs; users can always message the bot directly.
3. Use Graph API for historical access (requires `ChannelMessage.Read.All`).
