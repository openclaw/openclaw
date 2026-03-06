---
summary: "Minimum working configs for channels that connect with account credentials or decentralized identity"
read_when:
  - You are configuring Matrix, Nostr, or Tlon
  - You want account based channel setup examples
title: "Account Logins And Self Hosted Channels"
---

# Account Logins And Self Hosted Channels

<Note>
Use this page to choose a setup path. The canonical per-channel configuration docs live under [Chat Channels](/channels).
</Note>

These channels authenticate as a user account or keypair instead of using a classic bot token.
They work well for self hosted, decentralized, or personal identity based setups.

## Matrix

Config path: `channels.matrix`

What you need:

- the Matrix plugin
- a homeserver URL
- an access token, or a user ID plus password so OpenClaw can fetch a token

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

If you use encrypted rooms, add `encryption: true` and verify the device from another Matrix client.
Details: [Matrix](/channels/matrix)

## Nostr

Config path: `channels.nostr`

What you need:

- the Nostr plugin
- a private key in `nsec` or hex format
- one or more relay URLs

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["wss://relay.damus.io", "wss://nos.lol"],
      dmPolicy: "pairing",
    },
  },
}
```

Store the key outside the file when possible and keep the relay list small until the channel is stable.
Details: [Nostr](/channels/nostr)

## Tlon

Config path: `channels.tlon`

What you need:

- the Tlon plugin
- your ship name, ship URL, and login code
- optionally `ownerShip` so your own ship is always authorized

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://ship.example.com",
      code: "lidlut-tabwed-pillex-ridrup",
      ownerShip: "~your-main-ship",
    },
  },
}
```

If the ship is on localhost or a LAN host, set `allowPrivateNetwork: true` explicitly.
Details: [Tlon](/channels/tlon)

## Related guides

- [Channel configuration overview](/gateway/channel-configuration-guides)
- [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr)
- [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps)
- [External clients and legacy integrations](/gateway/channel-configuration-external-clients)