---
summary: "Runtime model, reply tags, link previews, live stream previews, ack reactions, and mention aliases"
read_when:
  - Understanding how Discord messages flow through the gateway
  - Tuning reply threading, acknowledgements, or outbound mentions
title: "Discord message behavior"
sidebarTitle: "Message behavior"
---

How inbound and outbound Discord messages are routed, formatted, acknowledged, and previewed.

## Runtime model

- Gateway owns the Discord connection.
- Reply routing is deterministic: Discord inbound replies back to Discord.
- Bot replies and thread-bound persona replies share Markdown formatting, including CommonMark bold and configured table conversion.
- Forwarded message snapshots reach the agent together with any accompanying caption. Forwarded text is not treated as a typed command; command classification uses only the sender’s own message text.
- Discord guild/channel metadata is added to the model prompt as untrusted context, not as a user-visible reply prefix. If a model copies that envelope back, OpenClaw strips the copied metadata from outbound replies and from future replay context.
- By default (`session.dmScope=main`), direct chats share the agent main session (`agent:main:main`).
- Guild channels are isolated session keys (`agent:<agentId>:discord:channel:<channelId>`).
- Group DMs are ignored by default (`channels.discord.dm.groupEnabled=false`).
- Native slash commands run in isolated command sessions (`agent:<agentId>:discord:slash:<userId>`), while still carrying `CommandTargetSessionKey` to the routed conversation session.
- Text-only cron/heartbeat announce delivery to Discord collapses to the final assistant-visible answer, sent once. Media and structured component payloads remain multi-message when the agent emits multiple deliverable payloads.
- A send response without a Discord message ID stays unconfirmed. Queued delivery records the missing identity for recovery instead of reporting success or immediately sending a duplicate; inspect delivery warnings with `openclaw health --verbose`.

## Message behavior

<AccordionGroup>
  <Accordion title="Introductions when joining a server">
    When the bot joins an allowed Discord server, OpenClaw posts one room-specific introduction. It prefers the server's system channel when the bot can view and send messages there; otherwise, it uses the first text channel with both **View Channel** and **Send Messages** permissions. If no eligible channel exists, no introduction is sent.

    Introductions use the channel name and topic, plus recent messages when available. Reading earlier messages also requires **Read Message History**; when that permission is missing, OpenClaw still introduces itself using channel metadata instead of failing.

    Introductions are enabled by default, apply only to newly joined servers, and never run in direct messages. Set `channels.discord.joinIntro: false` to disable them, or set `channels.discord.accounts.<accountId>.joinIntro` to override one account. See [group join introductions](/channels#group-join-introductions) for the history limits, target-channel selection, once-per-room behavior, and untrusted-content handling.

  </Accordion>

  <Accordion title="Reply tags and native replies">
    Discord supports reply tags in agent output:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    Controlled by `channels.discord.replyToMode`:

    - `off` (default): no implicit reply threading; explicit `[[reply_to_*]]` tags are still honored
    - `first`: attaches the implicit native reply reference to the first outbound Discord message of the turn
    - `all`: attaches it to every outbound message
    - `batched`: attaches it only when the inbound event was a debounced batch of multiple messages — useful when you want native replies mainly for ambiguous bursty chats, not every single-message turn

    Message IDs are surfaced in context/history so agents can target specific messages.

  </Accordion>

  <Accordion title="Link previews">
    Discord generates rich link embeds for URLs by default. OpenClaw suppresses those generated embeds on outbound Discord messages by default, so agent-sent URLs stay plain links unless you opt in:

```json5
{
  channels: {
    discord: {
      suppressEmbeds: false,
    },
  },
}
```

    Set `channels.discord.accounts.<id>.suppressEmbeds` to override one account. Agent message-tool sends can also pass `suppressEmbeds: false` for a single message. Explicit Discord `embeds` payloads are not suppressed by the default link-preview setting.

  </Accordion>

  <Accordion title="Live stream preview">
    OpenClaw can stream draft replies by sending a temporary message and editing it as text arrives. Discord preview streaming defaults to `off`; set `channels.discord.streaming.mode` to `partial`, `block`, or `progress` to opt in. `streamMode` is a legacy alias; run `openclaw doctor --fix` to rewrite persisted config to the canonical nested `streaming` shape.

```json5
{
  channels: {
    discord: {
      streaming: {
        mode: "progress",
        progress: {
          maxLines: 8,
          maxLineChars: 120,
          toolProgress: false,
          commentary: false,
        },
      },
    },
  },
}
```

    - `off` disables Discord preview edits.
    - `partial` edits a single preview message as tokens arrive.
    - `block` emits draft-sized chunks; tune size and breakpoints with `streaming.preview.chunk` (`minChars`, `maxChars`, `breakPreference`), clamped to `textChunkLimit`. An explicit non-`off` preview mode overrides inherited `agents.defaults.blockStreamingDefault: "on"`; explicit `streaming.block.enabled: true` overrides the preview. If a turn cannot use previews, inherited block delivery still applies.
    - `progress` keeps one editable status draft until final delivery. By default it is quiet: the agent's latest preamble or narration as a status headline, 💬 commentary and 🧠 reasoning when they stream, ✅ / ▸ / ▢ plan steps, and any approval request or failed command. Ordinary tool calls do not add rows.
    - Media, error, and explicit-reply finals cancel pending preview edits.
    - `streaming.progress.toolProgress: true` adds the rolling tool log underneath the headline: rows such as `🛠️ Bash: run tests` or `🔎 Web Search: for "query"` (default `false`). `streaming.preview.toolProgress` controls tool rows in `partial` and `block` modes, where they default to `true`.
    - `streaming.progress.commentary` (default `false`) opts into raw assistant commentary in the temporary progress draft. The default preamble/narration status line is independent of this option. Commentary is cleaned before display, stays transient, and does not change final answer delivery.
    - `streaming.progress.maxLineChars` controls the per-line progress preview budget. Prose is shortened on word boundaries; command and path details keep useful suffixes.
    - `streaming.preview.commandText` / `streaming.progress.commandText` controls command/exec detail in compact progress lines: `status` (default, tool label only) or `raw` (explicit command text).

    Show the rolling tool log while hiding raw command/exec text:

    ```json
    {
      "channels": {
        "discord": {
          "streaming": {
            "mode": "progress",
            "progress": {
              "toolProgress": true,
              "commandText": "status"
            }
          }
        }
      }
    }
    ```

    Preview streaming is text-only; media replies fall back to normal delivery.

  </Accordion>

  <Accordion title="Ack reactions">
    Status reactions keep the acknowledgement stable throughout work. They do not add per-tool emoji, inactivity warnings, or a success flash. Actual failures retain the error reaction lifecycle.

    `ackReaction` sends an acknowledgement emoji while OpenClaw processes an inbound message.

    Resolution order:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - agent identity emoji fallback (`agents.entries.*.identity.emoji`, else "👀")

    Notes:

    - Discord accepts unicode emoji or custom emoji names.
    - Use `""` to disable the reaction for a channel or account.

    **Scope (`messages.ackReactionScope`):**

    Values: `"all"` (DMs + groups, including ambient room events), `"direct"` (DMs only), `"group-all"` (every group message except ambient room events, no DMs), `"group-mentions"` (groups when the bot is mentioned; **no DMs**, default), `"off"` / `"none"` (disabled).

    <Note>
    The default scope (`"group-mentions"`) does not fire ack reactions in direct messages or ambient room events. To get an ack reaction on inbound Discord DMs and quiet room events, set `messages.ackReactionScope` to `"all"`.
    </Note>

  </Accordion>

  <Accordion title="Outbound mention aliases">
    Use `mentionAliases` when agents need deterministic outbound mentions for known Discord users. Keys are handles without the leading `@`; values are Discord user IDs. Unknown handles, `@everyone`, `@here`, and mentions inside Markdown code spans are left unchanged.

```json5
{
  channels: {
    discord: {
      mentionAliases: {
        SupportLead: "123456789012345678",
      },
      accounts: {
        ops: {
          mentionAliases: {
            OpsLead: "234567890123456789",
          },
        },
      },
    },
  },
}
```

  </Accordion>
</AccordionGroup>
