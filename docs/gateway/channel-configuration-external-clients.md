---
summary: "Minimum working configs for channels that depend on external clients, CLIs, or legacy integrations"
read_when:
  - You are configuring Signal, iMessage, or IRC
  - You need the shortest path for external client channels
title: "External Clients And Legacy Integrations"
---

# External Clients And Legacy Integrations

<Note>
Use this page to choose a setup path. The canonical per-channel configuration docs live under [Chat Channels](/channels).
</Note>

These channels depend on a local client, CLI, or legacy bridge that OpenClaw talks to.
They usually need extra host level setup before the config file is enough.

## Signal

Config path: `channels.signal`

What you need:

- `signal-cli` installed on the gateway host
- a dedicated Signal number or a linked Signal device

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Use QR link mode or SMS registration first, then restart the gateway and approve the first pairing code.
Details: [Signal](/channels/signal)

## iMessage

Config path: `channels.imessage`

What you need:

- a macOS host signed into Messages
- the legacy `imsg` CLI plus the correct database path

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      dmPolicy: "pairing",
    },
  },
}
```

This is the legacy path. For new macOS setups, prefer [BlueBubbles](/channels/bluebubbles) instead.
Details: [iMessage](/channels/imessage)

## IRC

Config path: `channels.irc`

What you need:

- the IRC plugin
- an IRC server host, port, nick, and one or more channels to join

```json5
{
  channels: {
    irc: {
      enabled: true,
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      nick: "openclaw-bot",
      channels: ["#openclaw"],
    },
  },
}
```

IRC defaults to `dmPolicy: "pairing"` and `groupPolicy: "allowlist"`, so add `groups` or `groupAllowFrom` when you want channel replies.
Details: [IRC](/channels/irc)

## Related guides

- [Channel configuration overview](/gateway/channel-configuration-guides)
- [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr)
- [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps)
- [Account logins and self hosted channels](/gateway/channel-configuration-account-logins)