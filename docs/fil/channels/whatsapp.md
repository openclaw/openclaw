---
summary: "Integrasyon ng WhatsApp (web channel): login, inbox, mga sagot, media, at ops"
read_when:
  - Kapag nagtatrabaho sa behavior ng WhatsApp/web channel o inbox routing
title: "WhatsApp"
---

# WhatsApp (web channel)

Status: WhatsApp Web via Baileys only. Gateway owns the session(s).

## Quick setup (beginner)

1. Gumamit ng **hiwalay na numero ng telepono** kung maaari (inirerekomenda).
2. I-configure ang WhatsApp sa `~/.openclaw/openclaw.json`.
3. Patakbuhin ang `openclaw channels login` para i-scan ang QR code (Linked Devices).
4. Simulan ang gateway.

Minimal na config:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## Mga layunin

- Maramihang WhatsApp account (multi-account) sa isang Gateway process.
- Deterministic routing: bumabalik ang mga sagot sa WhatsApp, walang model routing.
- Nakakakita ang model ng sapat na konteksto para maunawaan ang mga quoted reply.

## Mga pagsusulat sa config

Bilang default, pinapayagan ang WhatsApp na magsulat ng mga update sa config na na-trigger ng `/config set|unset` (nangangailangan ng `commands.config: true`).

I-disable gamit ang:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Arkitektura (sino ang may-ari ng alin)

- **Gateway** ang may-ari ng Baileys socket at inbox loop.
- **CLI / macOS app** ay nakikipag-usap sa gateway; walang direktang paggamit ng Baileys.
- **Active listener** ay kinakailangan para sa outbound sends; kung wala, mabilis na magfa-fail ang send.

## Pagkuha ng numero ng telepono (dalawang mode)

WhatsApp requires a real mobile number for verification. VoIP and virtual numbers are usually blocked. There are two supported ways to run OpenClaw on WhatsApp:

### Dedicated number (inirerekomenda)

Use a **separate phone number** for OpenClaw. Best UX, clean routing, no self-chat quirks. Ideal setup: **spare/old Android phone + eSIM**. Leave it on Wi‑Fi and power, and link it via QR.

**WhatsApp Business:** You can use WhatsApp Business on the same device with a different number. Great for keeping your personal WhatsApp separate — install WhatsApp Business and register the OpenClaw number there.

**Sample config (dedicated number, single-user allowlist):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**Pairing mode (optional):**
If you want pairing instead of allowlist, set `channels.whatsapp.dmPolicy` to `pairing`. Unknown senders get a pairing code; approve with:
`openclaw pairing approve whatsapp <code>`

### Personal number (fallback)

Quick fallback: run OpenClaw on **your own number**. Message yourself (WhatsApp “Message yourself”) for testing so you don’t spam contacts. Expect to read verification codes on your main phone during setup and experiments. **Must enable self-chat mode.**
When the wizard asks for your personal WhatsApp number, enter the phone you will message from (the owner/sender), not the assistant number.

**Sample config (personal number, self-chat):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Self-chat replies default to `[{identity.name}]` when set (otherwise `[openclaw]`)
if `messages.responsePrefix` is unset. Set it explicitly to customize or disable
the prefix (use `""` to remove it).

### Mga tip sa pagkuha ng numero

- **Local eSIM** mula sa mobile carrier ng iyong bansa (pinaka-maaasahan)
  - Austria: [hot.at](https://www.hot.at)
  - UK: [giffgaff](https://www.giffgaff.com) — libreng SIM, walang kontrata
- **Prepaid SIM** — mura, kailangan lang makatanggap ng isang SMS para sa verification

**Iwasan:** TextNow, Google Voice, karamihan sa mga “free SMS” service — agresibong bina-block ng WhatsApp ang mga ito.

**Tip:** The number only needs to receive one verification SMS. After that, WhatsApp Web sessions persist via `creds.json`.

## Bakit Hindi Twilio?

- Ang mga unang build ng OpenClaw ay sumuporta sa WhatsApp Business integration ng Twilio.
- Hindi angkop ang mga WhatsApp Business number para sa personal assistant.
- Nagpapatupad ang Meta ng 24‑hour reply window; kung hindi ka tumugon sa loob ng huling 24 oras, hindi makakapagsimula ng bagong mensahe ang business number.
- Ang high-volume o “chatty” na paggamit ay nagti-trigger ng agresibong pagba-block, dahil hindi idinisenyo ang business accounts para magpadala ng dose-dosenang mensahe ng personal assistant.
- Resulta: hindi maaasahang delivery at madalas na block, kaya inalis ang suporta.

## Login + credentials

- Login command: `openclaw channels login` (QR sa pamamagitan ng Linked Devices).
- Multi-account login: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- Default account (kapag inalis ang `--account`): `default` kung mayroon, kung hindi ay ang unang naka-configure na account id (sorted).
- Ang mga credential ay naka-store sa `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- Backup copy sa `creds.json.bak` (nirerestore kapag may corruption).
- Legacy compatibility: ang mga lumang install ay direktang nag-store ng Baileys files sa `~/.openclaw/credentials/`.
- Logout: `openclaw channels logout` (o `--account <id>`) ay nagbubura ng WhatsApp auth state (ngunit pinananatili ang shared `oauth.json`).
- Logged-out socket => error na nag-uutos na mag-relink.

## Inbound flow (DM + group)

- Ang mga WhatsApp event ay nanggagaling sa `messages.upsert` (Baileys).
- Inaalis ang inbox listeners sa shutdown para maiwasan ang pag-ipon ng event handlers sa tests/restarts.
- Binabalewala ang status/broadcast chats.
- Ang direct chats ay gumagamit ng E.164; ang mga group ay gumagamit ng group JID.
- **DM policy**: kinokontrol ng `channels.whatsapp.dmPolicy` ang access sa direct chat (default: `pairing`).
  - Pairing: ang mga hindi kilalang sender ay nakakakuha ng pairing code (aprubahan sa pamamagitan ng `openclaw pairing approve whatsapp <code>`; nag-e-expire ang mga code pagkalipas ng 1 oras).
  - Open: nangangailangan na isama ng `channels.whatsapp.allowFrom` ang `"*"`.
  - Ang naka-link mong WhatsApp number ay implicit na pinagkakatiwalaan, kaya ang mga self message ay nilalaktawan ang mga check ng `channels.whatsapp.dmPolicy` at `channels.whatsapp.allowFrom`.

### Personal-number mode (fallback)

Kung pinapatakbo mo ang OpenClaw sa **personal mong WhatsApp number**, i-enable ang `channels.whatsapp.selfChatMode` (tingnan ang sample sa itaas).

Behavior:

- Ang outbound DMs ay hindi kailanman nagti-trigger ng pairing replies (iniiwasan ang pag-spam ng contacts).
- Ang inbound na hindi kilalang sender ay sumusunod pa rin sa `channels.whatsapp.dmPolicy`.
- Ang self-chat mode (allowFrom ay may kasamang numero mo) ay umiiwas sa auto read receipts at binabalewala ang mention JIDs.
- Nagpapadala ng read receipts para sa mga non-self-chat DMs.

## Read receipts

Bilang default, minamarkahan ng gateway ang mga inbound na WhatsApp message bilang nabasa (blue ticks) kapag tinanggap na ang mga ito.

I-disable nang global:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

I-disable per account:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

Mga tala:

- Palaging nilalaktawan ng self-chat mode ang read receipts.

## WhatsApp FAQ: pagpapadala ng mensahe + pairing

**Will OpenClaw message random contacts when I link WhatsApp?**  
No. Default DM policy is **pairing**, so unknown senders only get a pairing code and their message is **not processed**. OpenClaw only replies to chats it receives, or to sends you explicitly trigger (agent/CLI).

**Paano gumagana ang pairing sa WhatsApp?**  
Ang pairing ay DM gate para sa mga hindi kilalang sender:

- Ang unang DM mula sa bagong sender ay nagbabalik ng maikling code (hindi ipo-proseso ang mensahe).
- Aprubahan gamit ang: `openclaw pairing approve whatsapp <code>` (listahan gamit ang `openclaw pairing list whatsapp`).
- Nag-e-expire ang mga code pagkalipas ng 1 oras; ang mga pending request ay may limit na 3 bawat channel.

**Can multiple people use different OpenClaw instances on one WhatsApp number?**  
Yes, by routing each sender to a different agent via `bindings` (peer `kind: "dm"`, sender E.164 like `+15551234567`). Replies still come from the **same WhatsApp account**, and direct chats collapse to each agent’s main session, so use **one agent per person**. DM access control (`dmPolicy`/`allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent).

**Why do you ask for my phone number in the wizard?**  
The wizard uses it to set your **allowlist/owner** so your own DMs are permitted. It’s not used for auto-sending. If you run on your personal WhatsApp number, use that same number and enable `channels.whatsapp.selfChatMode`.

## Message normalization (kung ano ang nakikita ng model)

- Ang `Body` ang kasalukuyang body ng mensahe na may envelope.

- Ang quoted reply context ay **laging idinadagdag**:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- Naka-set din ang reply metadata:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = quoted body o media placeholder
  - `ReplyToSender` = E.164 kapag kilala

- Ang media-only inbound messages ay gumagamit ng placeholders:
  - `<media:image|video|audio|document|sticker>`

## Mga group

- Ang mga group ay naka-map sa `agent:<agentId>:whatsapp:group:<jid>` sessions.
- Group policy: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (default `allowlist`).
- Mga activation mode:
  - `mention` (default): nangangailangan ng @mention o regex match.
  - `always`: laging nagti-trigger.
- Ang `/activation mention|always` ay owner-only at kailangang ipadala bilang standalone message.
- Owner = `channels.whatsapp.allowFrom` (o self E.164 kung hindi naka-set).
- **History injection** (pending-only):
  - Mga kamakailang _hindi pa napo-prosesong_ mensahe (default 50) na ipapasok sa ilalim ng:
    `[Chat messages since your last reply - for context]` (ang mga mensaheng nasa session na ay hindi na muling ini-inject)
  - Ang kasalukuyang mensahe sa ilalim ng:
    `[Current message - respond to this]`
  - Idinadagdag ang sender suffix: `[from: Name (+E164)]`
- Naka-cache ang group metadata ng 5 min (subject + participants).

## Reply delivery (threading)

- Nagpapadala ang WhatsApp Web ng mga standard message (walang quoted reply threading sa kasalukuyang gateway).
- Binabalewala ang mga reply tag sa channel na ito.

## Acknowledgment reactions (auto-react sa pagtanggap)

WhatsApp can automatically send emoji reactions to incoming messages immediately upon receipt, before the bot generates a reply. This provides instant feedback to users that their message was received.

**Configuration:**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**Mga opsyon:**

- `emoji` (string): Emoji to use for acknowledgment (e.g., "👀", "✅", "📨"). Empty or omitted = feature disabled.
- `direct` (boolean, default: `true`): Magpadala ng reactions sa direct/DM chats.
- `group` (string, default: `"mentions"`): Behavior sa group chat:
  - `"always"`: Mag-react sa lahat ng group message (kahit walang @mention)
  - `"mentions"`: Mag-react lang kapag na-@mention ang bot
  - `"never"`: Huwag kailanman mag-react sa mga group

**Per-account override:**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**Mga tala sa behavior:**

- Ipinapadala ang mga reaction **agad** sa pagtanggap ng mensahe, bago ang typing indicators o mga reply ng bot.
- Sa mga group na may `requireMention: false` (activation: always), ang `group: "mentions"` ay magre-react sa lahat ng mensahe (hindi lang @mentions).
- Fire-and-forget: naka-log ang mga failure ng reaction pero hindi nito pinipigilan ang bot na sumagot.
- Awtomatikong isinasama ang participant JID para sa mga group reaction.
- Binabalewala ng WhatsApp ang `messages.ackReaction`; gamitin ang `channels.whatsapp.ackReaction` sa halip.

## Agent tool (reactions)

- Tool: `whatsapp` na may `react` action (`chatJid`, `messageId`, `emoji`, opsyonal na `remove`).
- Opsyonal: `participant` (group sender), `fromMe` (pag-react sa sarili mong mensahe), `accountId` (multi-account).
- Semantics ng pag-alis ng reaction: tingnan ang [/tools/reactions](/tools/reactions).
- Tool gating: `channels.whatsapp.actions.reactions` (default: enabled).

## Mga limitasyon

- Ang outbound text ay hinahati sa `channels.whatsapp.textChunkLimit` (default 4000).
- Opsyonal na newline chunking: itakda ang `channels.whatsapp.chunkMode="newline"` para hatiin sa mga blank line (hangganan ng talata) bago ang length chunking.
- Ang inbound media saves ay may cap na `channels.whatsapp.mediaMaxMb` (default 50 MB).
- Ang outbound media items ay may cap na `agents.defaults.mediaMaxMb` (default 5 MB).

## Outbound send (text + media)

- Gumagamit ng active web listener; error kapag hindi tumatakbo ang gateway.
- Text chunking: max na 4k bawat mensahe (configurable sa pamamagitan ng `channels.whatsapp.textChunkLimit`, opsyonal na `channels.whatsapp.chunkMode`).
- Media:
  - Sinusuportahan ang image/video/audio/document.
  - Ipinapadala ang audio bilang PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - Caption sa unang media item lang.
  - Sinusuportahan ng media fetch ang HTTP(S) at local paths.
  - Animated GIFs: inaasahan ng WhatsApp ang MP4 na may `gifPlayback: true` para sa inline looping.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: ang `send` params ay may kasamang `gifPlayback: true`

## Voice notes (PTT audio)

Nagpapadala ang WhatsApp ng audio bilang **voice notes** (PTT bubble).

- Best results: OGG/Opus. OpenClaw rewrites `audio/ogg` to `audio/ogg; codecs=opus`.
- Binabalewala ang `[[audio_as_voice]]` para sa WhatsApp (ang audio ay dumarating na bilang voice note).

## Mga limitasyon sa media + optimization

- Default na outbound cap: 5 MB (bawat media item).
- Override: `agents.defaults.mediaMaxMb`.
- Awtomatikong ina-optimize ang mga image sa JPEG sa ilalim ng cap (resize + quality sweep).
- Oversize na media => error; ang media reply ay babagsak sa text warning.

## Heartbeats

- **Gateway heartbeat** ay naglo-log ng kalusugan ng koneksyon (`web.heartbeatSeconds`, default 60s).
- **Agent heartbeat** ay maaaring i-configure kada agent (`agents.list[].heartbeat`) o nang global
  sa pamamagitan ng `agents.defaults.heartbeat` (fallback kapag walang per-agent entries na naka-set).
  - Uses the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK` skip behavior.
  - Default ang delivery sa huling ginamit na channel (o naka-configure na target).

## Reconnect behavior

- Backoff policy: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- Kapag naabot ang maxAttempts, humihinto ang web monitoring (degraded).
- Logged-out => huminto at mangangailangan ng re-link.

## Config quick map

- `channels.whatsapp.dmPolicy` (DM policy: pairing/allowlist/open/disabled).
- `channels.whatsapp.selfChatMode` (same-phone setup; ginagamit ng bot ang personal mong WhatsApp number).
- `channels.whatsapp.allowFrom` (DM allowlist). WhatsApp uses E.164 phone numbers (no usernames).
- `channels.whatsapp.mediaMaxMb` (inbound media save cap).
- `channels.whatsapp.ackReaction` (auto-reaction sa pagtanggap ng mensahe: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (per-account settings + optional `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (per-account inbound media cap).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (per-account ack reaction override).
- `channels.whatsapp.groupAllowFrom` (group sender allowlist).
- `channels.whatsapp.groupPolicy` (group policy).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (group history context; `0` disables).
- `channels.whatsapp.dmHistoryLimit` (DM history limit in user turns). Per-user overrides: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (group allowlist + mention gating defaults; gamitin ang `"*"` para payagan ang lahat)
- `channels.whatsapp.actions.reactions` (i-gate ang WhatsApp tool reactions).
- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (inbound prefix; per-account: `channels.whatsapp.accounts.<accountId>.messagePrefix`; deprecated: `messages.messagePrefix`)
- `messages.responsePrefix` (outbound prefix)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (opsyonal na override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (per-agent overrides)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (i-disable ang channel startup kapag false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + pag-troubleshoot

- Mga subsystem: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (configurable).
- Gabay sa pag-troubleshoot: [Gateway troubleshooting](/gateway/troubleshooting).

## Troubleshooting (mabilis)

**Hindi naka-link / kailangan ng QR login**

- Sintomas: ang `channels status` ay nagpapakita ng `linked: false` o nagbababala ng “Not linked”.
- Ayusin: patakbuhin ang `openclaw channels login` sa host ng Gateway at i-scan ang QR (WhatsApp → Settings → Linked Devices).

**Naka-link pero disconnected / reconnect loop**

- Sintomas: ang `channels status` ay nagpapakita ng `running, disconnected` o nagbababala ng “Linked but disconnected”.
- Fix: `openclaw doctor` (or restart the gateway). If it persists, relink via `channels login` and inspect `openclaw logs --follow`.

**Bun runtime**

- Bun is **not recommended**. WhatsApp (Baileys) and Telegram are unreliable on Bun.
  Run the gateway with **Node**. (See Getting Started runtime note.)
