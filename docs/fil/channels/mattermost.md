---
summary: "Setup ng Mattermost bot at OpenClaw config"
read_when:
  - Pagse-setup ng Mattermost
  - Pag-debug ng Mattermost routing
title: "Mattermost"
---

# Mattermost (plugin)

Status: supported via plugin (bot token + WebSocket events). Channels, groups, and DMs are supported.
Ang Mattermost ay isang self-hostable na team messaging platform; tingnan ang opisyal na site sa
[mattermost.com](https://mattermost.com) para sa mga detalye ng produkto at mga download.

## Kailangan ang plugin

Ang Mattermost ay ipinapadala bilang plugin at hindi kasama sa core install.

I-install sa pamamagitan ng CLI (npm registry):

```bash
openclaw plugins install @openclaw/mattermost
```

Local checkout (kapag tumatakbo mula sa isang git repo):

```bash
openclaw plugins install ./extensions/mattermost
```

Kung pipiliin mo ang Mattermost sa panahon ng configure/onboarding at may nadetect na git checkout,
awtomatikong iaalok ng OpenClaw ang lokal na install path.

Mga detalye: [Plugins](/tools/plugin)

## Mabilis na setup

1. I-install ang Mattermost plugin.
2. Gumawa ng Mattermost bot account at kopyahin ang **bot token**.
3. Kopyahin ang Mattermost **base URL** (hal., `https://chat.example.com`).
4. I-configure ang OpenClaw at simulan ang gateway.

Minimal na config:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Mga environment variable (default account)

Itakda ang mga ito sa host ng Gateway kung mas gusto mong gumamit ng env vars:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars apply only to the **default** account (`default`). Ang ibang account ay dapat gumamit ng mga config value.

## Mga chat mode

Awtomatikong tumutugon ang Mattermost sa mga DM. Ang asal ng channel ay kinokontrol ng `chatmode`:

- `oncall` (default): tumugon lamang kapag may @mention sa mga channel.
- `onmessage`: tumugon sa bawat mensahe sa channel.
- `onchar`: tumugon kapag ang mensahe ay nagsisimula sa isang trigger prefix.

Halimbawa ng config:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Mga tala:

- `onchar` ay tumutugon pa rin sa mga tahasang @mention.
- Ang `channels.mattermost.requireMention` ay sinusunod para sa mga legacy na config ngunit mas pinapaboran ang `chatmode`.

## Kontrol sa access (DMs)

- Default: `channels.mattermost.dmPolicy = "pairing"` (ang mga hindi kilalang sender ay nakakakuha ng pairing code).
- Aprubahan sa pamamagitan ng:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Pampublikong DM: `channels.mattermost.dmPolicy="open"` kasama ang `channels.mattermost.allowFrom=["*"]`.

## Mga channel (grupo)

- Default: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).
- I-allowlist ang mga sender gamit ang `channels.mattermost.groupAllowFrom` (mga user ID o `@username`).
- Mga bukas na channel: `channels.mattermost.groupPolicy="open"` (mention-gated).

## Mga target para sa outbound delivery

Gamitin ang mga format ng target na ito kasama ang `openclaw message send` o cron/webhooks:

- `channel:<id>` para sa isang channel
- `user:<id>` para sa isang DM
- `@username` para sa isang DM (nireresolba sa pamamagitan ng Mattermost API)

Ang mga bare ID ay itinuturing bilang mga channel.

## Multi-account

Sinusuportahan ng Mattermost ang maraming account sa ilalim ng `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Pag-troubleshoot

- Walang mga sagot sa mga channel: tiyaking nasa channel ang bot at i-mention ito (oncall), gumamit ng trigger prefix (onchar), o itakda ang `chatmode: "onmessage"`.
- Mga error sa auth: suriin ang bot token, base URL, at kung naka-enable ang account.
- Mga isyu sa multi-account: nalalapat lamang ang env vars sa `default` na account.
