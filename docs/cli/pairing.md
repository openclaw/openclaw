---
summary: "CLI reference for `openclaw pairing` (approve/list pairing requests, remove approved senders)"
read_when:
  - You're using pairing-mode DMs and need to approve senders
  - You need to forget a sender that was approved through pairing
title: "Pairing CLI"
---

# `openclaw pairing`

Approve or inspect DM pairing requests, and forget approved senders, for channels that support pairing (chat DMs only - node/device pairing uses [`openclaw devices`](/cli/devices)).

Related: [Pairing flow](/channels/pairing)

The same pending requests can be reviewed in the Control UI under **Settings →
Channels → DM access requests**. The Control UI supports approve, optional
requester notification, and dismiss. Dismiss removes the current request but does
not permanently block the sender.

All three CLI commands use the authenticated Gateway that owns the selected local
state directory, or hold exclusive offline ownership when no Gateway owns it.
`list` participates because listing can prune expired or excess requests. The
route requires `operator.admin` and the command's
[owner capability](/gateway/protocol/versioning#local-state-owner-routing).
An older Gateway, missing credentials, a refusal, or an uncertain reply never
triggers a direct local fallback. Update the Gateway or stop it through its
service owner and retry offline; after an uncertain approval, inspect the
pending requests and channel allowlist before retrying.

## Commands

```bash
openclaw pairing list telegram
openclaw pairing list --channel telegram --account work
openclaw pairing list telegram --json

openclaw pairing approve <code>
openclaw pairing approve telegram <code>
openclaw pairing approve --channel telegram --account work <code> --notify

openclaw pairing remove telegram <senderId>
openclaw pairing remove --channel telegram --account work <senderId>
openclaw pairing remove telegram --all
```

Use `--account <accountId>` to restrict a command to one channel account.
If you omit `--account`, `list` shows pending requests across the channel's accounts,
`approve` uses the account belonging to the matching request, `remove <senderId>`
targets the default account, and `remove --all` clears every account. Explicitly empty
or whitespace-only values, such as `--account ""`, are rejected with
`--account must not be blank`.

Input errors, such as a missing channel or unmatched code, print their reason and
recovery guidance on stderr without debug mode. They still exit with status `1`.

## `pairing list`

List pending pairing requests for one channel.

| Option                  | Description                           |
| ----------------------- | ------------------------------------- |
| `[channel]`             | positional channel id                 |
| `--channel <channel>`   | explicit channel id                   |
| `--account <accountId>` | account id for multi-account channels |
| `--json`                | machine-readable output               |

If multiple pairing-capable channels are configured, pass a channel positionally or with `--channel`. Extension channels work as long as the channel id is valid.

`--json` retains `{ channel, requests }`, including each request's `id`, `code`,
`createdAt`, `lastSeenAt`, and optional `meta`.

## `pairing approve`

Approve a pending pairing code and allow that sender.

Usage:

- `openclaw pairing approve <channel> <code>`
- `openclaw pairing approve --channel <channel> <code>`
- `openclaw pairing approve <code>` when exactly one pairing-capable channel is configured

Options: `--channel <channel>`, `--account <accountId>`, `--notify` (send a confirmation back to the requester on the same channel).

For WhatsApp, `--notify` sends the standard approval confirmation through the
running Gateway, using the approved request's account.

### Owner bootstrap

If `commands.ownerAllowFrom` is empty when you approve a pairing code, the CLI also records the approved sender as the command owner. It writes a channel-scoped entry such as `telegram:123456789`. This only bootstraps the first owner - later pairing approvals never replace or expand `commands.ownerAllowFrom`. The Control UI presents this elevation as a separate `operator.admin`-protected checkbox instead of applying it automatically.

The CLI performs this config bootstrap and optional `--notify` only after an
acknowledged approval. They retain their existing local config/reload and channel
notification contracts; they do not run after a refused or uncertain RPC result.

The command owner is the human operator account allowed to run owner-only commands and approve dangerous actions. Those actions include `/diagnostics`, `/export-session`, `/export-trajectory`, `/config`, and exec approvals. Pairing only lets a sender talk to the agent. It does not by itself grant owner privileges beyond this one-time bootstrap.

If you approved a sender before the first-owner bootstrap shipped in 2026.4.29, run [`openclaw doctor`](/cli/doctor). It warns when no command owner is configured. It also shows the exact `openclaw config set commands.ownerAllowFrom ...` command to fix it.

## `pairing remove`

Forget senders that were approved through pairing. Approval writes the sender to
the pairing allowlist store (`channel_pairing_allow_entries` in the state
database), and that entry outlives the channel configuration: unsetting the bot
token or reconnecting the channel with a new one keeps answering the same
senders. This command removes those entries. It does not touch
`channels.<channel>.allowFrom` in the config file.

Usage:

- `openclaw pairing remove <channel> <senderId>` forgets one sender
- `openclaw pairing remove --channel <channel> <senderId>`
- `openclaw pairing remove <channel> --all` forgets every approved sender of the channel
- `openclaw pairing remove <channel> --all --account <accountId>` forgets every approved sender of one account

Options: `--channel <channel>`, `--account <accountId>`, `--all`, `--json`.

The sender id is the channel's own id for the sender, the value shown in the
`list` table before approval (for Telegram, the numeric user id). Without
`--account`, a single-sender removal targets the default account; pass
`--account` when the sender was approved on another account. `--all` without
`--account` clears every account of the channel.

Each removed entry is printed with its account. When nothing matched, the command
fails with status `1` and says so; nothing is changed. `--json` prints
`{ channel, removed: [{ accountId, entry }] }`, with an empty array when nothing
matched.

The chat command `/allowlist remove --store <senderId>` removes the same entry,
but it requires `commands.config` to be enabled and the channel to be running.
`pairing remove` works offline through the local state owner, so a host that
disconnects a channel can forget its approved senders without a running bot.

## Related

- [CLI reference](/cli)
- [Channel pairing](/channels/pairing)
- [`openclaw qr`](/cli/qr) — mobile/device bootstrap QR and setup code, not a channel DM pairing code
