---
summary: "Runtime model, stream previews, native commands, reply tags, ack reactions, and send limits"
read_when:
  - Understanding how Telegram messages flow through the gateway
  - Tuning live previews, tool-progress lines, or reply threading
  - Changing chunk limits or sending from the CLI
title: "Telegram message behavior"
sidebarTitle: "Message behavior"
---

How inbound and outbound Telegram messages are routed, previewed, acknowledged, and delivered.

## Runtime behavior

- Telegram message handling runs inside the gateway process.
- Routing is deterministic: Telegram inbound replies back to Telegram (the model does not pick channels).
- Inbound messages normalize into the shared channel envelope with reply metadata, media placeholders, and persisted reply-chain context for replies the gateway has observed.
- Group sessions are isolated by group ID. Forum topics append `:topic:<threadId>`.
- When the bot joins an allowed group or supergroup, it posts one introduction grounded in available room metadata: the group title, description, and pinned message. The Telegram Bot API cannot read group messages from before the bot joined, so introductions never claim to use prior chat history. Introductions are enabled by default, never run in private chats, and can be disabled with `channels.telegram.joinIntro: false` or overridden per account with `channels.telegram.accounts.<accountId>.joinIntro`. See [group join introductions](/channels#group-join-introductions) for once-per-room behavior and untrusted-content handling.
- DM messages can carry `message_thread_id`; OpenClaw preserves it for replies. DM topic sessions split only when Telegram `getMe` reports `has_topics_enabled: true` for the bot; otherwise DMs stay on the flat session.
- Long polling runs in an isolated worker. Updates are saved to a durable queue and processed in order for each chat and topic.
- Multi-account startup bounds concurrent `getMe` probes so large bot fleets do not fan out every account probe at once.
- Each gateway process guards long polling so only one active poller can use a bot token at a time. Persistent `getUpdates` 409 conflicts point to another OpenClaw gateway, script, or external poller using the same token.
- The polling watchdog restarts after 120 seconds without completed `getUpdates` liveness.
- Telegram Bot API has no read-receipt support (`sendReadReceipts` does not apply).

<Note>
  **Upgrade note: Telegram's default preview changed.** With `channels.telegram.streaming` unset, Telegram now keeps one editable status draft during the turn (the agent's current status plus its tool lines) and sends the final answer as a normal message. It previously streamed the answer text itself into the preview. No config becomes invalid and no `doctor --fix` is needed; to keep the previous behavior, set:

```json5
{ channels: { telegram: { streaming: { mode: "partial" } } } }
```

</Note>

<Note>
  `channels.telegram.dm.threadReplies` and `channels.telegram.direct.<chatId>.threadReplies` were removed. Run `openclaw doctor --fix` after upgrading if your config still has those keys. DM topic routing now follows Telegram `getMe.has_topics_enabled` (controlled by BotFather threaded mode): topics-enabled bots use thread-scoped DM sessions when Telegram sends `message_thread_id`; other DMs stay on the flat session.
</Note>

## Message behavior

<AccordionGroup>
  <Accordion title="Live stream preview (message edits)">
    OpenClaw streams partial replies in real time in direct chats, groups, and topics: send a preview message, then `editMessageText` repeatedly, finalizing in place.

    - `channels.telegram.streaming` is `off | partial | block | progress` (default: `progress`); set `mode: "partial"` to stream answer text into the preview instead of a status draft
    - short initial answer previews are debounced, then materialized after a bounded delay if the run is still active
    - `progress` keeps one editable status draft, shows the stable status label when answer activity arrives before tool progress, clears it at completion, and sends the final answer as a normal message. By default the draft is quiet: status headline, commentary, plan milestones, and approval or failure lines. `streaming.progress.toolProgress: true` adds the rolling tool log.
    - `streaming.preview.toolProgress` controls whether tool/progress updates reuse the same edited preview message in `partial` and `block` modes (default: `true` when preview streaming is active)
    - `streaming.preview.commandText` controls command/exec detail inside those lines: `status` (default, tool label only) or `raw` (explicit command text)
    - `streaming.progress.commentary` (default: `false`) opts into assistant commentary/preamble text in the temporary progress draft
    - legacy `channels.telegram.streamMode`, boolean `streaming` values, and retired native draft preview keys are detected; run `openclaw doctor --fix` to migrate them

    Tool-progress lines are the short status updates shown while tools run (command execution, file reads, planning updates, patch summaries, Codex preamble/commentary in app-server mode). `partial` and `block` previews show them by default; the `progress` draft shows them only with `streaming.progress.toolProgress: true`. Compaction status follows the same settings and appears as soon as compaction starts, including before the first model output.

    Keep answer-preview edits but hide tool-progress lines:

    ```json
    {
      "channels": {
        "telegram": {
          "streaming": {
            "mode": "partial",
            "preview": { "toolProgress": false }
          }
        }
      }
    }
    ```

    Keep tool-progress visible but hide command/exec text:

    ```json
    {
      "channels": {
        "telegram": {
          "streaming": {
            "mode": "partial",
            "preview": { "commandText": "status" }
          }
        }
      }
    }
    ```

    `progress` mode can show the tool log without editing the final answer into that message. Opt in with `toolProgress: true` and put the command-text policy under `streaming.progress`:

    ```json
    {
      "channels": {
        "telegram": {
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

    `streaming.mode: "off"` disables preview edits and suppresses generic tool/progress chatter instead of sending it as standalone status messages; approval prompts, media, and errors still route through normal final delivery. `streaming.preview.toolProgress: false` keeps only answer-preview edits.

    <Note>
      Selected quote replies are the exception. When `replyToMode` is `first`, `all`, or `batched` and the inbound message has selected quote text, OpenClaw sends the final answer through Telegram's native quote-reply path and skips draft previews for that turn. Current-message replies without selected quote text still stream. Set `replyToMode: "off"` when tool-progress visibility matters more than native quote replies. To keep native quote replies and hide tool-progress lines, use `streaming.progress.toolProgress: false` in `progress` mode or `streaming.preview.toolProgress: false` in `partial` and `block` modes.
    </Note>

    For text-only replies: short previews get the final edit in place; long finals that split into multiple messages reuse the preview as the first chunk, then send only the remainder; progress-mode finals clear the status draft and use normal final delivery; if the final edit fails before completion is confirmed, OpenClaw falls back to normal final delivery and cleans up the stale preview. For complex replies (media payloads), OpenClaw always falls back to normal final delivery and cleans up the preview.

    Preview streaming and block streaming are mutually exclusive. An explicit non-`off` preview mode overrides inherited `agents.defaults.blockStreamingDefault: "on"`; explicit `streaming.block.enabled: true` overrides the preview. If a turn cannot use previews, inherited block delivery still applies.

    Reasoning: `/reasoning stream` streams reasoning into the live preview while generating, then deletes the reasoning preview after final delivery (use `/reasoning on` to keep it visible). The final answer is sent without reasoning text.

  </Accordion>

  <Accordion title="Native commands and custom commands">
    Telegram's command menu is registered at startup with `setMyCommands`. `commands.native: "auto"` enables native commands for Telegram.

    Add custom command menu entries:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

    Rules: names are normalized (strip leading `/`, lowercase); valid pattern `a-z`, `0-9`, `_`, length 1-32; custom commands cannot override native commands; conflicts/duplicates are skipped and logged.

    When Telegram menu limits require trimming, configured custom commands come first unless omitted per-skill entries are replaced by a leading `/skill` fallback.

    Custom commands are menu entries only — they do not auto-implement behavior. Plugin/skill commands can still work when typed even if not shown in the Telegram menu. If native commands are disabled, built-ins are removed; custom/plugin commands may still register if configured.

    Common setup failures:

    - `setMyCommands failed` with `BOT_COMMANDS_TOO_MUCH` after a trim retry means the menu still overflows; reduce plugin/skill/custom commands or disable `channels.telegram.commands.native`.
    - `deleteWebhook`, `deleteMyCommands`, or `setMyCommands` failing with `404: Not Found` while direct Bot API curl commands work usually means `channels.telegram.apiRoot` was set to the full `/bot<TOKEN>` endpoint. `apiRoot` must be the Bot API root only; `openclaw doctor --fix` removes an accidental trailing `/bot<TOKEN>`.
    - `getMe returned 401` means Telegram rejected the configured bot token. Update `botToken`, `tokenFile`, or `TELEGRAM_BOT_TOKEN` (default account) with the current BotFather token; OpenClaw stops before polling so this is not reported as a webhook cleanup failure.
    - `setMyCommands failed` with network/fetch errors usually means outbound DNS/HTTPS to `api.telegram.org` is blocked.

    ### Device pairing commands (`device-pair` plugin)

    When installed:

    1. `/pair` generates a setup code
    2. paste the code in the iOS app
    3. `/pair pending` lists pending requests (including role/scopes)
    4. approve: `/pair approve <requestId>`, `/pair approve` (only pending request), or `/pair approve latest`

    If a device retries with changed auth details (role, scopes, public key), the previous pending request is superseded with a new `requestId`; re-run `/pair pending` before approving.

    More detail: [Pairing](/channels/pairing#pair-via-telegram).

  </Accordion>

  <Accordion title="Reply threading tags">
    Explicit reply threading tags in generated output:

    - `[[reply_to_current]]` — replies to the triggering message
    - `[[reply_to:<id>]]` — replies to a specific message ID

    `channels.telegram.replyToMode`: `off` (default), `first`, `all`.

    When reply threading is enabled and the original text/caption is available, OpenClaw adds a native quote excerpt automatically. Telegram caps native quote text at 1024 UTF-16 code units; longer messages are quoted from the start and fall back to a plain reply if Telegram rejects the quote.

    `off` disables implicit reply threading only; explicit `[[reply_to_*]]` tags are still honored.

  </Accordion>

  <Accordion title="Ack reactions">
    `ackReaction` sends an acknowledgement emoji while OpenClaw processes an inbound message. `messages.ackReactionScope` decides *when* it is sent.

    **Emoji resolution order:**

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - agent identity emoji fallback (`agents.entries.*.identity.emoji`, else "👀")

    Telegram expects a unicode emoji (for example "👀"); use `""` to disable the reaction for a channel or account.

    **Scope (`messages.ackReactionScope`, default `"group-mentions"`; no Telegram-account or Telegram-channel override today):**

    `all` (DMs + groups, including ambient room events), `direct` (DMs only), `group-all` (every group message except ambient room events, no DMs), `group-mentions` (groups when the bot is mentioned; **no DMs** — default), `off` / `none` (disabled).

    <Note>
    The default scope (`group-mentions`) does not fire ack reactions in DMs or ambient room events. Use `direct` or `all` for DMs; only `all` acknowledges ambient room events. This value is read at Telegram provider startup, so a gateway restart is needed for the change to take effect.
    </Note>

  </Accordion>

  <Accordion title="Limits and CLI targets">
    - `channels.telegram.textChunkLimit` default 4000; `streaming.chunkMode="newline"` prefers paragraph boundaries (blank lines) before length splitting.
    - `channels.telegram.mediaMaxMb` (default 100) caps inbound and outbound media size.
    - When an inbound attachment cannot be downloaded and the message proceeds to the agent, its body includes a `[media unavailable: ...]` notice. Oversize notices include the effective size limit; partial albums include the failed and total attachment counts. This also applies to admitted channel posts, even when their separate chat warning is suppressed.
    - group context history uses `channels.telegram.historyLimit` or `messages.groupChat.historyLimit` (default 50); `0` disables.
    - reply/quote/forward supplemental context normalizes into one selected conversation context window when the gateway has observed the parent messages; the observed-message cache lives in OpenClaw SQLite plugin state, and `openclaw doctor --fix` imports legacy sidecars. Telegram only includes one shallow `reply_to_message` per update, so chains older than the cache are limited to that payload.
    - Telegram allowlists primarily gate who can trigger the agent, not a full supplemental-context redaction boundary.
    - DM history: `channels.telegram.dmHistoryLimit`, `channels.telegram.dms["<user_id>"].historyLimit`.

    CLI and message-tool send targets accept a numeric chat ID, username, or forum topic target:

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
openclaw message send --channel telegram --target -1001234567890:topic:42 --message "hi topic"
```

    Polls use `openclaw message poll` and support forum topics:

```bash
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300 --poll-public
```

    Telegram-only poll flags: `--poll-duration-seconds` (5-604800; up to seven days), `--poll-anonymous`, `--poll-public`, `--thread-id` (or a `:topic:` target). `--poll-option` repeats 2-12 times (Telegram's option cap).

    Telegram send also supports `--presentation` with `buttons` blocks for inline keyboards (when `channels.telegram.capabilities.inlineButtons` allows it), `--pin` or `--delivery '{"pin":true}'` to request pinned delivery when the bot can pin in that chat, and `--force-document` to send outbound images, GIFs, and videos as documents instead of compressed/animated/video uploads.

    Action gating: `channels.telegram.actions.sendMessage=false` disables all outbound messages including polls; `channels.telegram.actions.poll=false` disables poll creation while leaving regular sends enabled.

  </Accordion>
</AccordionGroup>
