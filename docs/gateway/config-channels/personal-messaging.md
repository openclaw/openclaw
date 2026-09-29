---
summary: "Per-channel config keys for WhatsApp, Telegram, Signal, iMessage, and LINE"
read_when:
  - Configuring WhatsApp, Telegram, Signal, iMessage, or LINE
  - Troubleshooting bot tokens, pairing, or media limits on a personal messaging channel
  - Setting up the iMessage SSH wrapper for a remote Messages Mac
title: "Configuration — personal messaging channels"
---

`channels.*` keys for the personal messaging channels: WhatsApp, Telegram, Signal, iMessage, and LINE.

## WhatsApp

WhatsApp runs through the gateway's web channel (Baileys Web). It starts automatically when a linked session exists.

```json5
{
  channels: {
    whatsapp: {
      enabled: true,
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000,
      streaming: { chunkMode: "length" }, // length | newline
      mediaMaxMb: 50,
      sendReadReceipts: true, // blue ticks (false in self-chat mode)
      groups: {
        "*": { requireMention: true },
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

- Top-level `bindings[]` entries with `type: "acp"` configure persistent ACP bindings for WhatsApp DMs and groups. Use an E.164 direct number or WhatsApp group JID in `match.peer.id`. Field semantics are shared in [ACP Agents](/tools/acp-agents#persistent-channel-bindings).

<Accordion title="Multi-account WhatsApp">

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {},
        personal: {},
        biz: {
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

- Outbound commands default to account `default` if present; otherwise the first configured account id (sorted).
- Optional `channels.whatsapp.defaultAccount` overrides that fallback default account selection when it matches a configured account id.
- Legacy single-account Baileys auth dir is migrated by `openclaw doctor` into `whatsapp/default`.
- Per-account overrides: `channels.whatsapp.accounts.<id>.sendReadReceipts`, `channels.whatsapp.accounts.<id>.dmPolicy`, `channels.whatsapp.accounts.<id>.allowFrom`.

</Accordion>

## Telegram

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing",
      allowFrom: ["tg:123456789"],
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50,
      replyToMode: "first", // off | first | all | batched
      linkPreview: true,
      streaming: { mode: "partial" }, // off | partial | block | progress (default: partial)
      actions: { reactions: true, sendMessage: true },
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 100,
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
      apiRoot: "https://api.telegram.org",
      trustedLocalFileRoots: ["/srv/telegram-bot-api-data"],
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

- Bot token: `channels.telegram.botToken` or `channels.telegram.tokenFile` (regular file only; symlinks rejected), with `TELEGRAM_BOT_TOKEN` as fallback for the default account.
- `channels.telegram.joinIntro` defaults to `true`. When the bot joins an allowed group or supergroup, it posts one introduction using the group title, description, and available pinned message. The Telegram Bot API cannot read pre-join group history. Set this option to `false` to disable introductions, or use `channels.telegram.accounts.<accountId>.joinIntro` for an account-specific override. Introductions happen once per room; see [group join introductions](/channels#group-join-introductions). Introductions never run in private chats.
- `apiRoot` is the Telegram Bot API root only. Use `https://api.telegram.org` or your self-hosted/proxy root, not `https://api.telegram.org/bot<TOKEN>`; `openclaw doctor --fix` removes an accidental trailing `/bot<TOKEN>` suffix.
- For a self-hosted Bot API server in `--local` mode, `trustedLocalFileRoots` lists host paths OpenClaw may read. Mount the server data volume on the OpenClaw host and configure either its data root or per-token directory; container paths under `/var/lib/telegram-bot-api` are mapped into those roots. Other absolute paths remain rejected.
- Optional `channels.telegram.defaultAccount` overrides default account selection when it matches a configured account id.
- In multi-account setups (2+ account ids), set an explicit default (`channels.telegram.defaultAccount` or `channels.telegram.accounts.default`) to avoid fallback routing; `openclaw doctor` warns when this is missing or invalid.
- `configWrites: false` blocks Telegram-initiated config writes (supergroup ID migrations, `/config set|unset`).
- `actions.reactions` controls both message reactions and `emoji-list`, which lists the standard and custom reactions allowed in the current chat.
- Top-level `bindings[]` entries with `type: "acp"` configure persistent ACP bindings for forum topics (use canonical `chatId:topic:topicId` in `match.peer.id`). Field semantics are shared in [ACP Agents](/tools/acp-agents#persistent-channel-bindings).
- Telegram stream previews use `sendMessage` + `editMessageText` (works in direct and group chats).
- `network.dnsResultOrder` defaults to `"ipv4first"` to avoid common IPv6 fetch failures.
- Retry policy: see [Retry policy](/concepts/retry).

## Signal

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15555550123", // optional account binding
      dmPolicy: "pairing",
      allowFrom: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      configWrites: true,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50,
    },
  },
}
```

**Reaction notification modes:** `off`, `own` (default), `all`, `allowlist` (from `reactionAllowlist`).

- `channels.signal.account`: pin channel startup to a specific Signal account identity.
- `channels.signal.configWrites`: allow or deny Signal-initiated config writes.
- Optional `channels.signal.defaultAccount` overrides default account selection when it matches a configured account id.

## iMessage

OpenClaw spawns `imsg rpc` (JSON-RPC over stdio). No daemon or port required. This is the preferred path for new OpenClaw iMessage setups when the host can grant Messages database and Automation permissions.

BlueBubbles support was removed. `channels.bluebubbles` is not a supported runtime config surface on current OpenClaw. Migrate old configs to `channels.imessage`; use [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) for the short version and [Coming from BlueBubbles](/channels/imessage-from-bluebubbles) for the full translation table.

If the Gateway is not running on the signed-in Messages Mac, keep `channels.imessage.enabled=true` and set `channels.imessage.cliPath` to the absolute path of a Gateway-local SSH wrapper that runs `imsg "$@"` on that Mac. Set `remoteHost` to the Messages Mac, not the Gateway host. OpenClaw auto-detects simple transparent SSH wrappers for compatibility, but complex wrappers require explicit `remoteHost`. The default local `imsg` path is macOS-only.

Before relying on an SSH wrapper for production sends, verify an outbound `imsg send` through that exact wrapper. Some macOS TCC states assign Messages Automation to `/usr/libexec/sshd-keygen-wrapper`, which can make reads and probes work while sends fail with AppleEvents `-1743`; see the SSH wrapper troubleshooting section on [iMessage](/channels/imessage).

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/home/openclaw/.openclaw/scripts/imsg-ssh",
      dbPath: "/Users/user/Library/Messages/chat.db",
      remoteHost: "user@messages-mac",
      dmPolicy: "pairing",
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50,
      includeAttachments: false,
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      mediaMaxMb: 16,
      service: "auto",
      sendTransport: "auto",
      region: "US",
      actions: {
        reactions: true,
        edit: true,
        unsend: true,
        reply: true,
        sendWithEffect: true,
        sendAttachment: true,
      },
    },
  },
}
```

- Optional `channels.imessage.defaultAccount` overrides default account selection when it matches a configured account id.
- Requires Full Disk Access to the Messages DB.
- Prefer `chat_id:<id>` targets. Use `imsg chats --limit 20` to list chats.
- For SSH setups, `cliPath` is an absolute path on the Gateway host. `remoteHost` (`host` or `user@host`) is the Messages Mac, and `dbPath` is interpreted on that Mac. Use an absolute remote database path rather than expanding it from the Gateway user's home.
- A configured or auto-detected `remoteHost` enables inbound attachment fetches and outbound file staging over the existing strict SSH/SCP transport. Outbound files use an owner-only remote temporary path with best-effort cleanup after success, failure, or timeout; cleanup failure warns and can leave owner-only residue.
- `attachmentRoots` and `remoteAttachmentRoots` restrict inbound attachment paths (default: `/Users/*/Library/Messages/Attachments`).
- SCP uses strict host-key checking, so ensure the Messages Mac host key already exists in `~/.ssh/known_hosts`.
- `channels.imessage.configWrites`: allow or deny iMessage-initiated config writes.
- `channels.imessage.sendTransport`: preferred `imsg` RPC send transport for normal outbound replies. `auto` (default) uses the IMCore bridge for existing chats when it is running, then falls back to AppleScript; `bridge` requires private-API delivery; `applescript` forces the public Messages automation path.
- `channels.imessage.actions.*`: enable private API actions that are also gated by `imsg status` / `openclaw channels status --probe`.
- `channels.imessage.includeAttachments` is off by default; set it to `true` before expecting inbound media in agent turns.
- Inbound recovery after a bridge/gateway restart is automatic (GUID dedupe plus a stale-backlog age fence). Existing `channels.imessage.catchup.enabled: true` configs are still honored as a deprecated compatibility profile; `catchup` is disabled by default.
- `channels.imessage.groups`: group registry and per-group settings. With `groupPolicy: "allowlist"`, configure either explicit `chat_id` keys or a `"*"` wildcard entry so group messages can pass the registry gate.
- Top-level `bindings[]` entries with `type: "acp"` can bind iMessage conversations to persistent ACP sessions. Use a normalized handle or explicit chat target (`chat_id:*`, `chat_guid:*`, `chat_identifier:*`) in `match.peer.id`. Shared field semantics: [ACP Agents](/tools/acp-agents#persistent-channel-bindings).

<Accordion title="iMessage SSH wrapper example">

```bash
#!/usr/bin/env bash
exec ssh -T messages-mac imsg "$@"
```

With remote `imsg` v0.13.4, poll votes must use `pollOptionId`; its `poll.vote` RPC method does not resolve index or text selectors. Attachment replies to nonzero part indices are also unavailable remotely. These limits do not change local `imsg` behavior.

</Accordion>

## LINE

LINE is plugin-backed and configured under `channels.line`.

- `channels.line.joinIntro` defaults to `true`. When the bot joins an allowed group or multi-person room, it posts one introduction using the group name when available. LINE exposes no multi-person room name or topic, and its Messaging API cannot read prior messages. Set this option to `false` to disable introductions, or use `channels.line.accounts.<accountId>.joinIntro` for an account-specific override. Introductions happen once per room and never run in one-to-one user chats; see [group join introductions](/channels#group-join-introductions).
- Full LINE configuration, webhook setup, and access policy are documented in [LINE](/channels/line).
