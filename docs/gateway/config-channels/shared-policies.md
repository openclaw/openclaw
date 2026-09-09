---
summary: "Shared channel keys: DM and group access policies, model overrides, channel defaults, and multi-account setup"
read_when:
  - Setting DM policy, group policy, or mention defaults for every channel
  - Pinning a channel or DM peer to a specific model
  - Running more than one account on a channel
title: "Configuration — shared channel policies"
---

Keys under `channels.defaults` and `channels.modelByChannel` that apply to every channel, plus the shared multi-account pattern.

## DM and group access

All channels support DM policies and group policies:

| DM policy           | Behavior                                                        |
| ------------------- | --------------------------------------------------------------- |
| `pairing` (default) | Unknown senders get a one-time pairing code; owner must approve |
| `allowlist`         | Only senders in `allowFrom` (or paired allow store)             |
| `open`              | Allow all inbound DMs (requires `allowFrom: ["*"]`)             |
| `disabled`          | Ignore all inbound DMs                                          |

| Group policy          | Behavior                                               |
| --------------------- | ------------------------------------------------------ |
| `allowlist` (default) | Only groups matching the configured allowlist          |
| `open`                | Bypass group allowlists (mention-gating still applies) |
| `disabled`            | Block all group/room messages                          |

<Note>
`channels.defaults.groupPolicy` applies only when the resolved channel policy is unset. The channel schemas listed on the [per-channel pages](/gateway/config-channels) default the root to `allowlist`; set `channels.<channel>.groupPolicy` explicitly to choose another policy.
Pairing codes expire after 1 hour. Pending pairing requests are capped at **3 per account** (scoped by channel and account id).
If a provider block is missing entirely (`channels.<provider>` absent), runtime group policy falls back to `allowlist` (fail-closed) with a startup warning.
</Note>

## Channel model overrides

Use `channels.modelByChannel` to pin specific channel IDs or direct-message peers to a model. Values accept `provider/model` or configured model aliases. The channel mapping only applies when a session does not already have an active model override (for example, one set via `/model`). Changes refresh loaded channel runtimes without restarting the Gateway; manually stopped accounts stay stopped.

For group/thread conversations, keys are channel-specific group IDs, topic IDs, or channel names. For direct-message (DM) conversations, keys are peer identifiers derived from the channel's sender identity (`nativeDirectUserId`, `origin.from`, `origin.to`, `OriginatingTo`, `From`, or `SenderId`). The exact key form depends on the channel:

| Channel  | DM key form         | Example                                      |
| -------- | ------------------- | -------------------------------------------- |
| Discord  | raw user ID         | `987654321`                                  |
| Feishu   | `feishu:ou_...`     | `feishu:ou_a8b6cab7e945387de5f253775d9b4d85` |
| Matrix   | Matrix user ID      | `@user:matrix.org`                           |
| Slack    | `user:U...`         | `user:U12345`                                |
| Telegram | raw user ID         | `123456789`                                  |
| WhatsApp | phone number or JID | `15551234567`                                |

```json5
{
  channels: {
    modelByChannel: {
      discord: {
        "123456789012345678": "anthropic/claude-opus-4-6",
      },
      slack: {
        C1234567890: "openai/gpt-5.6-sol",
        "user:U12345": "openai/gpt-5.4-mini",
      },
      telegram: {
        "-1001234567890": "openai/gpt-5.4-mini",
        "-1001234567890:topic:99": "anthropic/claude-sonnet-4-6",
        "123456789": "openai/gpt-4.1",
      },
    },
  },
}
```

DM-specific keys only match in direct-message conversations; they do not affect group/thread routing.

## Channel defaults and heartbeat

Use `channels.defaults` for shared group-policy, implicit-mention, and heartbeat behavior across providers. Changes refresh loaded channel runtimes without restarting the Gateway; manually stopped accounts stay stopped:

```json5
{
  channels: {
    defaults: {
      groupPolicy: "allowlist", // open | allowlist | disabled
      contextVisibility: "all", // all | allowlist | allowlist_quote
      implicitMentions: {
        replyToBot: true,
        quotedBot: true,
        threadParticipation: true,
      },
      heartbeatVisibility: {
        showOk: false,
        showAlerts: true,
        useIndicator: true,
      },
    },
  },
}
```

- `channels.defaults.groupPolicy`: fallback group policy when a provider-level `groupPolicy` is unset.
- `channels.defaults.contextVisibility`: default supplemental context visibility mode for all channels. Values: `all` (default, include all quoted/thread/history context), `allowlist` (only include context from allowlisted senders), `allowlist_quote` (same as allowlist but keep explicit quote/reply context). Per-channel override: `channels.<channel>.contextVisibility`.
- `channels.defaults.implicitMentions`: controls which supported inbound facts count as mentions. `replyToBot`, `quotedBot`, and `threadParticipation` each default to `true`, preserving current behavior. The names are positive: set a flag to `false` to stop that fact from bypassing mention gating. Among bundled channels, Mattermost, Slack, and Tlon read this policy; on those channels you can also override it per channel with `channels.<channel>.implicitMentions` or per account with `channels.<channel>.accounts.<id>.implicitMentions`, and each flag resolves account -> channel -> defaults independently. Other bundled channels that produce implicit mention facts do not currently read these settings, so on those channels the facts always count as mentions and the override has no effect. Native explicit mentions are always allowed, and a flag has no effect when the channel does not produce that fact. See [Mention gating](/channels/groups#mention-gating-default) for the current producer matrix. These settings do not change outbound reply/thread modes or authorized command handling.
- `channels.defaults.heartbeatVisibility.showOk`: deliver legacy `HEARTBEAT_OK` acknowledgments when the monitor has nothing to report (default `false`).
- `channels.defaults.heartbeatVisibility.showAlerts`: deliver user-facing heartbeat monitor alerts (default `true`).
- `channels.defaults.heartbeatVisibility.useIndicator`: emit heartbeat status indicator events (default `true`).

## Multi-account (all channels)

Run multiple accounts per channel (each with its own `accountId`):

This pattern applies to channels that support `accounts`. Microsoft Teams uses only the channel-level `channels.msteams` configuration.

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

- `default` is used when `accountId` is omitted (CLI + routing).
- Env tokens only apply to the **default** account.
- Base channel settings apply to all accounts unless overridden per account.
- For Discord, Google Chat, iMessage, Signal, Slack, Telegram, and WhatsApp, an omitted account `groupPolicy` or `dmPolicy` inherits the channel policy. An explicit account value wins, including `allowlist` or `pairing`. With no applicable policy configured, group access stays `allowlist` and DMs use `pairing`.
- WhatsApp also inherits shared settings from `accounts.default` before falling back to the channel root; Google Chat uses shared `accounts.default` settings below root settings. See the channel pages for these exceptions and collection-merging rules.
- Use `bindings[].match.accountId` to route each account to a different agent.
- If you add a non-default account via `openclaw channels add` (or channel onboarding) while still on a single-account top-level channel config, OpenClaw promotes account-scoped top-level single-account values into the channel account map first so the original account keeps working. Most channels move them into `channels.<channel>.accounts.default`; Matrix can preserve an existing matching named/default target instead.
- Existing channel-only bindings (no `accountId`) keep matching the default account; account-scoped bindings remain optional.
- `openclaw doctor --fix` also repairs mixed shapes by moving account-scoped top-level single-account values into the promoted account chosen for that channel. Most channels use `accounts.default`; Matrix can preserve an existing matching named/default target instead.
