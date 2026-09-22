---
summary: "Multi-account layout, private homeservers, proxies, profiles, and target resolution"
read_when:
  - Running more than one Matrix account on one gateway
  - Connecting to a LAN or self-hosted Matrix homeserver
  - Repairing a drifted Matrix direct-message mapping
title: "Matrix accounts and homeservers"
sidebarTitle: "Accounts and homeservers"
---

Account layout, homeserver reachability, and the target forms OpenClaw accepts for Matrix rooms and users.

## Profile management

```bash
openclaw matrix profile set --name "OpenClaw Assistant"
openclaw matrix profile set --avatar-url https://cdn.example.org/avatar.png
```

Pass both options in one call. Matrix accepts `mxc://` avatar URLs directly; passing `http://`/`https://` uploads the file first and stores the resolved `mxc://` URL into `channels.matrix.avatarUrl` (or the per-account override).

## Direct room repair

If direct-message state drifts, OpenClaw can end up with stale `m.direct` mappings pointing at old solo rooms instead of the live DM. Inspect the current mapping for a peer:

```bash
openclaw matrix direct inspect --user-id @alice:example.org
```

Repair it:

```bash
openclaw matrix direct repair --user-id @alice:example.org
```

Both commands accept `--account <id>` for multi-account setups. The repair flow:

- prefers a strict 1:1 DM already mapped in `m.direct`
- falls back to any currently joined strict 1:1 DM with that user
- creates a fresh direct room and rewrites `m.direct` if no healthy DM exists

It does not delete old rooms automatically. It picks the healthy DM and updates the mapping so future Matrix sends, verification notices, and other direct-message flows target the right room.

## Multi-account

```json5
{
  channels: {
    matrix: {
      enabled: true,
      defaultAccount: "assistant",
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_xxx",
          encryption: true,
        },
        alerts: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_xxx",
          dm: {
            policy: "allowlist",
            allowFrom: ["@ops:example.org"],
            threadReplies: "off",
          },
        },
      },
    },
  },
}
```

**Inheritance:**

- Top-level `channels.matrix` values act as defaults for named accounts unless an account overrides them.
- Scope an inherited room entry to a specific account with `groups.<room>.account`. Entries without `account` are shared across accounts; `account: "default"` still works when the default account is configured at the top level.

**Default account selection:**

- Set `defaultAccount` to pick the named account that implicit routing, probing, and CLI commands prefer.
- If you have multiple accounts and one is literally named `default`, OpenClaw uses it implicitly even when `defaultAccount` is unset.
- With multiple named accounts and no default selected, CLI commands refuse to guess - set `defaultAccount` or pass `--account <id>`.
- The top-level `channels.matrix.*` block is only treated as the implicit `default` account when its auth is complete (`homeserver` + `accessToken`, or `homeserver` + `userId` + `password`). Named accounts remain discoverable from `homeserver` + `userId` once cached credentials cover auth.

**Promotion:**

- When OpenClaw promotes a single-account config to multi-account during repair or setup, it preserves the existing named account if one exists or `defaultAccount` already points at one. Only Matrix auth/bootstrap keys move into the promoted account; shared delivery-policy keys stay at the top level.

See [Configuration reference](/gateway/config-channels#multi-account-all-channels) for the shared multi-account pattern.

## Private/LAN homeservers

By default, OpenClaw blocks private/internal Matrix homeservers for SSRF protection unless you opt in per account.

If your homeserver runs on localhost, a LAN/Tailscale IP, or an internal hostname, enable `network.dangerouslyAllowPrivateNetwork` for that account:

```json5
{
  channels: {
    matrix: {
      homeserver: "http://matrix-synapse:8008",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
      accessToken: "syt_internal_xxx",
    },
  },
}
```

CLI setup example:

```bash
openclaw matrix account add \
  --account ops \
  --homeserver http://matrix-synapse:8008 \
  --allow-private-network \
  --access-token syt_ops_xxx
```

This opt-in only allows trusted private/internal targets. Public cleartext homeservers such as `http://matrix.example.org:8008` remain blocked. Prefer `https://` whenever possible.

## Proxying Matrix traffic

If your Matrix deployment needs an explicit outbound HTTP(S) proxy, set `channels.matrix.proxy`:

```json5
{
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      accessToken: "syt_bot_xxx",
      proxy: "http://127.0.0.1:7890",
    },
  },
}
```

Named accounts can override the top-level default with `channels.matrix.accounts.<id>.proxy`. OpenClaw uses the same proxy setting for runtime Matrix traffic and account status probes.

## Target resolution

Matrix accepts these target forms anywhere OpenClaw asks for a room or user target:

- Users: `@user:server`, `user:@user:server`, or `matrix:user:@user:server`
- Rooms: `!room:server`, `room:!room:server`, or `matrix:room:!room:server` (room version 12+ room IDs have no `:server` suffix — `!room`, `room:!room`, `matrix:room:!room` — and are accepted the same way)
- Aliases: `#alias:server`, `channel:#alias:server`, or `matrix:channel:#alias:server`

Matrix room IDs are case-sensitive. Use the exact room ID casing from Matrix when configuring explicit delivery targets, cron jobs, bindings, or allowlists. OpenClaw keeps internal session keys canonical for storage, so those lowercase keys are not a reliable source for Matrix delivery IDs.

Live directory lookup uses the logged-in Matrix account:

- User lookups query the Matrix user directory on that homeserver.
- Room lookups accept explicit room IDs and aliases directly. Joined-room name lookup is best-effort and only applies to runtime room allowlists when `dangerouslyAllowNameMatching: true` is set.
- If a room name cannot be resolved to an ID or alias, it is ignored by runtime allowlist resolution.
