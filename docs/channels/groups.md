---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Group chat behavior across surfaces (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing group chat behavior or mention gating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Groups"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw treats group chats consistently across surfaces: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Beginner intro (2 minutes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw “lives” on your own messaging accounts. There is no separate WhatsApp bot user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If **you** are in a group, OpenClaw can see that group and respond there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups are restricted (`groupPolicy: "allowlist"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replies require a mention unless you explicitly disable mention gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Translation: allowlisted senders can trigger OpenClaw by mentioning it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> TL;DR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> - **DM access** is controlled by `*.allowFrom`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> - **Group access** is controlled by `*.groupPolicy` + allowlists (`*.groups`, `*.groupAllowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> - **Reply triggering** is controlled by mention gating (`requireMention`, `/activation`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick flow (what happens to a group message):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
groupPolicy? disabled -> drop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
groupPolicy? allowlist -> group allowed? no -> drop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requireMention? yes -> mentioned? no -> store for context only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
otherwise -> reply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
![Group message flow](/images/groups-flow.svg)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Goal                                         | What to set                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------------------------- | ---------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Allow all groups but only reply on @mentions | `groups: { "*": { requireMention: true } }`                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Disable all group replies                    | `groupPolicy: "disabled"`                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Only specific groups                         | `groups: { "<group-id>": { ... } }` (no `"*"` key)         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Only you can trigger in groups               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group sessions use `agent:<agentId>:<channel>:group:<id>` session keys (rooms/channels use `agent:<agentId>:<channel>:channel:<id>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram forum topics add `:topic:<threadId>` to the group id so each topic has its own session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct chats use the main session (or per-sender if configured).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeats are skipped for group sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pattern: personal DMs + public groups (single agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes — this works well if your “personal” traffic is **DMs** and your “public” traffic is **groups**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Why: in single-agent mode, DMs typically land in the **main** session key (`agent:main:main`), while groups always use **non-main** session keys (`agent:main:<channel>:group:<id>`). If you enable sandboxing with `mode: "non-main"`, those group sessions run in Docker while your main DM session stays on-host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This gives you one agent “brain” (shared workspace + memory), but two execution postures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **DMs**: full tools (host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Groups**: sandbox + restricted tools (Docker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> If you need truly separate workspaces/personas (“personal” and “public” must never mix), use a second agent + bindings. See [Multi-Agent Routing](/concepts/multi-agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (DMs on host, groups sandboxed + messaging-only tools):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "non-main", // groups/channels are non-main -> sandboxed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: "session", // strongest isolation (one container per group/channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceAccess: "none",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // If allow is non-empty, everything else is blocked (deny still wins).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allow: ["group:messaging", "group:sessions"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Want “groups can only see folder X” instead of “no host access”? Keep `workspaceAccess: "none"` and mount only allowlisted paths into the sandbox:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "non-main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: "session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceAccess: "none",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        docker: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          binds: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            // hostPath:containerPath:mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "~/FriendsShared:/data:ro",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configuration keys and defaults: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debugging why a tool is blocked: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bind mounts details: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Display labels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI labels use `displayName` when available, formatted as `<channel>:<token>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `#room` is reserved for rooms/channels; group chats use `g-<slug>` (lowercase, spaces -> `-`, keep `#@+._-`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control how group/room messages are handled per channel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15551234567"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "disabled",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["123456789", "@username"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    signal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "disabled",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15551234567"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "disabled",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["chat_id:123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    msteams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "disabled",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["user@org.com"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      guilds: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        GUILD_ID: { channels: { help: { allow: true } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channels: { "#general": { allow: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    matrix: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["@owner:example.org"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "!roomId:example.org": { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "#alias:example.org": { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Policy        | Behavior                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------- | ------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"open"`      | Groups bypass allowlists; mention-gating still applies.      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"disabled"`  | Block all group messages entirely.                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"allowlist"` | Only allow groups/rooms that match the configured allowlist. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `groupPolicy` is separate from mention-gating (which requires @mentions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: use `groupAllowFrom` (fallback: explicit `allowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: allowlist uses `channels.discord.guilds.<id>.channels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: allowlist uses `channels.slack.channels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix: allowlist uses `channels.matrix.groups` (room IDs, aliases, or names). Use `channels.matrix.groupAllowFrom` to restrict senders; per-room `users` allowlists are also supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group DMs are controlled separately (`channels.discord.dm.*`, `channels.slack.dm.*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram allowlist can match user IDs (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) or usernames (`"@alice"` or `"alice"`); prefixes are case-insensitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default is `groupPolicy: "allowlist"`; if your group allowlist is empty, group messages are blocked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick mental model (evaluation order for group messages):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `groupPolicy` (open/disabled/allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. group allowlists (`*.groups`, `*.groupAllowFrom`, channel-specific allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. mention gating (`requireMention`, `/activation`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mention gating (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group messages require a mention unless overridden per group. Defaults live per subsystem under `*.groups."*"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replying to a bot message counts as an implicit mention (when the channel supports reply metadata). This applies to Telegram, WhatsApp, Slack, Discord, and Microsoft Teams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123@g.us": { requireMention: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123456789": { requireMention: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123": { requireMention: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          historyLimit: 50,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mentionPatterns` are case-insensitive regexes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Surfaces that provide explicit mentions still pass; patterns are a fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-agent override: `agents.list[].groupChat.mentionPatterns` (useful when multiple agents share a group).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mention gating is only enforced when mention detection is possible (native mentions or `mentionPatterns` are configured).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord defaults live in `channels.discord.guilds."*"` (overridable per guild/channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit`) for overrides. Set `0` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group/channel tool restrictions (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some channel configs support restricting which tools are available **inside a specific group/room/channel**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools`: allow/deny tools for the whole group.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `toolsBySender`: per-sender overrides within the group (keys are sender IDs/usernames/emails/phone numbers depending on the channel). Use `"*"` as a wildcard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Resolution order (most specific wins):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. group/channel `toolsBySender` match（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. group/channel `tools`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. default (`"*"`) `toolsBySender` match（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. default (`"*"`) `tools`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (Telegram):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { tools: { deny: ["exec"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "-1001234567890": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          tools: { deny: ["exec", "read", "write"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          toolsBySender: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "123456789": { alsoAllow: ["exec"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group/channel tool restrictions are applied in addition to global/agent tool policy (deny still wins).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some channels use different nesting for rooms/channels (e.g., Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Group allowlists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `channels.whatsapp.groups`, `channels.telegram.groups`, or `channels.imessage.groups` is configured, the keys act as a group allowlist. Use `"*"` to allow all groups while still setting default mention behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common intents (copy/paste):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Disable all group replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { whatsapp: { groupPolicy: "disabled" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Allow only specific groups (WhatsApp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123@g.us": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "456@g.us": { requireMention: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Allow all groups but require mention (explicit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: { "*": { requireMention: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Only the owner can trigger in groups (WhatsApp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15551234567"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: { "*": { requireMention: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Activation (owner-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group owners can toggle per-group activation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/activation mention`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/activation always`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Owner is determined by `channels.whatsapp.allowFrom` (or the bot’s self E.164 when unset). Send the command as a standalone message. Other surfaces currently ignore `/activation`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group inbound payloads set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ChatType=group`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GroupSubject` (if known)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GroupMembers` (if known)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `WasMentioned` (mention gating result)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram forum topics also include `MessageThreadId` and `IsForum`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent system prompt includes a group intro on the first turn of a new group session. It reminds the model to respond like a human, avoid Markdown tables, and avoid typing literal `\n` sequences.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## iMessage specifics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `chat_id:<id>` when routing or allowlisting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List chats: `imsg chats --limit 20`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group replies always go back to the same `chat_id`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WhatsApp specifics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Group messages](/channels/group-messages) for WhatsApp-only behavior (history injection, mention handling details).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
