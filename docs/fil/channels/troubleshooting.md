---
summary: "Mabilis na pag-troubleshoot sa antas ng channel na may mga signature ng failure bawat channel at mga ayos"
read_when:
  - Sinasabi ng transport ng channel na connected ngunit pumapalya ang mga reply
  - Kailangan mo ng mga check na partikular sa channel bago sumabak sa mas malalim na docs ng provider
title: "Pag-troubleshoot ng Channel"
---

# Pag-troubleshoot ng channel

Gamitin ang pahinang ito kapag kumokonekta ang isang channel ngunit mali ang asal.

## Command ladder

Patakbuhin muna ang mga ito nang sunod-sunod:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Healthy baseline:

- `Runtime: running`
- `RPC probe: ok`
- Ipinapakita ng channel probe na connected/ready

## WhatsApp

### Mga signature ng failure sa WhatsApp

| Sintomas                            | Pinakamabilis na check                                             | Ayos                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Connected pero walang DM replies    | `openclaw pairing list whatsapp`                                   | Aprubahan ang sender o lumipat ng DM policy/allowlist.               |
| Hindi pinapansin ang group messages | Suriin ang `requireMention` + mga pattern ng pag-mention sa config | I-mention ang bot o luwagan ang mention policy para sa grupong iyon. |
| Random na disconnect/relogin loops  | `openclaw channels status --probe` + logs                          | Mag-login muli at tiyaking maayos ang credentials directory.         |

Buong pag-troubleshoot: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Mga signature ng failure sa Telegram

| Sintomas                                           | Pinakamabilis na check                                         | Ayos                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/start` ngunit walang magagamit na daloy ng reply | `openclaw pairing list telegram`                               | Aprubahan ang pairing o baguhin ang DM policy.                              |
| Online ang bot pero tahimik ang grupo              | I-verify ang requirement ng pag-mention at privacy mode ng bot | I-disable ang privacy mode para sa visibility ng grupo o i-mention ang bot. |
| Mga send failure na may network errors             | Suriin ang logs para sa mga failure ng Telegram API call       | Ayusin ang DNS/IPv6/proxy routing papunta sa `api.telegram.org`.            |

Buong pag-troubleshoot: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Mga signature ng failure sa Discord

| Sintomas                                    | Pinakamabilis na check                       | Ayos                                                                                  |
| ------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Online ang bot pero walang replies sa guild | `openclaw channels status --probe`           | Payagan ang guild/channel at i-verify ang message content intent.     |
| Hindi pinapansin ang group messages         | Suriin ang logs para sa mention gating drops | I-mention ang bot o itakda ang guild/channel `requireMention: false`. |
| Nawawala ang DM replies                     | `openclaw pairing list discord`              | Aprubahan ang DM pairing o ayusin ang DM policy.                      |

Buong pag-troubleshoot: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Mga signature ng failure sa Slack

| Sintomas                                        | Pinakamabilis na check                        | Ayos                                                                            |
| ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| Connected ang socket mode pero walang responses | `openclaw channels status --probe`            | I-verify ang app token + bot token at mga kinakailangang scope. |
| Naka-block ang DMs                              | `openclaw pairing list slack`                 | Aprubahan ang pairing o luwagan ang DM policy.                  |
| Hindi pinapansin ang mensahe sa channel         | Suriin ang `groupPolicy` at channel allowlist | Payagan ang channel o ilipat ang policy sa `open`.              |

Buong pag-troubleshoot: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage at BlueBubbles

### Mga signature ng failure sa iMessage at BlueBubbles

| Sintomas                                         | Pinakamabilis na check                                                 | Ayos                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Walang inbound events                            | I-verify ang webhook/server reachability at mga permission ng app      | Ayusin ang webhook URL o ang estado ng BlueBubbles server.           |
| Nakakapagpadala pero walang natatanggap sa macOS | Suriin ang mga macOS privacy permission para sa Messages automation    | Ibigay muli ang TCC permissions at i-restart ang proseso ng channel. |
| Naka-block ang DM sender                         | `openclaw pairing list imessage` o `openclaw pairing list bluebubbles` | Aprubahan ang pairing o i-update ang allowlist.                      |

Buong pag-troubleshoot:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Mga signature ng failure sa Signal

| Sintomas                                   | Pinakamabilis na check                                   | Ayos                                                                          |
| ------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Maaabot ang daemon pero tahimik ang bot    | `openclaw channels status --probe`                       | I-verify ang `signal-cli` daemon URL/account at receive mode. |
| Naka-block ang DM                          | `openclaw pairing list signal`                           | Aprubahan ang sender o ayusin ang DM policy.                  |
| Hindi nagti-trigger ang mga reply sa grupo | Suriin ang group allowlist at mga pattern ng pag-mention | Idagdag ang sender/grupo o luwagan ang gating.                |

Buong pag-troubleshoot: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Mga signature ng failure sa Matrix

| Sintomas                                              | Pinakamabilis na check                                  | Ayos                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Naka-log in pero binabalewala ang mga mensahe sa room | `openclaw channels status --probe`                      | Suriin ang `groupPolicy` at room allowlist.                           |
| Hindi napo-proseso ang DMs                            | `openclaw pairing list matrix`                          | Aprubahan ang sender o ayusin ang DM policy.                          |
| Pumapalya ang mga encrypted room                      | I-verify ang crypto module at mga setting ng encryption | I-enable ang suporta sa encryption at muling sumali/mag-sync sa room. |

Buong pag-troubleshoot: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
