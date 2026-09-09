---
summary: "Bot API 10.3 rich messages, inline buttons, message actions, and exec approvals"
read_when:
  - Sending buttons, stickers, or rich blocks from an agent
  - Enabling Telegram message actions for automation
  - Approving exec requests from inside Telegram
title: "Telegram rich messages and approvals"
sidebarTitle: "Rich messages and approvals"
---

Rich Telegram surfaces: formatted messages, inline keyboards, agent message actions, and approval prompts.

## Rich messages and approvals

<AccordionGroup>
  <Accordion title="Rich message formatting">
    Outbound text uses standard Telegram HTML messages by default, readable across current clients: bold, italic, links, code, spoilers, quotes — not Bot API 10.3 rich-only blocks (native tables, details, rich media, formulas).
    Fenced code retains its literal content and spacing, including fence examples inside the block.

    Opt into Bot API 10.3 rich messages:

```json5
{
  channels: {
    telegram: {
      richMessages: true,
    },
  },
}
```

    When enabled: the agent is told rich messages are available for this bot/account (with the supported Markdown + HTML-island authoring contract); Markdown text renders through OpenClaw's Markdown IR as typed Bot API 10.3 rich blocks (headings, tables, details, checklists, rich media, formulas, maps, collages); media captions still use Telegram HTML captions (rich messages do not replace captions, and captions cap at 1024 characters).

    Ordinary rich body text, including list items, quotes, and disclosure bodies, preserves parsed Markdown spaces and newlines. Entities decode once: `&amp;` displays `&`, while `\&amp;` and `&amp;amp;` display literal `&amp;`. Escaped tags such as `&lt;b&gt;` stay visible text, and image alternatives stay plain text; neither becomes an HTML island. Unsupported HTML stays visible without suppressing Markdown formatting inside it. HTML attributes and recognized inline comments retain their literal source during Markdown parsing; supported attributes are then decoded by the HTML mapper. HTML-island summaries and figure captions keep their separate HTML normalization.

    This keeps model text away from Telegram's rich-Markdown sigils, so currency like `$400-600K` is not parsed as math. Long rich text splits automatically across Telegram's limits. Tables over the 20-column limit fall back to a code block.

    Default: off, for client compatibility — some current Desktop, Web, Android, and third-party clients render accepted rich messages as unsupported. Keep this off unless every client used with the bot can render them. `/status` shows whether the current session has rich messages on or off.

    Link previews are on by default. `channels.telegram.linkPreview: false` disables automatic entity detection for rich text.

  </Accordion>

  <Accordion title="Inline buttons">
    Configure inline keyboard scope:

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    Per-account override:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    Scopes: `off`, `dm`, `group`, `all`, `allowlist` (default). Legacy `capabilities: ["inlineButtons"]` maps to `"all"`.

    An account with `capabilities: []` inherits the channel capabilities. Use `capabilities: { inlineButtons: "off" }` to disable inline buttons explicitly.

    `ask_user` uses these native controls for one single-select question.
    Choices use one row each, and **Other…** opens Telegram's reply input.

    Message action example:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  presentation: {
    blocks: [
      {
        type: "buttons",
        buttons: [
          { label: "Yes", action: { type: "callback", value: "yes" }, style: "success" },
          { label: "No", action: { type: "callback", value: "no" }, style: "danger" },
          { label: "Cancel", action: { type: "callback", value: "cancel" } },
        ],
      },
    ],
  },
}
```

    Mini App button example:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Open app:",
  presentation: {
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: "Launch",
            action: { type: "web-app", url: "https://example.com/app" },
          },
        ],
      },
    ],
  },
}
```

    Mini App buttons only work in private chats between a user and the bot.

    Callback action values not claimed by a registered plugin interactive handler are passed to the agent as text: `callback_data: <value>`.

    With durable ingress, OpenClaw sends the callback acknowledgement after storing the update, without waiting for earlier handlers in that chat's lane. Telegram clears its loading indicator when the acknowledgement succeeds; the button's action still follows normal authorization and ordered processing.

  </Accordion>

  <Accordion title="Telegram message actions for agents and automation">
    Actions:

    - `sendMessage` (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `emoji-list` (optional `chatId`, `limit`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content` or `caption`, optional `presentation` inline buttons; button-only edits update reply markup)
    - `createForumTopic` (`chatId`, `name`, optional `iconColor`, `iconCustomEmojiId`)

    Ergonomic aliases: `send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`, `topic-create`.

    Gating: `channels.telegram.actions.sendMessage`, `deleteMessage`, `reactions`, `sticker` (default: disabled). `reactions` controls both `react` and `emoji-list`. `edit`, `createForumTopic`, and `editForumTopic` are enabled by default with no dedicated toggle.
    Runtime sends use the active config/secrets snapshot from startup/reload, so action paths do not re-resolve `SecretRef` values per send.

    Use `emoji-list` to inspect reactions in the current trusted chat and account. Agents cannot inspect another chat; direct operators may provide a different `chatId`. `limit` defaults to and cannot exceed 100:

```json
{
  "ok": true,
  "emojis": [
    { "name": "👍", "identifier": "👍" },
    { "identifier": "5368324170671202286", "type": "custom_emoji" }
  ]
}
```

    Pass a Unicode identifier or numeric custom emoji identifier directly to `react`. Chats without reaction restrictions return the known standard Telegram reactions and a `note` explaining that all standard reactions are allowed. When Telegram rejects a reaction, the error includes a short sample of allowed standard reactions and numeric custom emoji identifiers. If the allowed-reaction lookup fails, the error omits the sample.

    Reaction removal semantics: [/tools/reactions](/tools/reactions).

  </Accordion>

  <Accordion title="Exec approvals in Telegram">
    Telegram supports exec approvals in approver DMs and can optionally post prompts in the originating chat or topic. Approvers must be numeric Telegram user IDs.

    - `channels.telegram.execApprovals.enabled` (`"auto"` enables when at least one approver is resolvable)
    - `channels.telegram.execApprovals.approvers` (falls back to numeric owner IDs from `commands.ownerAllowFrom`)
    - `channels.telegram.execApprovals.target`: `dm` (default) | `channel` | `both`
    - `agentFilter`, `sessionFilter`

    `channels.telegram.allowFrom`, `groupAllowFrom`, and `defaultTo` control who can talk to the bot and where it sends normal replies — they do not make someone an exec approver. The first approved DM pairing bootstraps `commands.ownerAllowFrom` when no command owner exists yet, so one-owner setups work without duplicating IDs under `execApprovals.approvers`.

    Channel delivery shows the command text in the chat; only enable `channel` or `both` in trusted groups/topics. When the prompt lands in a forum topic, OpenClaw preserves the topic for the approval prompt and follow-up. Exec approvals expire after 30 minutes by default.

    Inline approval buttons also require `channels.telegram.capabilities.inlineButtons` to allow the target surface (`dm`, `group`, or `all`). Approval IDs prefixed with `plugin:` resolve through plugin approvals; others resolve through exec approvals first.

    See [Exec approvals](/tools/exec-approvals).

  </Accordion>
</AccordionGroup>
