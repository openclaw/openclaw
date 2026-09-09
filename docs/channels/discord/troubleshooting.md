---
summary: "Fixes for blocked guild messages, intent errors, gateway timeouts, bot loops, and voice STT drops"
read_when:
  - The Discord bot does not reply in a guild channel or DM
  - Discord gateway timeouts, duplicate replies, or bot-to-bot loops appear
  - Voice speech-to-text drops with a decryption failure
title: "Discord troubleshooting"
sidebarTitle: "Troubleshooting"
---

Symptom-first checks for a Discord account that is not behaving.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Used disallowed intents or bot sees no guild messages">

    - enable Message Content Intent
    - enable Server Members Intent when you depend on user/member resolution
    - restart gateway after changing intents

  </Accordion>

  <Accordion title="Guild messages blocked unexpectedly">

    - verify `groupPolicy`
    - verify guild allowlist under `channels.discord.guilds`
    - if a guild `channels` map exists, only listed channels are allowed
    - verify `requireMention` behavior and mention patterns

    The Control UI channel details and `openclaw channels status` warn when the
    effective policy is `allowlist` but no guilds are configured. Add your server
    under `channels.discord.guilds`, or the account's `guilds` map when overridden.
    An explicit `channels.discord.accounts.default.guilds` map also overrides the
    top-level map, even when the account map is empty.

    If status reports a deferred configuration reload, wait for active work to
    finish and refresh. A successful channel stop/start does not apply unpublished
    configuration. The warning distinguishes waiting to publish configuration
    from channel work deferred after publication; connection health alone does
    not confirm that a policy change has applied.

    Useful checks:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Require mention false but still blocked">
    Common causes:

    - `groupPolicy="allowlist"` without matching guild/channel allowlist
    - `requireMention` configured in the wrong place (must be under `channels.discord.guilds` or a channel entry)
    - sender blocked by guild/channel `users` allowlist

  </Accordion>

  <Accordion title="Long-running Discord turns or duplicate replies">

    Typical logs:

    - `Slow listener detected ...`
    - `stuck session: sessionKey=agent:...:discord:... state=processing ...`

    Discord does not apply a channel-owned timeout to queued agent turns. Message listeners hand off immediately, and queued Discord runs preserve per-session ordering until the session/tool/runtime lifecycle completes or aborts the work.

  </Accordion>

  <Accordion title="Gateway metadata lookup timeout warnings">
    OpenClaw fetches Discord `/gateway/bot` metadata before connecting. Transient failures fall back to Discord's default gateway URL and are rate-limited in logs.

    The metadata timeout defaults to 30 seconds. `OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS` can override it for unusual host environments.

  </Accordion>

  <Accordion title="Gateway READY timeout restarts">
    OpenClaw waits for Discord's gateway `READY` event during startup and after runtime reconnects. Multi-account setups with startup staggering can need a longer startup READY window than the default.

    Startup waits 15 seconds and runtime reconnects wait 30 seconds. `OPENCLAW_DISCORD_READY_TIMEOUT_MS` and `OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS` remain available for unusual host environments.

  </Accordion>

  <Accordion title="Permissions audit mismatches">
    `channels status --probe` permission checks only work for numeric channel IDs.

    If you use slug keys, runtime matching can still work, but probe cannot fully verify permissions.

  </Accordion>

  <Accordion title="DM and pairing issues">

    - DM disabled: `channels.discord.dm.enabled=false`
    - DM policy disabled: `channels.discord.dmPolicy="disabled"` (legacy: `channels.discord.dm.policy`)
    - awaiting pairing approval in `pairing` mode

  </Accordion>

  <Accordion title="Bot to bot loops">
    By default bot-authored messages are ignored.

    If you set `channels.discord.allowBots=true`, use strict mention and allowlist rules to avoid loop behavior.
    Prefer `channels.discord.allowBots="mentions"` to only accept bot messages that mention the bot.
    In `"mentions"` mode, reply-ping metadata alone does not count. Bot replies need an active native mention or a configured text/transcript mention outside Markdown code.

    OpenClaw also ships shared [bot loop protection](/channels/bot-loop-protection). Whenever `allowBots` lets bot-authored messages reach dispatch, Discord maps the inbound event to `(account, channel, bot pair)` facts and the generic pair guard suppresses the pair after it crosses the configured event budget. The guard prevents runaway two-bot loops that previously had to be stopped by Discord rate limits; it does not affect single-bot deployments or one-shot bot replies that stay under the budget.

    Default settings (active when `allowBots` is set):

    - `maxEventsPerWindow: 20` -- bot pair can exchange 20 messages within the sliding window
    - `windowSeconds: 60` -- sliding window length
    - `cooldownSeconds: 60` -- once the budget trips, every additional bot-to-bot message in either direction is dropped for one minute

    Configure the shared default once under `channels.defaults.botLoopProtection`, then override Discord when a legitimate workflow needs more headroom. Precedence is:

    - `channels.discord.accounts.<account>.botLoopProtection`
    - `channels.discord.botLoopProtection`
    - `channels.defaults.botLoopProtection`
    - built-in defaults

    Discord uses the generic `maxEventsPerWindow`, `windowSeconds`, and `cooldownSeconds` keys.

```json5
{
  channels: {
    defaults: {
      botLoopProtection: {
        maxEventsPerWindow: 20,
        windowSeconds: 60,
        cooldownSeconds: 60,
      },
    },
    discord: {
      // Optional Discord-wide override. Account blocks override individual
      // fields and inherit omitted fields from here.
      botLoopProtection: {
        maxEventsPerWindow: 4,
      },
      accounts: {
        alpha: {
          // Alpha listens to other bots only when they mention it.
          allowBots: "mentions",
        },
        bravo: {
          // Bravo listens to all bot-authored Discord messages.
          allowBots: true,
          mentionAliases: {
            // Lets Bravo write an Alpha Discord mention with the configured user id.
            Alpha: "ALPHA_DISCORD_USER_ID",
          },
          botLoopProtection: {
            // Allow up to five messages per minute before suppressing the pair.
            maxEventsPerWindow: 5,
            windowSeconds: 60,
            cooldownSeconds: 90,
          },
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="Voice STT drops with DecryptionFailed(...)">

    - keep OpenClaw current (`openclaw update`) so the Discord voice receive recovery logic is present
    - confirm `channels.discord.voice.daveEncryption=true` (default)
    - start from `channels.discord.voice.decryptionFailureTolerance=24` (upstream default) and tune only if needed
    - watch logs for:
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - if failures continue after automatic rejoin, collect logs and compare against the upstream DAVE receive history in [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) and [discord.js #11449](https://github.com/discordjs/discord.js/pull/11449)

  </Accordion>
</AccordionGroup>
