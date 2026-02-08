---
summary: "Katayuan ng suporta ng Telegram bot, mga kakayahan, at konpigurasyon"
read_when:
  - Nagtatrabaho sa mga feature o webhook ng Telegram
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:39Z
---

# Telegram (Bot API)

Katayuan: handa para sa production para sa bot DMs + mga grupo gamit ang grammY. Long-polling bilang default; opsyonal ang webhook.

## Mabilis na setup (baguhan)

1. Gumawa ng bot gamit ang **@BotFather** ([direktang link](https://t.me/BotFather)). Tiyaking ang handle ay eksaktong `@BotFather`, pagkatapos kopyahin ang token.
2. Itakda ang token:
   - Env: `TELEGRAM_BOT_TOKEN=...`
   - O config: `channels.telegram.botToken: "..."`.
   - Kapag parehong naka-set, uunahin ang config (ang env fallback ay para lang sa default-account).
3. Simulan ang Gateway.
4. Ang access sa DM ay pairing bilang default; aprubahan ang pairing code sa unang pakikipag-ugnayan.

Minimal na config:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## Ano ito

- Isang Telegram Bot API channel na pagmamay-ari ng Gateway.
- Deterministic routing: ang mga reply ay bumabalik sa Telegram; hindi pumipili ng channel ang model.
- Ang mga DM ay nagbabahagi ng pangunahing session ng agent; ang mga grupo ay nananatiling hiwalay (`agent:<agentId>:telegram:group:<chatId>`).

## Setup (mabilis na ruta)

### 1) Gumawa ng bot token (BotFather)

1. Buksan ang Telegram at makipag-chat kay **@BotFather** ([direktang link](https://t.me/BotFather)). Tiyaking ang handle ay eksaktong `@BotFather`.
2. Patakbuhin ang `/newbot`, pagkatapos sundin ang mga prompt (pangalan + username na nagtatapos sa `bot`).
3. Kopyahin ang token at itago ito nang ligtas.

Opsyonal na mga setting ng BotFather:

- `/setjoingroups` — pahintulutan/tanggihan ang pagdaragdag ng bot sa mga grupo.
- `/setprivacy` — kontrolin kung nakikita ng bot ang lahat ng mensahe sa grupo.

### 2) I-configure ang token (env o config)

Halimbawa:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Opsyon sa env: `TELEGRAM_BOT_TOKEN=...` (gumagana para sa default account).
Kung parehong naka-set ang env at config, uunahin ang config.

Suporta sa maraming account: gamitin ang `channels.telegram.accounts` na may per-account na mga token at opsyonal na `name`. Tingnan ang [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para sa ibinahaging pattern.

3. Simulan ang Gateway. Nagsisimula ang Telegram kapag na-resolve ang token (config muna, env fallback).
4. Ang access sa DM ay pairing bilang default. Aprubahan ang code kapag unang nakontak ang bot.
5. Para sa mga grupo: idagdag ang bot, magpasya sa privacy/admin na asal (sa ibaba), pagkatapos itakda ang `channels.telegram.groups` para kontrolin ang mention gating + mga allowlist.

## Token + privacy + mga pahintulot (panig ng Telegram)

### Paglikha ng token (BotFather)

- Ang `/newbot` ay lumilikha ng bot at ibinabalik ang token (panatilihing lihim).
- Kung tumagas ang token, bawiin/bumuo muli ito sa @BotFather at i-update ang iyong config.

### Visibility ng mensahe sa grupo (Privacy Mode)

Ang mga Telegram bot ay default sa **Privacy Mode**, na nililimitahan kung aling mga mensahe sa grupo ang natatanggap nila.
Kung kailangang makita ng iyong bot ang _lahat_ ng mensahe sa grupo, may dalawang opsyon:

- I-disable ang privacy mode gamit ang `/setprivacy` **o**
- Idagdag ang bot bilang **admin** ng grupo (ang mga admin bot ay tumatanggap ng lahat ng mensahe).

**Tandaan:** Kapag binago mo ang privacy mode, hinihiling ng Telegram na alisin at muling idagdag ang bot
sa bawat grupo para magkabisa ang pagbabago.

### Mga pahintulot sa grupo (admin rights)

Itinatakda ang admin status sa loob ng grupo (Telegram UI). Ang mga admin bot ay palaging tumatanggap ng lahat ng
mensahe sa grupo, kaya gumamit ng admin kung kailangan mo ng ganap na visibility.

## Paano ito gumagana (asal)

- Ang mga papasok na mensahe ay kino-normalize sa ibinahaging channel envelope na may reply context at mga placeholder ng media.
- Ang mga reply sa grupo ay nangangailangan ng mention bilang default (native @mention o `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Multi-agent override: magtakda ng per-agent na mga pattern sa `agents.list[].groupChat.mentionPatterns`.
- Ang mga reply ay palaging niruruta pabalik sa parehong Telegram chat.
- Ang long-polling ay gumagamit ng grammY runner na may per-chat sequencing; ang pangkalahatang concurrency ay nililimitahan ng `agents.defaults.maxConcurrent`.
- Hindi sinusuportahan ng Telegram Bot API ang read receipts; walang opsyong `sendReadReceipts`.

## Draft streaming

Maaaring mag-stream ang OpenClaw ng mga bahagyang reply sa Telegram DMs gamit ang `sendMessageDraft`.

Mga kinakailangan:

- Naka-enable ang Threaded Mode para sa bot sa @BotFather (forum topic mode).
- Mga private chat thread lamang (isinasama ng Telegram ang `message_thread_id` sa mga papasok na mensahe).
- Ang `channels.telegram.streamMode` ay hindi nakatakda sa `"off"` (default: `"partial"`, pinapagana ng `"block"` ang chunked draft updates).

Ang draft streaming ay para sa DM lamang; hindi ito sinusuportahan ng Telegram sa mga grupo o channel.

## Formatting (Telegram HTML)

- Ang palabas na text ng Telegram ay gumagamit ng `parse_mode: "HTML"` (sinusuportahang subset ng mga tag ng Telegram).
- Ang Markdown-ish na input ay nirender sa **Telegram-safe HTML** (bold/italic/strike/code/links); ang mga block element ay pini-flatten sa text na may mga newline/bullet.
- Ang raw HTML mula sa mga model ay ini-escape upang maiwasan ang mga parse error ng Telegram.
- Kapag tinanggihan ng Telegram ang HTML payload, inuulit ng OpenClaw ang parehong mensahe bilang plain text.

## Mga command (native + custom)

Nirerehistro ng OpenClaw ang mga native na command (tulad ng `/status`, `/reset`, `/model`) sa bot menu ng Telegram sa startup.
Maaari kang magdagdag ng mga custom na command sa menu sa pamamagitan ng config:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## Pag-troubleshoot ng setup (mga command)

- Ang `setMyCommands failed` sa logs ay karaniwang nangangahulugang naka-block ang outbound HTTPS/DNS papunta sa `api.telegram.org`.
- Kung makakita ka ng mga failure na `sendMessage` o `sendChatAction`, suriin ang IPv6 routing at DNS.

Karagdagang tulong: [Pag-troubleshoot ng channel](/channels/troubleshooting).

Mga tala:

- Ang mga custom na command ay **menu entries lamang**; hindi sila ipinapatupad ng OpenClaw maliban kung hahawakan mo sila sa ibang lugar.
- Ang mga pangalan ng command ay kino-normalize (inaalis ang leading `/`, ginagawang lowercase) at dapat tumugma sa `a-z`, `0-9`, `_` (1–32 na karakter).
- Ang mga custom na command ay **hindi maaaring mag-override ng mga native na command**. Ang mga conflict ay binabalewala at nilo-log.
- Kung naka-disable ang `commands.native`, ang mga custom na command lamang ang nirerehistro (o nililinis kung wala).

## Mga limitasyon

- Ang palabas na text ay hinihiwa-hiwa sa `channels.telegram.textChunkLimit` (default 4000).
- Opsyonal na paghiwa batay sa newline: itakda ang `channels.telegram.chunkMode="newline"` upang maghiwa sa mga blangkong linya (mga hangganan ng talata) bago ang paghiwa batay sa haba.
- Ang pag-download/pag-upload ng media ay nililimitahan ng `channels.telegram.mediaMaxMb` (default 5).
- Ang mga request sa Telegram Bot API ay nagti-time out pagkalipas ng `channels.telegram.timeoutSeconds` (default 500 gamit ang grammY). Magtakda ng mas mababa upang maiwasan ang mahahabang paghinto.
- Ang group history context ay gumagamit ng `channels.telegram.historyLimit` (o `channels.telegram.accounts.*.historyLimit`), na bumabagsak sa `messages.groupChat.historyLimit`. Itakda ang `0` upang i-disable (default 50).
- Maaaring limitahan ang DM history gamit ang `channels.telegram.dmHistoryLimit` (mga turn ng user). Per-user na mga override: `channels.telegram.dms["<user_id>"].historyLimit`.

## Mga mode ng pag-activate ng grupo

Bilang default, tumutugon lang ang bot sa mga mention sa mga grupo (`@botname` o mga pattern sa `agents.list[].groupChat.mentionPatterns`). Upang baguhin ang asal na ito:

### Sa pamamagitan ng config (inirerekomenda)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**Mahalaga:** Ang pagtatakda ng `channels.telegram.groups` ay lumilikha ng **allowlist** — tanging ang mga nakalistang grupo (o `"*"`) lamang ang tatanggapin.
Ang mga forum topic ay nagmamana ng config ng kanilang parent group (allowFrom, requireMention, skills, prompts) maliban kung magdadagdag ka ng per-topic na mga override sa ilalim ng `channels.telegram.groups.<groupId>.topics.<topicId>`.

Upang pahintulutan ang lahat ng grupo na may palaging tumutugon:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

Upang panatilihin ang mention-only para sa lahat ng grupo (default na asal):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### Sa pamamagitan ng command (antas ng session)

Ipadala sa grupo:

- `/activation always` - tumugon sa lahat ng mensahe
- `/activation mention` - mangailangan ng mga mention (default)

**Tandaan:** Ina-update lamang ng mga command ang state ng session. Para sa persistent na asal sa mga restart, gumamit ng config.

### Pagkuha ng group chat ID

I-forward ang anumang mensahe mula sa grupo papunta sa `@userinfobot` o `@getidsbot` sa Telegram upang makita ang chat ID (negatibong numero tulad ng `-1001234567890`).

**Tip:** Para sa sarili mong user ID, mag-DM sa bot at magre-reply ito ng iyong user ID (mensaheng pairing), o gamitin ang `/whoami` kapag naka-enable na ang mga command.

**Tala sa privacy:** Ang `@userinfobot` ay isang third-party na bot. Kung mas gusto mo, idagdag ang bot sa grupo, magpadala ng mensahe, at gamitin ang `openclaw logs --follow` upang basahin ang `chat.id`, o gamitin ang Bot API `getUpdates`.

## Mga pagsusulat sa config

Bilang default, pinapayagan ang Telegram na magsulat ng mga update sa config na na-trigger ng mga event ng channel o `/config set|unset`.

Nangyayari ito kapag:

- Ang isang grupo ay ina-upgrade sa supergroup at naglalabas ang Telegram ng `migrate_to_chat_id` (nagbabago ang chat ID). Maaaring awtomatikong i-migrate ng OpenClaw ang `channels.telegram.groups`.
- Pinatakbo mo ang `/config set` o `/config unset` sa isang Telegram chat (nangangailangan ng `commands.config: true`).

I-disable gamit ang:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## Mga topic (forum supergroups)

Ang mga Telegram forum topic ay may kasamang `message_thread_id` kada mensahe. Ang OpenClaw ay:

- Idinadagdag ang `:topic:<threadId>` sa session key ng Telegram group upang ang bawat topic ay hiwalay.
- Nagpapadala ng mga typing indicator at mga reply na may `message_thread_id` upang manatili ang mga tugon sa topic.
- Ang pangkalahatang topic (thread id `1`) ay espesyal: ang mga pagpapadala ng mensahe ay inaalis ang `message_thread_id` (tinatanggihan ito ng Telegram), ngunit isinasama pa rin ito sa mga typing indicator.
- Inilalantad ang `MessageThreadId` + `IsForum` sa template context para sa routing/templating.
- May available na topic-specific na konpigurasyon sa ilalim ng `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, mga allowlist, auto-reply, system prompts, disable).
- Ang mga topic config ay nagmamana ng mga setting ng grupo (requireMention, mga allowlist, skills, prompts, enabled) maliban kung na-override kada topic.

Ang mga private chat ay maaaring magsama ng `message_thread_id` sa ilang edge case. Pinananatili ng OpenClaw na hindi nagbabago ang DM session key, ngunit ginagamit pa rin ang thread id para sa mga reply/draft streaming kapag naroroon ito.

## Mga Inline Button

Sinusuportahan ng Telegram ang mga inline keyboard na may mga callback button.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

Para sa per-account na konpigurasyon:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

Mga saklaw:

- `off` — naka-disable ang mga inline button
- `dm` — DMs lamang (naka-block ang mga target sa grupo)
- `group` — mga grupo lamang (naka-block ang mga target sa DM)
- `all` — DMs + mga grupo
- `allowlist` — DMs + mga grupo, ngunit tanging mga sender na pinapayagan ng `allowFrom`/`groupAllowFrom` (parehong mga patakaran tulad ng control commands)

Default: `allowlist`.
Legacy: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Pagpapadala ng mga button

Gamitin ang message tool na may parameter na `buttons`:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

Kapag nag-click ang user ng button, ang callback data ay ipinapadala pabalik sa agent bilang isang mensahe na may format:
`callback_data: value`

### Mga opsyon sa konpigurasyon

Maaaring i-configure ang mga kakayahan ng Telegram sa dalawang antas (ipinakitang object form sa itaas; sinusuportahan pa rin ang legacy na string arrays):

- `channels.telegram.capabilities`: Global na default na config ng kakayahan na inilalapat sa lahat ng Telegram account maliban kung na-override.
- `channels.telegram.accounts.<account>.capabilities`: Per-account na mga kakayahan na nag-o-override sa global na default para sa partikular na account.

Gamitin ang global na setting kapag ang lahat ng Telegram bot/account ay dapat kumilos nang pareho. Gumamit ng per-account na konpigurasyon kapag ang iba’t ibang bot ay nangangailangan ng iba’t ibang asal (halimbawa, isang account ay DM lamang habang ang isa pa ay pinapayagan sa mga grupo).

## Kontrol sa access (DMs + mga grupo)

### Access sa DM

- Default: `channels.telegram.dmPolicy = "pairing"`. Ang mga hindi kilalang sender ay tumatanggap ng pairing code; binabalewala ang mga mensahe hanggang maaprubahan (nag-e-expire ang mga code pagkalipas ng 1 oras).
- Aprubahan sa pamamagitan ng:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- Ang pairing ang default na token exchange na ginagamit para sa Telegram DMs. Mga detalye: [Pairing](/channels/pairing)
- Tumatanggap ang `channels.telegram.allowFrom` ng mga numeric user ID (inirerekomenda) o mga entry na `@username`. **Hindi** ito ang username ng bot; gamitin ang ID ng human sender. Tumatanggap ang wizard ng `@username` at nireresolba ito sa numeric ID kapag posible.

#### Paghahanap ng iyong Telegram user ID

Mas ligtas (walang third-party bot):

1. Simulan ang Gateway at mag-DM sa iyong bot.
2. Patakbuhin ang `openclaw logs --follow` at hanapin ang `from.id`.

Alternatibo (opisyal na Bot API):

1. Mag-DM sa iyong bot.
2. Kunin ang mga update gamit ang token ng iyong bot at basahin ang `message.from.id`:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Third-party (mas hindi pribado):

- Mag-DM sa `@userinfobot` o `@getidsbot` at gamitin ang ibinalik na user id.

### Access sa grupo

Dalawang magkahiwalay na kontrol:

**1. Aling mga grupo ang pinapayagan** (group allowlist sa pamamagitan ng `channels.telegram.groups`):

- Walang `groups` config = pinapayagan ang lahat ng grupo
- May `groups` config = tanging ang mga nakalistang grupo o `"*"` ang pinapayagan
- Halimbawa: pinapayagan ng `"groups": { "-1001234567890": {}, "*": {} }` ang lahat ng grupo

**2. Aling mga sender ang pinapayagan** (sender filtering sa pamamagitan ng `channels.telegram.groupPolicy`):

- `"open"` = lahat ng sender sa mga pinapayagang grupo ay maaaring mag-message
- `"allowlist"` = tanging ang mga sender sa `channels.telegram.groupAllowFrom` ang maaaring mag-message
- `"disabled"` = walang tinatanggap na mensahe sa grupo
  Default ay `groupPolicy: "allowlist"` (naka-block maliban kung magdagdag ka ng `groupAllowFrom`).

Karamihan ng user ay gusto: `groupPolicy: "allowlist"` + `groupAllowFrom` + mga partikular na grupong nakalista sa `channels.telegram.groups`

Upang pahintulutan ang **sinumang miyembro ng grupo** na makipag-usap sa isang partikular na grupo (habang pinananatiling limitado ang control commands sa mga awtorisadong sender), magtakda ng per-group na override:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## Long-polling vs webhook

- Default: long-polling (hindi kailangan ng pampublikong URL).
- Webhook mode: itakda ang `channels.telegram.webhookUrl` at `channels.telegram.webhookSecret` (opsyonal ang `channels.telegram.webhookPath`).
  - Ang lokal na listener ay nagba-bind sa `0.0.0.0:8787` at nagseserbisyo ng `POST /telegram-webhook` bilang default.
  - Kung iba ang iyong pampublikong URL, gumamit ng reverse proxy at ituro ang `channels.telegram.webhookUrl` sa pampublikong endpoint.

## Reply threading

Sinusuportahan ng Telegram ang opsyonal na threaded replies sa pamamagitan ng mga tag:

- `[[reply_to_current]]` -- mag-reply sa triggering message.
- `[[reply_to:<id>]]` -- mag-reply sa isang partikular na message id.

Kinokontrol ng `channels.telegram.replyToMode`:

- `first` (default), `all`, `off`.

## Mga audio message (voice vs file)

Ipinagkaiba ng Telegram ang **voice notes** (bilog na bubble) at **audio files** (metadata card).
Default ng OpenClaw ang audio files para sa backward compatibility.

Upang pilitin ang voice note bubble sa mga reply ng agent, isama ang tag na ito kahit saan sa reply:

- `[[audio_as_voice]]` — ipadala ang audio bilang voice note sa halip na file.

Inaalis ang tag mula sa naihatid na text. Binabalewala ng ibang channel ang tag na ito.

Para sa mga send ng message tool, itakda ang `asVoice: true` na may voice-compatible na audio `media` URL
(opsyonal ang `message` kapag may media):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## Mga Sticker

Sinusuportahan ng OpenClaw ang pagtanggap at pagpapadala ng mga Telegram sticker na may intelligent caching.

### Pagtanggap ng mga sticker

Kapag nagpadala ang user ng sticker, hinahawakan ito ng OpenClaw batay sa uri ng sticker:

- **Static stickers (WEBP):** Dina-download at pinoproseso sa pamamagitan ng vision. Lumalabas ang sticker bilang isang placeholder na `<media:sticker>` sa nilalaman ng mensahe.
- **Animated stickers (TGS):** Nilalaktawan (hindi sinusuportahan ang Lottie format para sa pagproseso).
- **Video stickers (WEBM):** Nilalaktawan (hindi sinusuportahan ang video format para sa pagproseso).

Available na field ng template context kapag tumatanggap ng mga sticker:

- `Sticker` — object na may:
  - `emoji` — emoji na kaugnay ng sticker
  - `setName` — pangalan ng sticker set
  - `fileId` — Telegram file ID (ipadala muli ang parehong sticker)
  - `fileUniqueId` — stable ID para sa cache lookup
  - `cachedDescription` — naka-cache na vision description kapag available

### Sticker cache

Ang mga sticker ay pinoproseso sa pamamagitan ng vision capabilities ng AI upang makabuo ng mga deskripsyon. Dahil madalas na paulit-ulit na ipinapadala ang parehong mga sticker, kino-cache ng OpenClaw ang mga deskripsyong ito upang maiwasan ang redundant na mga API call.

**Paano ito gumagana:**

1. **Unang pagkikita:** Ipinapadala ang larawan ng sticker sa AI para sa vision analysis. Gumagawa ang AI ng deskripsyon (hal., "Isang cartoon na pusa na masiglang kumakaway").
2. **Pag-iimbak sa cache:** Sine-save ang deskripsyon kasama ng file ID ng sticker, emoji, at pangalan ng set.
3. **Mga susunod na pagkikita:** Kapag muling nakita ang parehong sticker, direktang ginagamit ang naka-cache na deskripsyon. Hindi na ipinapadala ang larawan sa AI.

**Lokasyon ng cache:** `~/.openclaw/telegram/sticker-cache.json`

**Format ng entry sa cache:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**Mga benepisyo:**

- Binabawasan ang gastos sa API sa pamamagitan ng pag-iwas sa paulit-ulit na vision call para sa parehong sticker
- Mas mabilis na oras ng pagtugon para sa mga naka-cache na sticker (walang delay sa vision processing)
- Pinapagana ang functionality ng paghahanap ng sticker batay sa mga naka-cache na deskripsyon

Awtomatikong napupuno ang cache habang tumatanggap ng mga sticker. Walang kinakailangang manual na pamamahala ng cache.

### Pagpapadala ng mga sticker

Maaaring magpadala at maghanap ang agent ng mga sticker gamit ang mga aksyong `sticker` at `sticker-search`. Naka-disable ang mga ito bilang default at kailangang i-enable sa config:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

**Magpadala ng sticker:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

Mga parameter:

- `fileId` (kinakailangan) — ang Telegram file ID ng sticker. Kunin ito mula sa `Sticker.fileId` kapag tumatanggap ng sticker, o mula sa isang resultang `sticker-search`.
- `replyTo` (opsyonal) — message ID na rereplyan.
- `threadId` (opsyonal) — message thread ID para sa mga forum topic.

**Maghanap ng mga sticker:**

Maaaring maghanap ang agent ng mga naka-cache na sticker batay sa deskripsyon, emoji, o pangalan ng set:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

Nagbabalik ng mga tumutugmang sticker mula sa cache:

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

Gumagamit ang paghahanap ng fuzzy matching sa teksto ng deskripsyon, mga karakter ng emoji, at mga pangalan ng set.

**Halimbawa na may threading:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## Streaming (mga draft)

Maaaring mag-stream ang Telegram ng **mga draft bubble** habang bumubuo ang agent ng tugon.
Gumagamit ang OpenClaw ng Bot API `sendMessageDraft` (hindi totoong mga mensahe) at pagkatapos ay ipinapadala ang
panghuling reply bilang isang normal na mensahe.

Mga kinakailangan (Telegram Bot API 9.3+):

- **Mga private chat na may naka-enable na topics** (forum topic mode para sa bot).
- Dapat isama ng mga papasok na mensahe ang `message_thread_id` (private topic thread).
- Binabalewala ang streaming para sa mga grupo/supergroup/channel.

Config:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (default: `partial`)
  - `partial`: i-update ang draft bubble gamit ang pinakabagong streaming text.
  - `block`: i-update ang draft bubble sa mas malalaking bloke (chunked).
  - `off`: i-disable ang draft streaming.
- Opsyonal (para lamang sa `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - mga default: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (nililimitahan sa `channels.telegram.textChunkLimit`).

Tandaan: ang draft streaming ay hiwalay sa **block streaming** (mga mensahe ng channel).
Naka-off ang block streaming bilang default at nangangailangan ng `channels.telegram.blockStreaming: true`
kung gusto mo ng mga maagang mensahe sa Telegram sa halip na mga draft update.

Reasoning stream (Telegram lamang):

- Ang `/reasoning stream` ay nag-stream ng reasoning sa draft bubble habang
  binubuo ang reply, pagkatapos ay ipinapadala ang panghuling sagot nang walang reasoning.
- Kung ang `channels.telegram.streamMode` ay `off`, naka-disable ang reasoning stream.
  Karagdagang konteksto: [Streaming + chunking](/concepts/streaming).

## Retry policy

Ang mga outbound na Telegram API call ay inuulit sa mga pansamantalang network/429 error gamit ang exponential backoff at jitter. I-configure sa pamamagitan ng `channels.telegram.retry`. Tingnan ang [Retry policy](/concepts/retry).

## Agent tool (mga mensahe + reaksyon)

- Tool: `telegram` na may aksyong `sendMessage` (`to`, `content`, opsyonal na `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Tool: `telegram` na may aksyong `react` (`chatId`, `messageId`, `emoji`).
- Tool: `telegram` na may aksyong `deleteMessage` (`chatId`, `messageId`).
- Semantics ng pagtanggal ng reaksyon: tingnan ang [/tools/reactions](/tools/reactions).
- Tool gating: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (default: naka-enable), at `channels.telegram.actions.sticker` (default: naka-disable).

## Mga notification ng reaksyon

**Paano gumagana ang mga reaksyon:**
Dumarating ang mga reaksyon ng Telegram bilang **hiwalay na mga event na `message_reaction`**, hindi bilang mga property sa payload ng mensahe. Kapag nagdagdag ang user ng reaksyon, ang OpenClaw ay:

1. Tumatanggap ng update na `message_reaction` mula sa Telegram API
2. Kino-convert ito sa isang **system event** na may format: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Ini-enqueue ang system event gamit ang **parehong session key** tulad ng mga regular na mensahe
4. Kapag dumating ang susunod na mensahe sa usapan na iyon, dini-drain at ipinapauna ang mga system event sa context ng agent

Nakikita ng agent ang mga reaksyon bilang **mga system notification** sa history ng usapan, hindi bilang metadata ng mensahe.

**Konpigurasyon:**

- `channels.telegram.reactionNotifications`: Kinokontrol kung aling mga reaksyon ang nagti-trigger ng mga notification
  - `"off"` — balewalain ang lahat ng reaksyon
  - `"own"` — mag-notify kapag nagre-react ang mga user sa mga mensahe ng bot (best-effort; in-memory) (default)
  - `"all"` — mag-notify para sa lahat ng reaksyon

- `channels.telegram.reactionLevel`: Kinokontrol ang kakayahan ng agent sa reaksyon
  - `"off"` — hindi maaaring mag-react ang agent sa mga mensahe
  - `"ack"` — nagpapadala ang bot ng mga acknowledgment reaction (👀 habang nagpoproseso) (default)
  - `"minimal"` — maaaring mag-react ang agent nang bihira (gabay: 1 kada 5–10 palitan)
  - `"extensive"` — maaaring mag-react ang agent nang mas malaya kapag naaangkop

**Mga forum group:** Ang mga reaksyon sa mga forum group ay may kasamang `message_thread_id` at gumagamit ng mga session key tulad ng `agent:main:telegram:group:{chatId}:topic:{threadId}`. Tinitiyak nito na magkasama ang mga reaksyon at mensahe sa parehong topic.

**Halimbawang config:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**Mga kinakailangan:**

- Dapat tahasang hilingin ng mga Telegram bot ang `message_reaction` sa `allowed_updates` (awtomatikong kino-configure ng OpenClaw)
- Para sa webhook mode, isinasama ang mga reaksyon sa webhook `allowed_updates`
- Para sa polling mode, isinasama ang mga reaksyon sa `getUpdates` `allowed_updates`

## Mga target ng delivery (CLI/cron)

- Gumamit ng chat id (`123456789`) o username (`@name`) bilang target.
- Halimbawa: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## Pag-troubleshoot

**Hindi tumutugon ang bot sa mga non-mention na mensahe sa grupo:**

- Kung itinakda mo ang `channels.telegram.groups.*.requireMention=false`, dapat i-disable ang **privacy mode** ng Bot API ng Telegram.
  - BotFather: `/setprivacy` → **Disable** (pagkatapos ay alisin at muling idagdag ang bot sa grupo)
- Nagpapakita ang `openclaw channels status` ng babala kapag inaasahan ng config ang mga unmentioned na mensahe sa grupo.
- Maaaring dagdagang suriin ng `openclaw channels status --probe` ang membership para sa mga tahasang numeric group ID (hindi nito ma-audit ang wildcard na mga patakaran ng `"*"`).
- Mabilis na test: `/activation always` (pang-session lamang; gumamit ng config para sa persistence)

**Hindi talaga nakikita ng bot ang mga mensahe sa grupo:**

- Kung nakatakda ang `channels.telegram.groups`, dapat nakalista ang grupo o gumamit ng `"*"`
- Suriin ang Privacy Settings sa @BotFather → "Group Privacy" ay dapat **OFF**
- Tiyaking tunay na miyembro ang bot (hindi lamang admin na walang read access)
- Suriin ang mga log ng Gateway: `openclaw logs --follow` (hanapin ang "skipping group message")

**Tumutugon ang bot sa mga mention ngunit hindi sa `/activation always`:**

- Ina-update ng command na `/activation` ang state ng session ngunit hindi ito nagpe-persist sa config
- Para sa persistent na asal, idagdag ang grupo sa `channels.telegram.groups` na may `requireMention: false`

**Hindi gumagana ang mga command tulad ng `/status`:**

- Tiyaking awtorisado ang iyong Telegram user ID (sa pamamagitan ng pairing o `channels.telegram.allowFrom`)
- Nangangailangan ng awtorisasyon ang mga command kahit sa mga grupo na may `groupPolicy: "open"`

**Agad na humihinto ang long-polling sa Node 22+ (madalas na may proxies/custom fetch):**

- Mas mahigpit ang Node 22+ sa mga instance ng `AbortSignal`; maaaring agad na i-abort ng mga dayuhang signal ang mga call ng `fetch`.
- Mag-upgrade sa isang OpenClaw build na nagno-normalize ng mga abort signal, o patakbuhin ang Gateway sa Node 20 hanggang makapag-upgrade ka.

**Nagsisimula ang bot, pagkatapos ay tahimik na tumitigil sa pagtugon (o naglo-log ng `HttpError: Network request ... failed`):**

- May ilang host na nireresolba muna ang `api.telegram.org` sa IPv6. Kung walang gumaganang IPv6 egress ang iyong server, maaaring ma-stuck ang grammY sa mga IPv6-only na request.
- Ayusin sa pamamagitan ng pag-enable ng IPv6 egress **o** pagpilit ng IPv4 resolution para sa `api.telegram.org` (hal., magdagdag ng entry na `/etc/hosts` gamit ang IPv4 A record, o unahin ang IPv4 sa DNS stack ng iyong OS), pagkatapos ay i-restart ang Gateway.
- Mabilis na check: `dig +short api.telegram.org A` at `dig +short api.telegram.org AAAA` upang kumpirmahin kung ano ang ibinabalik ng DNS.

## Sanggunian ng konpigurasyon (Telegram)

Buong konpigurasyon: [Konpigurasyon](/gateway/configuration)

Mga opsyon ng provider:

- `channels.telegram.enabled`: i-enable/i-disable ang startup ng channel.
- `channels.telegram.botToken`: bot token (BotFather).
- `channels.telegram.tokenFile`: basahin ang token mula sa file path.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.telegram.allowFrom`: DM allowlist (ids/usernames). Ang `open` ay nangangailangan ng `"*"`.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (default: allowlist).
- `channels.telegram.groupAllowFrom`: group sender allowlist (ids/usernames).
- `channels.telegram.groups`: per-group na mga default + allowlist (gamitin ang `"*"` para sa global na mga default).
  - `channels.telegram.groups.<id>.groupPolicy`: per-group override para sa groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: mention gating default.
  - `channels.telegram.groups.<id>.skills`: skill filter (omit = lahat ng Skills, empty = wala).
  - `channels.telegram.groups.<id>.allowFrom`: per-group sender allowlist override.
  - `channels.telegram.groups.<id>.systemPrompt`: karagdagang system prompt para sa grupo.
  - `channels.telegram.groups.<id>.enabled`: i-disable ang grupo kapag `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: per-topic na mga override (parehong field tulad ng grupo).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: per-topic override para sa groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: per-topic mention gating override.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (default: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: per-account override.
- `channels.telegram.replyToMode`: `off | first | all` (default: `first`).
- `channels.telegram.textChunkLimit`: outbound chunk size (chars).
- `channels.telegram.chunkMode`: `length` (default) o `newline` upang maghiwa sa mga blangkong linya (mga hangganan ng talata) bago ang paghiwa batay sa haba.
- `channels.telegram.linkPreview`: i-toggle ang link previews para sa mga palabas na mensahe (default: true).
- `channels.telegram.streamMode`: `off | partial | block` (draft streaming).
- `channels.telegram.mediaMaxMb`: inbound/outbound na limitasyon ng media (MB).
- `channels.telegram.retry`: retry policy para sa mga palabas na Telegram API call (attempts, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: i-override ang Node autoSelectFamily (true=enable, false=disable). Default ay naka-disable sa Node 22 upang maiwasan ang Happy Eyeballs timeouts.
- `channels.telegram.proxy`: proxy URL para sa mga Bot API call (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: i-enable ang webhook mode (nangangailangan ng `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: webhook secret (kinakailangan kapag naka-set ang webhookUrl).
- `channels.telegram.webhookPath`: lokal na webhook path (default `/telegram-webhook`).
- `channels.telegram.actions.reactions`: i-gate ang mga reaksyon ng Telegram tool.
- `channels.telegram.actions.sendMessage`: i-gate ang pagpapadala ng mensahe ng Telegram tool.
- `channels.telegram.actions.deleteMessage`: i-gate ang pagtanggal ng mensahe ng Telegram tool.
- `channels.telegram.actions.sticker`: i-gate ang mga aksyon ng Telegram sticker — send at search (default: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — kontrolin kung aling mga reaksyon ang nagti-trigger ng mga system event (default: `own` kapag hindi naka-set).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — kontrolin ang kakayahan ng agent sa reaksyon (default: `minimal` kapag hindi naka-set).

Mga kaugnay na global na opsyon:

- `agents.list[].groupChat.mentionPatterns` (mga pattern ng mention gating).
- `messages.groupChat.mentionPatterns` (global fallback).
- `commands.native` (default sa `"auto"` → naka-on para sa Telegram/Discord, naka-off para sa Slack), `commands.text`, `commands.useAccessGroups` (asal ng command). I-override gamit ang `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
