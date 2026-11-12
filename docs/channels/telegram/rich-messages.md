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

    When enabled: every OpenClaw agent turn delivered to this bot/account (replies, heartbeats, cron announces, and subagent announces) is told rich messages are available, with the supported Markdown + HTML-island authoring contract; Markdown text renders through OpenClaw's Markdown IR as typed Bot API 10.3 rich blocks (headings, tables, details, checklists, rich media, formulas, maps, collages); media captions still use Telegram HTML captions (rich messages do not replace captions, and captions cap at 1024 characters).

    Ordinary rich body text, including list items, quotes, and disclosure bodies, preserves parsed Markdown spaces and newlines. Entities decode once: `&amp;` displays `&`, while `\&amp;` and `&amp;amp;` display literal `&amp;`. Escaped tags such as `&lt;b&gt;` stay visible text, and image alternatives stay plain text; neither becomes an HTML island. Unsupported HTML stays visible without suppressing Markdown formatting inside it. HTML attributes and recognized inline comments retain their literal source during Markdown parsing; supported attributes are then decoded by the HTML mapper. HTML-island summaries and figure captions keep their separate HTML normalization.

    This keeps model text away from Telegram's rich-Markdown sigils, so currency like `$400-600K` is not parsed as math. Long rich text splits automatically across Telegram's limits. Tables over the 20-column limit fall back to a code block.

    A table followed by a quote, list, heading, code block, or paragraph stays a separate block. Tables authored inside a quote or list stay inside that container, including when they are its final content.

    Default: off, for client compatibility — some current Desktop, Web, Android, and third-party clients render accepted rich messages as unsupported. Keep this off unless every client used with the bot can render them. `/status` shows whether the current session has rich messages on or off.

    With rich messages off, tight numbered Markdown lists keep properly indented bullet children attached to their parent without added blank lines. Separate bullet and numbered sections keep their paragraph spacing.

    Caller-authored HTML escapes literal `<` characters without consuming a later supported tag or a closing code tag. A supported start tag without a matching end tag, such as `<b>` mentioned in prose, stays visible as text instead of making Telegram reject the message. Existing tag, attribute, and entity restrictions still apply.

    Link previews are on by default. `channels.telegram.linkPreview: false` disables automatic entity detection for rich text. OpenClaw explicitly marks bare URLs so they remain tappable, except URLs containing `&`, which stay plain to avoid Telegram's query-separator encoding issue. Use a labeled Markdown link for those URLs.

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

    Shared `message` tool example (`action: "send"`, `channel: "telegram"`):

    Availability follows the layered [tool policy](/gateway/config-tools/tool-policy). A Telegram account must be configured and enabled, the `message` tool must be allowed for the run, and `channels.telegram.actions.sendMessage` must not be disabled. For button-bearing sends, `inlineButtons: "off"` blocks the controls, while `"dm"` and `"group"` restrict the target chat type. Callback clicks are authorized separately by Telegram access policy; `"allowlist"` applies the configured sender authorization.

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

    Agent messages created from button clicks use the time OpenClaw received the click, not the original card's send time. Queued or replayed clicks retain that receipt time.

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

    Gating: `channels.telegram.actions.sendMessage`, `poll`, `deleteMessage`, `reactions`, `editMessage`, `createForumTopic`, and `editForumTopic` are enabled by default; set one to `false` to disable it. Poll creation requires both `sendMessage` and `poll`. `sticker` is disabled by default and must be enabled explicitly. `reactions` controls both `react` and `emoji-list`.
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

    Delegated OpenClaw change approvals return their final result to the requesting chat or topic, even when the approval card was sent to an approver DM. An edited card in the requesting topic serves as the result there without an extra notice.

    Inline approval buttons also require `channels.telegram.capabilities.inlineButtons` to allow the target surface (`dm`, `group`, or `all`). Approval IDs prefixed with `plugin:` resolve through plugin approvals; others resolve through exec approvals first.

    See [Exec approvals](/tools/exec-approvals).

  </Accordion>
  <Accordion title="Message widgets">
    Opt in to send `show_widget` as a [Telegram message widget](https://core.telegram.org/bots/widgets) (Bot API 10.4), a small interactive card inside a private chat with the bot:

```json5
{
  channels: {
    telegram: {
      widgets: true,
    },
  },
}
```

    Default: off, for client compatibility. Older Telegram clients cannot render widgets, so keep this off unless every client used with the bot is current. The setting also works per account (`channels.telegram.accounts.<id>.widgets`). `/status` shows whether widgets are on. While it is off, `show_widget` behaves as before and taps on earlier widgets are dropped. Groups, channels, and DM topics always use the normal widget surfaces.

    - **No network.** Widgets run in Telegram's sandbox without CDNs, libraries, or remote images. The agent draws charts with inline SVG or canvas and inlines images as `data:` URLs.
    - **Limits.** 32 KB of HTML and 4 KB after compression. There are no text inputs; widgets use buttons.
    - **Trial run.** Before sending, OpenClaw runs the widget once in QuickJS with a stand-in DOM, its timers, and a tap on every enabled button. Script errors, endless loops, removed elements, unsupported CSS (`vh`, `sticky`, scrolling, `color-mix()`), network use, element and CSS-rule limits, and `request()` outside a tap go back to the agent to fix, and the widget is not sent until they pass. Approximate findings (more than 16 translucent or shadowed elements, `undefined`/`NaN` on screen) are passed to the agent as notes while the widget is still sent. Widgets that use web APIs the trial run does not model, such as `URL`, are sent unchecked.
    - **Taps.** A widget that calls `TelegramWidget.request(data)` reaches the agent as `widget_request: <data>`. The tap is acknowledged at once. The agent answers by calling `show_widget` with only the new `state` (at most 1,024 bytes), which updates the tapped widget in place without an "edited" mark or a new message. New widget code always sends a new message, and a typed message always starts a new one.
    - **Rate limits.** Widget code cannot send `/` or `!` commands. Each widget gets at most 10 requests per minute, and the same request text reaches the agent once per minute.

  </Accordion>
</AccordionGroup>
