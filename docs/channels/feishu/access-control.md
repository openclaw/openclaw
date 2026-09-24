---
summary: "Feishu DM policy, group policy, mention gating, and how to find chat and user IDs"
read_when:
  - Deciding who may DM the bot or use it in a group
  - Writing a group or sender allowlist
  - Looking up a Feishu `chat_id` or `open_id`
title: "Feishu access control"
sidebarTitle: "Access control"
---

Who can talk to the Feishu bot, the group configuration examples that express those rules, and how to look up the IDs they need.

## Access control

### Direct messages

Configure `channels.feishu.dmPolicy` (default: `pairing`) to control who can DM the bot:

| Value         | Behavior                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `"pairing"`   | Unknown users receive a pairing code; approve via CLI                                                         |
| `"allowlist"` | Only users listed in `allowFrom` can chat                                                                     |
| `"open"`      | Public DMs; config validation requires `allowFrom` to include `"*"`. Non-wildcard entries still narrow access |

**Approve a pairing request:**

```bash
openclaw pairing list feishu
openclaw pairing approve feishu <CODE>
```

### Group chats

**Group policy** (`channels.feishu.groupPolicy`, default: `allowlist`):

| Value         | Behavior                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `"open"`      | Respond to all messages in groups                                                            |
| `"allowlist"` | Only respond to groups in `groupAllowFrom` or explicitly configured under `groups.<chat_id>` |
| `"disabled"`  | Disable all group messages; explicit `groups.<chat_id>` entries do not override this         |

**Mention requirement** (`channels.feishu.requireMention`):

- Default: @mention required, except when the effective group policy is `"open"`; there it defaults to `false` so messages that cannot carry mentions (for example images) still reach the agent.
- Set `true` or `false` explicitly to override; per-group override: `channels.feishu.groups.<chat_id>.requireMention`.
- Broadcast-only `@all` and `@_all` are not treated as bot mentions. A message that mentions both `@all` and the bot directly still counts as a bot mention.

Mentions of other people stay readable in the text sent to the agent,
including when consecutive messages are combined.

## Group configuration examples

### Allow all groups, no @mention required

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open", // requireMention defaults to false under "open"
    },
  },
}
```

### Allow all groups, still require @mention

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      requireMention: true,
    },
  },
}
```

### Allow specific groups only

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      // Group IDs look like: oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

In `allowlist` mode, you can also admit a group by adding an explicit `groups.<chat_id>` entry. Explicit entries do not override `groupPolicy: "disabled"`. Wildcard defaults under `groups.*` configure matching groups, but they do not admit groups by themselves.

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groups: {
        oc_xxx: {
          requireMention: false,
        },
      },
    },
  },
}
```

### Restrict senders within a group

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // User open_ids look like: ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

`channels.feishu.groupSenderAllowFrom` sets the same sender allowlist for all groups; a per-group `allowFrom` takes precedence.

### Bot-authored messages

Feishu ignores messages authored by other bots by default. To allow bot-to-bot group conversations, grant the app the `im:message.group_at_msg.include_bot:readonly` and `im:message:readonly` scopes, then set `allowBots`:

```json5
{
  channels: {
    feishu: {
      allowBots: true,
    },
  },
}
```

Feishu only delivers bot-authored group events when another bot mentions this bot. Existing group policy, sender allowlists, and mention requirements still apply. OpenClaw drops self-authored messages, mentions the peer bot on every text or card reply, and applies the shared [`channels.defaults.botLoopProtection`](/channels/bot-loop-protection) guard.

<a id="get-groupuser-ids"></a>

## Get group/user IDs

### Group IDs (`chat_id`, format: `oc_xxx`)

Open the group in Feishu/Lark, click the menu icon in the top-right corner, and go to **Settings**. The group ID (`chat_id`) is listed on the settings page.

![Get Group ID](/images/feishu-get-group-id.png)

### User IDs (`open_id`, format: `ou_xxx`)

Start the gateway, send a DM to the bot, then check the logs:

```bash
openclaw logs --follow
```

Look for `open_id` in the log output. You can also check pending pairing requests:

```bash
openclaw pairing list feishu
```
