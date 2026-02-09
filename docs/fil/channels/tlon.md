---
summary: "Status ng suporta ng Tlon/Urbit, mga kakayahan, at konpigurasyon"
read_when:
  - Gumagawa sa mga feature ng Tlon/Urbit channel
title: "Tlon"
---

# Tlon (plugin)

Ang Tlon ay isang desentralisadong messenger na binuo sa Urbit. OpenClaw connects to your Urbit ship and can
respond to DMs and group chat messages. Ang mga reply sa grupo ay nangangailangan ng @ mention bilang default at maaari pang higpitan sa pamamagitan ng mga allowlist.

Status: suportado sa pamamagitan ng plugin. Mga DM, group mentions, thread replies, at text-only media fallback (URL na idinadagdag sa caption). Hindi suportado ang mga reaction, poll, at native media uploads.

## Kailangan ang plugin

Ang Tlon ay ipinapadala bilang plugin at hindi kasama sa core install.

I-install sa pamamagitan ng CLI (npm registry):

```bash
openclaw plugins install @openclaw/tlon
```

Local checkout (kapag tumatakbo mula sa isang git repo):

```bash
openclaw plugins install ./extensions/tlon
```

Mga detalye: [Plugins](/tools/plugin)

## Setup

1. I-install ang Tlon plugin.
2. Tipunin ang iyong ship URL at login code.
3. I-configure ang `channels.tlon`.
4. I-restart ang Gateway.
5. Mag-DM sa bot o i-mention ito sa isang group channel.

Minimal na config (iisang account):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Mga group channel

Naka-enable ang auto-discovery bilang default. Maaari mo ring i-pin ang mga channel nang manu-mano:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

I-disable ang auto-discovery:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Kontrol sa access

DM allowlist (walang laman = payagan ang lahat):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Awtorisasyon ng group (restricted bilang default):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Mga delivery target (CLI/cron)

Gamitin ang mga ito kasama ng `openclaw message send` o cron delivery:

- DM: `~sampel-palnet` o `dm/~sampel-palnet`
- Group: `chat/~host-ship/channel` o `group:~host-ship/channel`

## Mga tala

- Ang mga reply sa group ay nangangailangan ng mention (hal. `~your-bot-ship`) para tumugon.
- Thread replies: kung ang papasok na mensahe ay nasa isang thread, sasagot ang OpenClaw sa loob ng thread.
- Media: ang `sendMedia` ay bumabagsak sa text + URL (walang native upload).
