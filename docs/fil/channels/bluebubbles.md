---
summary: "iMessage sa pamamagitan ng BlueBubbles macOS server (REST send/receive, typing, reactions, pairing, advanced actions)."
read_when:
  - Pagse-setup ng BlueBubbles channel
  - Pag-troubleshoot ng webhook pairing
  - Pag-configure ng iMessage sa macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. **Recommended for iMessage integration** due to its richer API and easier setup compared to the legacy imsg channel.

## Overview

- Tumatakbo sa macOS gamit ang BlueBubbles helper app ([bluebubbles.app](https://bluebubbles.app)).
- Recommended/tested: macOS Sequoia (15). macOS Tahoe (26) works; edit is currently broken on Tahoe, and group icon updates may report success but not sync.
- Nakikipag-usap ang OpenClaw dito sa pamamagitan ng REST API nito (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Dumarating ang mga papasok na mensahe sa pamamagitan ng webhooks; ang mga papalabas na reply, typing indicators, read receipts, at tapbacks ay mga REST call.
- Ang mga attachment at sticker ay kinukuha bilang inbound media (at ipinapakita sa agent kapag posible).
- Gumagana ang pairing/allowlist sa parehong paraan tulad ng ibang channels (`/channels/pairing` atbp) gamit ang `channels.bluebubbles.allowFrom` + mga pairing code.
- Ipinapakita ang mga reaction bilang system events gaya ng sa Slack/Telegram kaya maaaring “banggitin” ng mga agent ang mga ito bago mag-reply.
- Mga advanced na tampok: edit, unsend, reply threading, message effects, pamamahala ng grupo.

## Quick start

1. I-install ang BlueBubbles server sa iyong Mac (sundin ang mga tagubilin sa [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Sa BlueBubbles config, i-enable ang web API at magtakda ng password.

3. Patakbuhin ang `openclaw onboard` at piliin ang BlueBubbles, o i-configure nang mano-mano:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Ituro ang mga BlueBubbles webhook sa iyong Gateway (halimbawa: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Simulan ang Gateway; ire-register nito ang webhook handler at sisimulan ang pairing.

## Pagpapanatiling buhay ng Messages.app (VM / headless setups)

Some macOS VM / always-on setups can end up with Messages.app going “idle” (incoming events stop until the app is opened/foregrounded). A simple workaround is to **poke Messages every 5 minutes** using an AppleScript + LaunchAgent.

### 1. I-save ang AppleScript

I-save ito bilang:

- `~/Scripts/poke-messages.scpt`

Halimbawang script (non-interactive; hindi inaagaw ang focus):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Mag-install ng LaunchAgent

I-save ito bilang:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Mga tala:

- Tumatakbo ito **bawat 300 segundo** at **sa pag-login**.
- The first run may trigger macOS **Automation** prompts (`osascript` → Messages). Approve them in the same user session that runs the LaunchAgent.

I-load ito:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

Available ang BlueBubbles sa interactive setup wizard:

```
openclaw onboard
```

Hinihingi ng wizard ang:

- **Server URL** (kinakailangan): Address ng BlueBubbles server (hal., `http://192.168.1.100:1234`)
- **Password** (kinakailangan): API password mula sa BlueBubbles Server settings
- **Webhook path** (opsyonal): Default ay `/bluebubbles-webhook`
- **DM policy**: pairing, allowlist, open, o disabled
- **Allow list**: Mga numero ng telepono, email, o chat target

Maaari mo ring idagdag ang BlueBubbles sa pamamagitan ng CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Kontrol sa access (DMs + mga grupo)

DMs:

- Default: `channels.bluebubbles.dmPolicy = "pairing"`.
- Ang mga hindi kilalang sender ay tumatanggap ng pairing code; binabalewala ang mga mensahe hanggang maaprubahan (nag-e-expire ang mga code pagkalipas ng 1 oras).
- Aprubahan sa pamamagitan ng:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)

Mga grupo:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (default: `allowlist`).
- Kinokontrol ng `channels.bluebubbles.groupAllowFrom` kung sino ang maaaring mag-trigger sa mga grupo kapag nakatakda ang `allowlist`.

### Mention gating (mga grupo)

Sinusuportahan ng BlueBubbles ang mention gating para sa mga group chat, na tumutugma sa gawi ng iMessage/WhatsApp:

- Gumagamit ng `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) para matukoy ang mga mention.
- Kapag naka-enable ang `requireMention` para sa isang grupo, tutugon lang ang agent kapag binanggit.
- Nilalampasan ng mga control command mula sa mga awtorisadong sender ang mention gating.

Per-group na konpigurasyon:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Command gating

- Ang mga control command (hal., `/config`, `/model`) ay nangangailangan ng awtorisasyon.
- Gumagamit ng `allowFrom` at `groupAllowFrom` para tukuyin ang awtorisasyon ng command.
- Maaaring magpatakbo ng control command ang mga awtorisadong sender kahit walang pagbanggit sa mga grupo.

## Typing + read receipts

- **Typing indicators**: Awtomatikong ipinapadala bago at habang bumubuo ng tugon.
- **Read receipts**: Kinokontrol ng `channels.bluebubbles.sendReadReceipts` (default: `true`).
- **Typing indicators**: Nagpapadala ang OpenClaw ng typing start events; awtomatikong nililinis ng BlueBubbles ang typing sa pag-send o sa timeout (hindi maaasahan ang manual stop sa pamamagitan ng DELETE).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Mga advanced na action

Sinusuportahan ng BlueBubbles ang mga advanced na message action kapag naka-enable sa config:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Mga available na action:

- **react**: Magdagdag/mag-alis ng tapback reactions (`messageId`, `emoji`, `remove`)
- **edit**: I-edit ang isang naipadalang mensahe (`messageId`, `text`)
- **unsend**: I-unsend ang isang mensahe (`messageId`)
- **reply**: Mag-reply sa isang partikular na mensahe (`messageId`, `text`, `to`)
- **sendWithEffect**: Magpadala na may iMessage effect (`text`, `to`, `effectId`)
- **renameGroup**: Palitan ang pangalan ng group chat (`chatGuid`, `displayName`)
- **setGroupIcon**: Itakda ang icon/larawan ng group chat (`chatGuid`, `media`) — hindi matatag sa macOS 26 Tahoe (maaaring magbalik ng success ang API ngunit hindi nagsa-sync ang icon).
- **addParticipant**: Magdagdag ng tao sa grupo (`chatGuid`, `address`)
- **removeParticipant**: Mag-alis ng tao sa grupo (`chatGuid`, `address`)
- **leaveGroup**: Umalis sa group chat (`chatGuid`)
- **sendAttachment**: Magpadala ng media/files (`to`, `buffer`, `filename`, `asVoice`)
  - Voice memos: set `asVoice: true` with **MP3** or **CAF** audio to send as an iMessage voice message. BlueBubbles converts MP3 → CAF when sending voice memos.

### Mga Message ID (maikli vs buo)

Maaaring ipakita ng OpenClaw ang _maikling_ message ID (hal., `1`, `2`) para makatipid ng token.

- Ang `MessageSid` / `ReplyToId` ay maaaring mga maikling ID.
- Ang `MessageSidFull` / `ReplyToIdFull` ay naglalaman ng buong provider ID.
- Ang mga maikling ID ay nasa memory; maaari silang mag-expire sa restart o cache eviction.
- Tumatanggap ang mga action ng maikli o buong `messageId`, ngunit mag-e-error ang mga maikling ID kapag hindi na available.

Gumamit ng buong ID para sa matitibay na automation at storage:

- Mga template: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: `MessageSidFull` / `ReplyToIdFull` sa mga inbound payload

Tingnan ang [Configuration](/gateway/configuration) para sa mga template variable.

## Block streaming

Kontrolin kung ang mga tugon ay ipinapadala bilang isang mensahe o ini-stream sa mga bloke:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + mga limitasyon

- Ang mga inbound attachment ay dina-download at iniimbak sa media cache.
- Media cap sa pamamagitan ng `channels.bluebubbles.mediaMaxMb` (default: 8 MB).
- Ang outbound text ay hinahati sa `channels.bluebubbles.textChunkLimit` (default: 4000 chars).

## Sanggunian sa konpigurasyon

Buong konpigurasyon: [Configuration](/gateway/configuration)

Mga opsyon ng provider:

- `channels.bluebubbles.enabled`: I-enable/i-disable ang channel.
- `channels.bluebubbles.serverUrl`: Base URL ng BlueBubbles REST API.
- `channels.bluebubbles.password`: API password.
- `channels.bluebubbles.webhookPath`: Webhook endpoint path (default: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (default: `pairing`).
- `channels.bluebubbles.allowFrom`: DM allowlist (mga handle, email, E.164 na numero, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (default: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Allowlist ng sender sa grupo.
- `channels.bluebubbles.groups`: Per-group na config (`requireMention`, atbp.).
- `channels.bluebubbles.sendReadReceipts`: Magpadala ng read receipts (default: `true`).
- `channels.bluebubbles.blockStreaming`: I-enable ang block streaming (default: `false`; kinakailangan para sa streaming replies).
- `channels.bluebubbles.textChunkLimit`: Laki ng outbound chunk sa chars (default: 4000).
- `channels.bluebubbles.chunkMode`: `length` (default) naghahati lang kapag lumampas sa `textChunkLimit`; ang `newline` ay naghahati sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- `channels.bluebubbles.mediaMaxMb`: Inbound media cap sa MB (default: 8).
- `channels.bluebubbles.historyLimit`: Max na group messages para sa context (0 para i-disable).
- `channels.bluebubbles.dmHistoryLimit`: Limit ng DM history.
- `channels.bluebubbles.actions`: I-enable/i-disable ang mga partikular na action.
- `channels.bluebubbles.accounts`: Multi-account na konpigurasyon.

Mga kaugnay na global option:

- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Addressing / delivery targets

Mas piliin ang `chat_guid` para sa matatag na routing:

- `chat_guid:iMessage;-;+15555550123` (mas mainam para sa mga grupo)
- `chat_id:123`
- `chat_identifier:...`
- Mga direktang handle: `+15555550123`, `user@example.com`
  - If a direct handle does not have an existing DM chat, OpenClaw will create one via `POST /api/v1/chat/new`. This requires the BlueBubbles Private API to be enabled.

## Seguridad

- Webhook requests are authenticated by comparing `guid`/`password` query params or headers against `channels.bluebubbles.password`. Requests from `localhost` are also accepted.
- Panatilihing lihim ang API password at webhook endpoint (itrato bilang mga kredensyal).
- Localhost trust means a same-host reverse proxy can unintentionally bypass the password. If you proxy the gateway, require auth at the proxy and configure `gateway.trustedProxies`. See [Gateway security](/gateway/security#reverse-proxy-configuration).
- I-enable ang HTTPS + mga patakaran ng firewall sa BlueBubbles server kung ilalantad ito sa labas ng iyong LAN.

## Pag-troubleshoot

- Kung huminto sa paggana ang typing/read events, suriin ang BlueBubbles webhook logs at tiyaking tumutugma ang gateway path sa `channels.bluebubbles.webhookPath`.
- Nag-e-expire ang mga pairing code pagkalipas ng isang oras; gamitin ang `openclaw pairing list bluebubbles` at `openclaw pairing approve bluebubbles <code>`.
- Nangangailangan ang mga reaction ng BlueBubbles private API (`POST /api/v1/message/react`); tiyaking inilalantad ito ng bersyon ng server.
- Edit/unsend require macOS 13+ and a compatible BlueBubbles server version. On macOS 26 (Tahoe), edit is currently broken due to private API changes.
- Maaaring hindi matatag ang pag-update ng group icon sa macOS 26 (Tahoe): maaaring magbalik ng success ang API ngunit hindi nagsa-sync ang bagong icon.
- OpenClaw auto-hides known-broken actions based on the BlueBubbles server's macOS version. If edit still appears on macOS 26 (Tahoe), disable it manually with `channels.bluebubbles.actions.edit=false`.
- Para sa status/health info: `openclaw status --all` o `openclaw status --deep`.

Para sa pangkalahatang sanggunian sa workflow ng channel, tingnan ang [Channels](/channels) at ang gabay na [Plugins](/tools/plugin).
