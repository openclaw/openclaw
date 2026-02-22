---
summary: "SimpleX Chat support via simplex-chat CLI, setup, and configuration"
read_when:
  - Setting up SimpleX Chat
  - Debugging simplex-chat CLI connectivity
title: "SimpleX"
---

# SimpleX (simplex-chat CLI)

Status: CLI integration in managed or external mode. Gateway talks to `simplex-chat` over the local WebSocket API.

## Quick setup (beginner)

1. Install `simplex-chat` on the host machine.
2. Run `simplex-chat` once in a terminal to complete any initial profile setup.
3. Configure OpenClaw and start the gateway.
4. Use the Control UI to create a one-time link or show/create your address.

Minimal config:

```json5
{
  channels: {
    simplex: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## What it is

- A SimpleX Chat channel backed by the `simplex-chat` CLI.
- Deterministic routing: replies always go back to SimpleX.
- DMs share the agent main session; groups are isolated.

## Install simplex-chat

Install the `simplex-chat` CLI on the same machine as the gateway. Make sure it is on PATH,
or set `channels.simplex.connection.cliPath` to the full path. See
[SimpleX CLI docs](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/CLI.md).

If the CLI prompts for a profile name or other setup on first run, complete that once before
starting the gateway.

## Connection modes

### Managed mode (default)

OpenClaw spawns `simplex-chat` for you.

```json5
{
  channels: {
    simplex: {
      connection: {
        mode: "managed",
        cliPath: "simplex-chat",
        wsPort: 5225,
        dataDir: "~/.openclaw/simplex/default",
      },
    },
  },
}
```

### External mode

Run the CLI yourself and let OpenClaw connect to it.

Example:

```
simplex-chat -p 5225
```

Then configure OpenClaw:

```json5
{
  channels: {
    simplex: {
      connection: {
        mode: "external",
        wsUrl: "ws://127.0.0.1:5225",
      },
    },
  },
}
```

### Multiple accounts

Use `channels.simplex.accounts` to define multiple accounts. For managed mode, set unique
`wsPort` and `dataDir` per account to avoid conflicts.

```json5
{
  channels: {
    simplex: {
      accounts: {
        personal: {
          name: "Personal",
          connection: { wsPort: 5225, dataDir: "~/.openclaw/simplex/personal" },
        },
        ops: {
          name: "Ops",
          connection: { wsPort: 5226, dataDir: "~/.openclaw/simplex/ops" },
        },
      },
    },
  },
}
```

## Access control

Direct messages use the shared DM policy:

- Default: `channels.simplex.dmPolicy = "pairing"`.
- Approve pairing codes with:
  - `openclaw pairing list simplex`
  - `openclaw pairing approve simplex <CODE>`

Set `channels.simplex.allowFrom` to allow specific contact ids, or `"*"` for open access.

## Invites and pairing links

Use the Control UI SimpleX card:

- **Create 1-time Link** for a new contact.
- **Show Address** if one exists, or **Create Address** if not.

The UI can also render a QR code for the generated link.

## Media and files

- Files and voice notes are supported.
- Default inbound file handling auto-accepts downloads.
  - Disable with `channels.simplex.connection.autoAcceptFiles = false`.
- Limit media size with `channels.simplex.mediaMaxMb`.

## Configuration reference (SimpleX)

Full configuration: [Configuration](/gateway/configuration)

Provider options:

- `channels.simplex.enabled`: enable or disable channel startup.
- `channels.simplex.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.simplex.allowFrom`: DM allowlist. `open` requires `"*"`.
- `channels.simplex.connection.mode`: `managed | external` (default: managed).
- `channels.simplex.connection.cliPath`: path to `simplex-chat` binary.
- `channels.simplex.connection.wsUrl`: full WebSocket URL for external mode.
- `channels.simplex.connection.wsHost`: WebSocket host (default 127.0.0.1).
- `channels.simplex.connection.wsPort`: WebSocket port (default 5225).
- `channels.simplex.connection.dataDir`: CLI data directory override.
- `channels.simplex.connection.autoAcceptFiles`: auto-download inbound files (default true).
- `channels.simplex.connection.connectTimeoutMs`: WebSocket connect timeout.
- `channels.simplex.mediaMaxMb`: inbound and outbound media cap (MB).
- `channels.simplex.dmHistoryLimit`: DM history limit in user turns.
- `channels.simplex.dms["<contactId>"].historyLimit`: per-contact DM history limit.
- `channels.simplex.blockStreaming`: disable partial streaming for SimpleX.
- `channels.simplex.blockStreamingCoalesce`: controls block stream batching.

## Troubleshooting

- **CLI not found**: set `channels.simplex.connection.cliPath` to the full path.
- **Connection refused**: ensure `simplex-chat` is running and the WebSocket port matches.
- **Multiple accounts conflict**: assign unique `wsPort` and `dataDir` per account.
- **No pairing requests**: check `dmPolicy` and use `openclaw pairing list simplex`.

More help: [Channel troubleshooting](/channels/troubleshooting).
