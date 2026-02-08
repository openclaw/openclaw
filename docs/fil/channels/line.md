---
summary: "Setup, config, at paggamit ng plugin para sa LINE Messaging API"
read_when:
  - Gusto mong ikonekta ang OpenClaw sa LINE
  - Kailangan mo ng setup ng LINE webhook + mga kredensyal
  - Gusto mo ng mga opsyon ng mensahe na partikular sa LINE
title: LINE
x-i18n:
  source_path: channels/line.md
  source_hash: 52eb66d06d616173
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:20Z
---

# LINE (plugin)

Kumokonekta ang LINE sa OpenClaw sa pamamagitan ng LINE Messaging API. Tumatakbo ang plugin bilang webhook
receiver sa Gateway at ginagamit ang iyong channel access token + channel secret para sa
authentication.

Status: suportado sa pamamagitan ng plugin. Sinusuportahan ang direct messages, group chats, media, mga lokasyon, Flex
messages, template messages, at quick replies. Hindi sinusuportahan ang reactions at threads.

## Kailangan na plugin

I-install ang LINE plugin:

```bash
openclaw plugins install @openclaw/line
```

Local checkout (kapag tumatakbo mula sa git repo):

```bash
openclaw plugins install ./extensions/line
```

## Setup

1. Gumawa ng LINE Developers account at buksan ang Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Gumawa (o pumili) ng Provider at magdagdag ng **Messaging API** channel.
3. Kopyahin ang **Channel access token** at **Channel secret** mula sa channel settings.
4. I-enable ang **Use webhook** sa Messaging API settings.
5. Itakda ang webhook URL sa endpoint ng iyong Gateway (kailangan ang HTTPS):

```
https://gateway-host/line/webhook
```

Sumasagot ang Gateway sa webhook verification ng LINE (GET) at mga inbound event (POST).
Kung kailangan mo ng custom path, itakda ang `channels.line.webhookPath` o
`channels.line.accounts.<id>.webhookPath` at i-update ang URL nang naaayon.

## I-configure

Minimal na config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Mga env var (default account lang):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Mga token/secret file:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Maramihang account:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Kontrol sa access

Ang direct messages ay default sa pairing. Ang mga hindi kilalang sender ay nakakakuha ng pairing code at ang kanilang
mga mensahe ay binabalewala hanggang maaprubahan.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Mga allowlist at polisiya:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: mga allowlisted LINE user ID para sa DMs
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: mga allowlisted LINE user ID para sa mga grupo
- Per-group overrides: `channels.line.groups.<groupId>.allowFrom`

Case-sensitive ang mga LINE ID. Ganito ang itsura ng mga valid ID:

- User: `U` + 32 hex chars
- Group: `C` + 32 hex chars
- Room: `R` + 32 hex chars

## Gawi ng mensahe

- Ang text ay hinahati sa 5000 character na mga chunk.
- Tinatanggal ang Markdown formatting; ang mga code block at table ay kino-convert sa Flex
  cards kapag posible.
- Ang mga streaming response ay bina-buffer; tumatanggap ang LINE ng buong mga chunk na may loading
  animation habang nagtatrabaho ang agent.
- Ang pag-download ng media ay may cap na `channels.line.mediaMaxMb` (default 10).

## Channel data (rich messages)

Gamitin ang `channelData.line` para magpadala ng quick replies, mga lokasyon, Flex card, o template
messages.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

Kasama rin sa LINE plugin ang isang `/card` command para sa mga preset ng Flex message:

```
/card info "Welcome" "Thanks for joining!"
```

## Pag-troubleshoot

- **Nabibigo ang webhook verification:** tiyaking HTTPS ang webhook URL at tumutugma ang
  `channelSecret` sa LINE console.
- **Walang inbound events:** tiyaking tumutugma ang webhook path sa `channels.line.webhookPath`
  at naaabot ng LINE ang Gateway.
- **Mga error sa pag-download ng media:** itaas ang `channels.line.mediaMaxMb` kung lumalagpas ang media sa
  default na limit.
