---
summary: "Install the plugin, configure a homeserver account, and control which invites the bot accepts"
read_when:
  - Setting up Matrix in OpenClaw for the first time
  - Choosing token or password auth for a Matrix account
  - Restricting which Matrix invites the bot accepts
title: "Matrix setup"
sidebarTitle: "Setup"
---

Install the Matrix plugin, point it at a homeserver, and choose how invites, allowlists, and credentials are handled.

## Install

```bash
openclaw plugins install @openclaw/matrix
```

`@openclaw/matrix` installs from npm first, then falls back to its declared ClawHub package only when the npm target is unavailable. Use `npm:` or `clawhub:` to force a source. From a local checkout: `openclaw plugins install ./path/to/local/matrix-plugin`.

`plugins install` registers and enables the plugin; no separate `enable` step is needed. The channel still does nothing until configured below. See [Plugins](/tools/plugin) for general install rules.

## Setup

1. Create a Matrix account on your homeserver.
2. Configure `channels.matrix` with `homeserver` + `accessToken`, or `homeserver` + `userId` + `password`.
3. Restart the gateway.
4. Start a DM with the bot, or invite it to a room. Fresh invites only land when [`autoJoin`](#auto-join) allows them.

### Interactive setup

```bash
openclaw channels add
openclaw configure --section channels
```

The wizard asks for homeserver URL, auth method (token or password), user ID (password auth only), optional device name, whether to enable E2EE, and room access/auto-join. If matching `MATRIX_*` env vars already exist and the account has no saved auth, the wizard offers an env-var shortcut. Resolve room names before saving an allowlist with `openclaw channels resolve --channel matrix "Project Room"`. Enabling E2EE in the wizard runs the same bootstrap as [`openclaw matrix encryption setup`](/channels/matrix/encryption#encryption-and-verification).

### Minimal config

Token-based:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      dm: { policy: "pairing" },
    },
  },
}
```

Password-based (token is cached after first login):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "replace-me", // pragma: allowlist secret
      deviceName: "OpenClaw Gateway",
    },
  },
}
```

Token and password SecretRefs follow the shared [source-specific provider-alias rules](/gateway/secrets#provider-config), including for named accounts. An explicit matching `env` provider still enforces its allowlist; an empty allowlist denies all variables.

### Auto-join

`channels.matrix.autoJoin` defaults to `"off"`: the bot will not appear in new rooms or DMs from fresh invites until you join manually. OpenClaw cannot tell at invite time whether an invite is a DM or a group, so every invite goes through `autoJoin` first; `dm.policy` only applies later, after the bot has joined and the room is classified.

<Warning>
Set `autoJoin: "allowlist"` plus `autoJoinAllowlist` to restrict accepted invites, or `autoJoin: "always"` to accept every invite.

`autoJoinAllowlist` accepts only a literal room ID (`!roomId:server`, or the suffixless `!roomId` form used by [room version 12](https://spec.matrix.org/latest/rooms/v12/) and later), `#alias:server`, or `*`. Plain room names are rejected; aliases resolve against the homeserver, not against state the invited room claims.
</Warning>

```json5
{
  channels: {
    matrix: {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:example.org", "#support:example.org"],
      groups: {
        "!ops:example.org": { requireMention: true },
      },
    },
  },
}
```

### Group join introductions

When the bot joins an allowed group room, it posts one introduction grounded in
the room name, topic, and up to 100 readable recent room messages. If reading
history fails, the introduction uses only available metadata and does not invent
room activity.

Introductions are enabled by default. Set `channels.matrix.joinIntro: false` to
disable them, or use `channels.matrix.accounts.<accountId>.joinIntro` to override
one account. Direct rooms never receive introductions. Only an actual join
transition triggers one: an unaccepted invite, a startup snapshot of an existing
room, or a profile update while already joined does not. This does not change
[`autoJoin`](#auto-join), which defaults to `"off"`.

See [group join introductions](/channels#group-join-introductions) for room
admission, once-per-room behavior, and the no-tools turn that treats room content
as untrusted.

### Allowlist target formats

Matrix user IDs are case-sensitive. Copy the exact `@user:server` value Matrix reports for every allowlist, approver, and approval-target field. If an existing config used different casing, update it manually; OpenClaw cannot safely infer or rewrite the intended account because case-distinct IDs can identify different users.

- DMs (`dm.allowFrom`, `groupAllowFrom`, `groups.<room>.users`): use `@user:server`. Display names are ignored by default (mutable); set `dangerouslyAllowNameMatching: true` only for explicit display-name compatibility.
- Approval forwarding (`approvals.exec.targets[].to` with `channel: "matrix"`): use `user:@user:server` with the exact Matrix casing.
- Room allowlist keys (`groups`, legacy alias `rooms`): use `!room:server` (or the suffixless `!room` form on room version 12+) or `#alias:server`. Plain names are ignored unless `dangerouslyAllowNameMatching: true`.
- Invite allowlists (`autoJoinAllowlist`): use `!room:server` (or suffixless `!room` on room version 12+), `#alias:server`, or `*`. Plain names are always rejected.

### Account ID normalization

The wizard converts a friendly name into a normalized account ID (`Ops Bot` -> `ops-bot`). Punctuation is hex-escaped in scoped env-var names so accounts cannot collide: `-` (0x2D) becomes `_X2D_`, so `ops-prod` maps to env prefix `MATRIX_OPS_X2D_PROD_`.

### Cached credentials

Matrix caches account credentials in the shared `state/openclaw.sqlite` plugin state. When cached credentials exist, OpenClaw treats Matrix as configured even without an `accessToken` in the config file - this covers setup, `openclaw doctor`, and channel-status probes. Upgrades import the retired `~/.openclaw/credentials/matrix/credentials*.json` files through `openclaw doctor --fix`, verify the SQLite rows, then archive the files.

### Environment variables

Config-key-backed env vars, used when the equivalent config key is unset. The default account uses unprefixed names; named accounts insert the account token before the suffix (see [normalization](#account-id-normalization)).

| Default account       | Named account (`<ID>` = account token) |
| --------------------- | -------------------------------------- |
| `MATRIX_HOMESERVER`   | `MATRIX_<ID>_HOMESERVER`               |
| `MATRIX_ACCESS_TOKEN` | `MATRIX_<ID>_ACCESS_TOKEN`             |
| `MATRIX_USER_ID`      | `MATRIX_<ID>_USER_ID`                  |
| `MATRIX_PASSWORD`     | `MATRIX_<ID>_PASSWORD`                 |
| `MATRIX_DEVICE_ID`    | `MATRIX_<ID>_DEVICE_ID`                |
| `MATRIX_DEVICE_NAME`  | `MATRIX_<ID>_DEVICE_NAME`              |

For account `ops`, names become `MATRIX_OPS_HOMESERVER`, `MATRIX_OPS_ACCESS_TOKEN`, and so on. `MATRIX_HOMESERVER` (and any `*_HOMESERVER` scoped variant) cannot be set from a workspace `.env`; see [Workspace `.env` files](/gateway/security).

<Note>
The recovery key is not a config-backed env var: OpenClaw never reads it from the environment itself. CLI guidance text suggests piping it through a shell variable named `MATRIX_RECOVERY_KEY` for the default account, or `MATRIX_RECOVERY_KEY_<ID>` (plain uppercased account ID, no hex-escaping) for a named account - see [Verify this device with a recovery key](/channels/matrix/encryption#verify-this-device-with-a-recovery-key).
</Note>

## Configuration example

A practical baseline with DM pairing, room allowlist, and E2EE:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,

      dm: {
        policy: "pairing",
        sessionScope: "per-room",
        threadReplies: "off",
      },

      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": { requireMention: true },
      },

      autoJoin: "allowlist",
      autoJoinAllowlist: ["!roomid:example.org"],
      threadReplies: "inbound",
      replyToMode: "off",
      streaming: { mode: "partial" },
    },
  },
}
```
