---
summary: "Fixes for silent groups, missing commands, rejected tokens, and unstable polling"
read_when:
  - The bot does not reply in a Telegram group
  - Commands are missing or the token is rejected at startup
  - Long polling stalls or Telegram API calls fail
title: "Telegram troubleshooting"
sidebarTitle: "Troubleshooting"
---

Symptom-first checks for a Telegram bot that is not behaving.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Bot does not respond to non mention group messages">

    - If `requireMention=false`, Telegram privacy mode must allow full visibility: BotFather `/setprivacy` -> Disable, then remove + re-add the bot to the group.
    - `openclaw channels status` warns when config expects unmentioned group messages.
    - `openclaw channels status --probe` checks explicit numeric group IDs; wildcard `"*"` cannot be membership-probed.
    - Quick session test: `/activation always`.

  </Accordion>

  <Accordion title="Bot not seeing group messages at all">

    - When `channels.telegram.groups` exists, the group must be listed (or include `"*"`).
    - Verify bot membership in the group.
    - Review `openclaw logs --follow` for skip reasons.

  </Accordion>

  <Accordion title="Commands work partially or not at all">

    - Authorize your sender identity (pairing and/or numeric `allowFrom`); command authorization still applies even when group policy is `open`.
    - `setMyCommands failed` with `BOT_COMMANDS_TOO_MUCH` means the native menu has too many entries; reduce plugin/skill/custom commands or disable native menus.
    - `deleteMyCommands` / `setMyCommands` startup calls and `sendChatAction` typing calls are bounded and retry once through Telegram's transport fallback on request timeout. Persistent network/fetch errors usually mean DNS/HTTPS to `api.telegram.org` is unreachable.

  </Accordion>

  <Accordion title="Startup reports unauthorized token">

    - `getMe returned 401` is a Telegram auth failure for the configured bot token. Re-copy or regenerate the token in BotFather, then update `channels.telegram.botToken`, `tokenFile`, `accounts.<id>.botToken`, or `TELEGRAM_BOT_TOKEN` (default account).
    - `deleteWebhook 401 Unauthorized` during startup is also an auth failure; treating it as "no webhook exists" would only defer the same bad-token failure to a later API call.

  </Accordion>

  <Accordion title="Polling or network instability">

    - Node 22+ with a custom fetch/proxy can trigger immediate abort behavior if `AbortSignal` types mismatch.
    - Some hosts resolve `api.telegram.org` to IPv6 first; broken IPv6 egress causes intermittent API failures.
    - Logs with `TypeError: fetch failed` or `Network request for 'getUpdates' failed!` are retried as recoverable network errors.
    - During polling startup, OpenClaw reuses the successful startup `getMe` probe for grammY so the runner does not need a second `getMe` before the first `getUpdates`.
    - If `deleteWebhook` fails with a transient network error during polling startup, OpenClaw continues into long polling instead of making another pre-poll control-plane call. A still-active webhook then surfaces as a `getUpdates` conflict; OpenClaw rebuilds the transport and retries webhook cleanup.
    - `Polling stall detected` in logs means OpenClaw restarts polling and rebuilds the transport after 120 seconds without completed long-poll liveness by default.
    - `openclaw channels status --probe` and `openclaw doctor` warn when a running polling account has not completed `getUpdates` after startup grace, a running webhook account has not completed `setWebhook` after startup grace, or the last successful polling transport activity is stale.
    - Telegram honors process proxy env for Bot API transport: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase variants. `NO_PROXY` / `no_proxy` can still bypass `api.telegram.org`.
    - If `OPENCLAW_PROXY_URL` is set for a service environment and no standard proxy env is present, Telegram uses that URL for Bot API transport too.
    - If text works but attachments fail with `getaddrinfo EAI_AGAIN` or `ENOTFOUND`, bare proxy environment variables still leave media downloads subject to local DNS checks. Set `channels.telegram.proxy` to your trusted HTTP(S) or SOCKS5 proxy so it resolves media hostnames, or configure a [managed network proxy](/security/network-proxy). The proxy endpoint itself must remain locally resolvable and reachable. `dangerouslyAllowPrivateNetwork` does not fix missing DNS.
    - On VPS hosts with unstable direct egress/TLS, route Telegram API calls through a proxy:

```yaml
channels:
  telegram:
    proxy: socks5://<user>:<password>@proxy-host:1080
```

    - Node 22+ defaults to `autoSelectFamily=true` (except WSL2). Telegram DNS result order honors `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER`, then `channels.telegram.network.dnsResultOrder`, then the process default (for example `NODE_OPTIONS=--dns-result-order=ipv4first`), falling back to `ipv4first` on Node 22+ if none applies.
    - On WSL2, or when IPv4-only behavior works better, force family selection:

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

    - RFC 2544 benchmark-range answers (`198.18.0.0/15`) are already allowed for Telegram media downloads by default. If a trusted fake-IP or transparent proxy rewrites `api.telegram.org` to some other private/internal/special-use address during media downloads, opt in to the Telegram-only bypass:

```yaml
channels:
  telegram:
    network:
      dangerouslyAllowPrivateNetwork: true
```

    - The same opt-in is available per account at `channels.telegram.accounts.<accountId>.network.dangerouslyAllowPrivateNetwork`.
    - If your proxy resolves Telegram media hosts into `198.18.x.x`, leave the dangerous flag off first — that range is already allowed by default.

    <Warning>
      `channels.telegram.network.dangerouslyAllowPrivateNetwork` weakens Telegram media SSRF protections. Use it only for trusted operator-controlled proxy environments (Clash, Mihomo, Surge fake-IP routing) that synthesize private or special-use answers outside the RFC 2544 benchmark range. Leave it off for normal public internet Telegram access.
    </Warning>

    - Temporary environment overrides: `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`, `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1`, `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`.
    - Validate DNS answers:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

More help: [Channel troubleshooting](/channels/troubleshooting).
