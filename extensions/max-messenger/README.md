# @openclaw/max-messenger

OpenClaw bundled channel plugin for [MAX](https://max.ru/) — the Russian messenger by VK.

> **Phase 1A scaffolding.** This package only ships the plugin skeleton:
> manifests, the `channels.max-messenger` Zod schema, the `ChannelPlugin`
> assembly, token resolution, and adapter stubs. There is no polling supervisor,
> no inbound dispatch, and no real outbound delivery yet — `start()` logs a
> single line and returns; `sendText` records a placeholder and returns a stub
> message id; `sendMedia` and `sendPoll` throw.
>
> The polling supervisor (custom HTTP wrapper, marker store, dedup LRU,
> fake-MAX harness) lands in **Phase 1B** per
> [`docs/max-plugin/plan.md`](../../docs/max-plugin/plan.md) §6 Phase 1B and
> §6.1.6.

## Status by phase

| Phase | Scope                                     | Status       |
| ----- | ----------------------------------------- | ------------ |
| 1A    | Scaffolding (manifests, schema, adapters) | this package |
| 1B    | Polling supervisor + fake-MAX harness     | next         |
| 1C    | Manual smoke against a real bot           | post-token   |
| 2     | Webhook transport                         | future       |
| 3     | Callback buttons / inline keyboard        | future       |
| 4     | Attachments                               | future       |
| 5     | Multi-account + standalone npm release    | future       |

## Configuring the channel

The channel is registered with id `max-messenger` (alias `max`). All Phase 1A
config keys live under `channels.max-messenger.*`. Only `dmPolicy: "pairing"`
and the token resolution path are exercised at this point.

```jsonc
{
  "channels": {
    "max-messenger": {
      // Either reference a token file…
      "tokenFile": "~/.openclaw/credentials/max-messenger-bcai.token",
      // …or inline a SecretInput (env: ref or string).
      // "token": { "ref": "env:default:MAX_BOT_TOKEN" },

      "transport": "polling",
      "dmPolicy": "pairing",
      "allowFrom": ["12345678"],
    },
  },
}
```

The `MAX_BOT_TOKEN` env variable is honored as a fallback for the default
account, mirroring `TELEGRAM_BOT_TOKEN`.

## Phase 1A behavior

- `openclaw channels list` shows MAX with the right metadata.
- Schema validation rejects malformed `channels.max-messenger.*` blocks.
- Starting the gateway emits one log line per account and exits cleanly on
  shutdown.
- No outbound network calls are issued; no inbound MAX events are processed.

## References

- Implementation plan: [`docs/max-plugin/plan.md`](../../docs/max-plugin/plan.md)
- Project context: [`docs/max-plugin/CONTEXT.md`](../../docs/max-plugin/CONTEXT.md)
- Upstream stability check: [`docs/max-plugin/upstream-sync-2026.5.2.md`](../../docs/max-plugin/upstream-sync-2026.5.2.md)
