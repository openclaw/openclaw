---
summary: "Katayuan ng suporta ng Zalo bot, mga kakayahan, at konpigurasyon"
read_when:
  - Gumagawa sa mga feature o webhook ng Zalo
title: "Zalo"
x-i18n:
  source_path: channels/zalo.md
  source_hash: bd14c0d008a23552
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:25Z
---

# Zalo (Bot API)

Katayuan: experimental. Direct messages lamang; paparating ang groups ayon sa Zalo docs.

## Kailangan na plugin

Ipinapadala ang Zalo bilang isang plugin at hindi kasama sa core install.

- I-install sa pamamagitan ng CLI: `openclaw plugins install @openclaw/zalo`
- O piliin ang **Zalo** habang onboarding at kumpirmahin ang install prompt
- Mga detalye: [Plugins](/tools/plugin)

## Mabilis na setup (baguhan)

1. I-install ang Zalo plugin:
   - Mula sa source checkout: `openclaw plugins install ./extensions/zalo`
   - Mula sa npm (kung nailathala): `openclaw plugins install @openclaw/zalo`
   - O piliin ang **Zalo** sa onboarding at kumpirmahin ang install prompt
2. Itakda ang token:
   - Env: `ZALO_BOT_TOKEN=...`
   - O config: `channels.zalo.botToken: "..."`.
3. I-restart ang Gateway (o tapusin ang onboarding).
4. Ang DM access ay pairing bilang default; aprubahan ang pairing code sa unang pakikipag-ugnayan.

Minimal na config:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Ano ito

Ang Zalo ay isang messaging app na nakatuon sa Vietnam; pinapahintulutan ng Bot API nito ang Gateway na magpatakbo ng bot para sa 1:1 na pag-uusap.
Angkop ito para sa support o notifications kung saan gusto mo ng deterministic na routing pabalik sa Zalo.

- Isang Zalo Bot API channel na pagmamay-ari ng Gateway.
- Deterministic routing: bumabalik ang mga reply sa Zalo; hindi pumipili ng channel ang model.
- Ang mga DM ay nagbabahagi ng pangunahing session ng agent.
- Hindi pa suportado ang groups (ayon sa Zalo docs na “coming soon”).

## Setup (mabilis na ruta)

### 1) Gumawa ng bot token (Zalo Bot Platform)

1. Pumunta sa [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) at mag-sign in.
2. Gumawa ng bagong bot at i-configure ang mga setting nito.
3. Kopyahin ang bot token (format: `12345689:abc-xyz`).

### 2) I-configure ang token (env o config)

Halimbawa:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Opsyon sa env: `ZALO_BOT_TOKEN=...` (gumagana lamang para sa default account).

Suporta sa multi-account: gamitin ang `channels.zalo.accounts` na may per-account na mga token at opsyonal na `name`.

3. I-restart ang Gateway. Nagsisimula ang Zalo kapag naresolba ang token (env o config).
4. Ang DM access ay pairing bilang default. Aprubahan ang code kapag unang nakontak ang bot.

## Paano ito gumagana (behavior)

- Ang mga inbound message ay ni-normalize sa shared channel envelope na may mga media placeholder.
- Ang mga reply ay laging niruruta pabalik sa parehong Zalo chat.
- Long-polling bilang default; may webhook mode na available gamit ang `channels.zalo.webhookUrl`.

## Mga limitasyon

- Ang outbound text ay hinahati sa 2000 karakter (limitasyon ng Zalo API).
- Ang media downloads/uploads ay may cap na `channels.zalo.mediaMaxMb` (default 5).
- Ang streaming ay naka-block bilang default dahil ang 2000 char limit ay nagpapababa ng silbi ng streaming.

## Kontrol sa access (DMs)

### DM access

- Default: `channels.zalo.dmPolicy = "pairing"`. Ang mga hindi kilalang sender ay tumatanggap ng pairing code; binabalewala ang mga mensahe hanggang maaprubahan (nag-e-expire ang mga code pagkalipas ng 1 oras).
- Aprubahan sa pamamagitan ng:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Ang pairing ang default na token exchange. Mga detalye: [Pairing](/channels/pairing)
- Tumatanggap ang `channels.zalo.allowFrom` ng numeric user IDs (walang available na username lookup).

## Long-polling vs webhook

- Default: long-polling (hindi kailangan ng public URL).
- Webhook mode: itakda ang `channels.zalo.webhookUrl` at `channels.zalo.webhookSecret`.
  - Ang webhook secret ay dapat 8–256 karakter.
  - Dapat HTTPS ang webhook URL.
  - Nagpapadala ang Zalo ng mga event na may `X-Bot-Api-Secret-Token` header para sa beripikasyon.
  - Hinahandle ng Gateway HTTP ang mga webhook request sa `channels.zalo.webhookPath` (default sa webhook URL path).

**Tala:** Ang getUpdates (polling) at webhook ay mutually exclusive ayon sa Zalo API docs.

## Mga suportadong uri ng mensahe

- **Text messages**: Buong suporta na may 2000 karakter na chunking.
- **Image messages**: I-download at iproseso ang mga inbound image; magpadala ng mga image sa pamamagitan ng `sendPhoto`.
- **Stickers**: Nila-log ngunit hindi ganap na napoproseso (walang agent response).
- **Hindi suportadong uri**: Nila-log (hal., mga mensahe mula sa protected users).

## Mga kakayahan

| Feature         | Katayuan                          |
| --------------- | --------------------------------- |
| Direct messages | ✅ Suportado                      |
| Groups          | ❌ Paparating (ayon sa Zalo docs) |
| Media (images)  | ✅ Suportado                      |
| Reactions       | ❌ Hindi suportado                |
| Threads         | ❌ Hindi suportado                |
| Polls           | ❌ Hindi suportado                |
| Native commands | ❌ Hindi suportado                |
| Streaming       | ⚠️ Naka-block (2000 char limit)   |

## Mga target ng delivery (CLI/cron)

- Gumamit ng chat id bilang target.
- Halimbawa: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Pag-troubleshoot

**Hindi tumutugon ang bot:**

- Suriin kung valid ang token: `openclaw channels status --probe`
- Tiyaking aprubado ang sender (pairing o allowFrom)
- Suriin ang gateway logs: `openclaw logs --follow`

**Hindi tumatanggap ng mga event ang webhook:**

- Tiyaking HTTPS ang webhook URL
- Beripikahin na 8–256 karakter ang secret token
- Kumpirmahing naaabot ang gateway HTTP endpoint sa naka-configure na path
- Tiyaking hindi tumatakbo ang getUpdates polling (mutually exclusive ang mga ito)

## Sanggunian sa konpigurasyon (Zalo)

Buong konpigurasyon: [Configuration](/gateway/configuration)

Mga opsyon ng provider:

- `channels.zalo.enabled`: i-enable/i-disable ang pagsisimula ng channel.
- `channels.zalo.botToken`: bot token mula sa Zalo Bot Platform.
- `channels.zalo.tokenFile`: basahin ang token mula sa file path.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.zalo.allowFrom`: DM allowlist (user IDs). Kinakailangan ng `open` ang `"*"`. Hihingi ang wizard ng mga numeric ID.
- `channels.zalo.mediaMaxMb`: inbound/outbound media cap (MB, default 5).
- `channels.zalo.webhookUrl`: i-enable ang webhook mode (kailangan ang HTTPS).
- `channels.zalo.webhookSecret`: webhook secret (8–256 chars).
- `channels.zalo.webhookPath`: webhook path sa gateway HTTP server.
- `channels.zalo.proxy`: proxy URL para sa mga API request.

Mga opsyon sa multi-account:

- `channels.zalo.accounts.<id>.botToken`: per-account token.
- `channels.zalo.accounts.<id>.tokenFile`: per-account token file.
- `channels.zalo.accounts.<id>.name`: display name.
- `channels.zalo.accounts.<id>.enabled`: i-enable/i-disable ang account.
- `channels.zalo.accounts.<id>.dmPolicy`: per-account DM policy.
- `channels.zalo.accounts.<id>.allowFrom`: per-account allowlist.
- `channels.zalo.accounts.<id>.webhookUrl`: per-account webhook URL.
- `channels.zalo.accounts.<id>.webhookSecret`: per-account webhook secret.
- `channels.zalo.accounts.<id>.webhookPath`: per-account webhook path.
- `channels.zalo.accounts.<id>.proxy`: per-account proxy URL.
