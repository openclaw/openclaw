---
summary: "BlueBubbles macOS ဆာဗာမှတစ်ဆင့် iMessage (REST ပို့/လက်ခံ၊ စာရိုက်နေမှု၊ တုံ့ပြန်ချက်များ၊ pairing၊ အဆင့်မြင့် လုပ်ဆောင်ချက်များ)။"
read_when:
  - BlueBubbles ချန်နယ် တပ်ဆင်သတ်မှတ်နေချိန်
  - webhook pairing ပြဿနာများကို ဖြေရှင်းနေချိန်
  - macOS တွင် iMessage ကို ပြင်ဆင်သတ်မှတ်နေချိန်
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

12. Status: BlueBubbles macOS server နှင့် HTTP ဖြင့် ဆက်သွယ်သော bundled plugin ဖြစ်သည်။ 13. **iMessage integration အတွက် အကြံပြုထားသည်** — legacy imsg channel နှင့် နှိုင်းယှဉ်ပါက API ပိုမိုကြွယ်ဝပြီး setup ပိုမိုလွယ်ကူသည်။

## အနှစ်ချုပ်

- macOS ပေါ်တွင် BlueBubbles helper app ဖြင့် လည်ပတ်ပါသည် ([bluebubbles.app](https://bluebubbles.app))။
- 14. အကြံပြု/စမ်းသပ်ပြီး: macOS Sequoia (15)။ 15. macOS Tahoe (26) သည် အလုပ်လုပ်သည်; သို့သော် Tahoe တွင် edit သည် လက်ရှိတွင် ပျက်နေပြီး group icon update များသည် အောင်မြင်သည်ဟု ပြနိုင်သော်လည်း sync မဖြစ်နိုင်ပါ။
- OpenClaw သည် ၎င်း၏ REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`) ဖြင့် ဆက်သွယ်ပါသည်။
- ဝင်လာသော မက်ဆေ့ချ်များကို webhooks မှတစ်ဆင့် လက်ခံပြီး၊ ပြန်ကြားချက်များ၊ စာရိုက်နေမှု အညွှန်းများ၊ read receipts နှင့် tapbacks များကို REST calls ဖြင့် ပို့ပါသည်။
- Attachments နှင့် stickers များကို inbound media အဖြစ် လက်ခံပြီး (ဖြစ်နိုင်သမျှ agent ထံ ပြသပေးပါသည်)။
- Pairing/allowlist သည် အခြား ချန်နယ်များ (`/channels/pairing` စသည်) နှင့် အတူတူဖြစ်ပြီး `channels.bluebubbles.allowFrom` + pairing codes ကို အသုံးပြုပါသည်။
- Reactions များကို Slack/Telegram ကဲ့သို့ system events အဖြစ် ပြသပေးသောကြောင့် agent များက ပြန်ကြားမီ “mention” လုပ်နိုင်ပါသည်။
- အဆင့်မြင့် အင်္ဂါရပ်များ: edit, unsend, reply threading, message effects, group management။

## အမြန်စတင်ရန်

1. သင်၏ Mac တွင် BlueBubbles server ကို ထည့်သွင်းပါ ([bluebubbles.app/install](https://bluebubbles.app/install) တွင် လမ်းညွှန်ချက်များကို လိုက်နာပါ)။

2. BlueBubbles config တွင် web API ကို ဖွင့်ပြီး password သတ်မှတ်ပါ။

3. `openclaw onboard` ကို chạy လုပ်ပြီး BlueBubbles ကို ရွေးချယ်ပါ၊ သို့မဟုတ် လက်ဖြင့် ပြင်ဆင်သတ်မှတ်ပါ—

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

4. BlueBubbles webhooks ကို သင့် gateway သို့ ညွှန်ပြပါ (ဥပမာ: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)။

5. Gateway ကို စတင်ပါ; webhook handler ကို မှတ်ပုံတင်ပြီး pairing ကို စတင်ပါမည်။

## Messages.app ကို ဆက်လက် လည်ပတ်အောင် ထိန်းထားခြင်း (VM / headless setups)

16. macOS VM / always-on setup အချို့တွင် Messages.app သည် “idle” ဖြစ်သွားနိုင်ပြီး (app ကို ဖွင့်ခြင်း သို့မဟုတ် foreground မလုပ်မချင်း incoming event များ ရပ်တန့်သွားသည်)။ A simple workaround is to **poke Messages every 5 minutes** using an AppleScript + LaunchAgent.

### 1. AppleScript ကို သိမ်းဆည်းပါ

အောက်ပါအမည်ဖြင့် သိမ်းဆည်းပါ—

- `~/Scripts/poke-messages.scpt`

ဥပမာ script (non-interactive; focus မခိုးပါ):

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

### 2. LaunchAgent ကို ထည့်သွင်းပါ

အောက်ပါအမည်ဖြင့် သိမ်းဆည်းပါ—

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

မှတ်ချက်များ—

- ဤအရာသည် **၃၀၀ စက္ကန့်တိုင်း** နှင့် **login အချိန်တွင်** chạy လုပ်ပါသည်။
- 18. ပထမဆုံး run တွင် macOS **Automation** prompt များ (`osascript` → Messages) ပေါ်လာနိုင်သည်။ 19. LaunchAgent ကို chạy သည့် user session တစ်ခုတည်းအတွင်း ထို prompt များကို အတည်ပြုပါ။

Load လုပ်ရန်—

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles ကို interactive setup wizard တွင် အသုံးပြုနိုင်ပါသည်—

```
openclaw onboard
```

Wizard သည် အောက်ပါတို့ကို မေးမြန်းပါသည်—

- **Server URL** (လိုအပ်): BlueBubbles server လိပ်စာ (ဥပမာ: `http://192.168.1.100:1234`)
- **Password** (လိုအပ်): BlueBubbles Server settings မှ API password
- **Webhook path** (ရွေးချယ်နိုင်): မူလတန်ဖိုး `/bluebubbles-webhook`
- **DM policy**: pairing, allowlist, open, သို့မဟုတ် disabled
- **Allow list**: ဖုန်းနံပါတ်များ၊ အီးမေးလ်များ၊ သို့မဟုတ် chat targets

CLI မှတစ်ဆင့်လည်း BlueBubbles ကို ထည့်နိုင်ပါသည်—

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Access control (DMs + groups)

DMs:

- မူလတန်ဖိုး: `channels.bluebubbles.dmPolicy = "pairing"`။
- မသိသော ပို့သူများသည် pairing code ကို လက်ခံရရှိပြီး အတည်ပြုမချင်း မက်ဆေ့ချ်များကို လျစ်လျူရှုထားပါသည် (codes များသည် ၁ နာရီအကြာတွင် သက်တမ်းကုန်ပါသည်)။
- အတည်ပြုရန်—
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing is the default token exchange. 21. အသေးစိတ်: [Pairing](/channels/pairing)

Groups:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (မူလတန်ဖိုး: `allowlist`)။
- `channels.bluebubbles.groupAllowFrom` သည် `allowlist` သတ်မှတ်ထားသောအခါ group အတွင်း trigger လုပ်နိုင်သူများကို ထိန်းချုပ်ပါသည်။

### Mention gating (groups)

BlueBubbles သည် group chats အတွက် mention gating ကို ပံ့ပိုးပြီး iMessage/WhatsApp အပြုအမူနှင့် ကိုက်ညီပါသည်—

- Mention များကို ခွဲခြားရန် `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`) ကို အသုံးပြုပါသည်။
- Group တစ်ခုအတွက် `requireMention` ကို ဖွင့်ထားပါက mention ခံရသောအခါသာ agent က ပြန်ကြားပါသည်။
- ခွင့်ပြုထားသော ပို့သူများမှ control commands များသည် mention gating ကို မလိုက်နာဘဲ ကျော်လွှားနိုင်ပါသည်။

Group တစ်ခုချင်းစီအလိုက် ပြင်ဆင်သတ်မှတ်ခြင်း—

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

- Control commands (ဥပမာ: `/config`, `/model`) သည် ခွင့်ပြုချက် လိုအပ်ပါသည်။
- Command ခွင့်ပြုချက်ကို သတ်မှတ်ရန် `allowFrom` နှင့် `groupAllowFrom` ကို အသုံးပြုပါသည်။
- ခွင့်ပြုထားသော ပို့သူများသည် group များတွင် mention မလုပ်ဘဲလည်း control commands ကို chạy လုပ်နိုင်ပါသည်။

## Typing + read receipts

- **စာရိုက်နေမှု အညွှန်းများ**: တုံ့ပြန်ချက် ဖန်တီးမီနှင့် ဖန်တီးနေစဉ် အလိုအလျောက် ပို့ပါသည်။
- **Read receipts**: `channels.bluebubbles.sendReadReceipts` ဖြင့် ထိန်းချုပ်ပါသည် (မူလတန်ဖိုး: `true`)။
- **စာရိုက်နေမှု အညွှန်းများ**: OpenClaw သည် typing start events ကို ပို့ပြီး BlueBubbles သည် ပို့ပြီးချိန် သို့မဟုတ် timeout တွင် typing ကို အလိုအလျောက် ရှင်းလင်းပါသည် (DELETE ဖြင့် လက်ဖြင့် ရပ်တန့်ခြင်းသည် ယုံကြည်ရမှု နည်းပါသည်)။

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Advanced actions

Config တွင် ဖွင့်ထားပါက BlueBubbles သည် အဆင့်မြင့် မက်ဆေ့ချ် လုပ်ဆောင်ချက်များကို ပံ့ပိုးပါသည်—

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

ရရှိနိုင်သော လုပ်ဆောင်ချက်များ—

- **react**: tapback reactions ထည့်/ဖယ် (`messageId`, `emoji`, `remove`)
- **edit**: ပို့ပြီးသား မက်ဆေ့ချ်ကို ပြင် (`messageId`, `text`)
- **unsend**: မက်ဆေ့ချ် ပြန်ဖျက် (`messageId`)
- **reply**: သတ်မှတ်ထားသော မက်ဆေ့ချ်တစ်ခုကို reply ပြန် (`messageId`, `text`, `to`)
- **sendWithEffect**: iMessage effect ဖြင့် ပို့ (`text`, `to`, `effectId`)
- **renameGroup**: group chat အမည်ပြောင်း (`chatGuid`, `displayName`)
- **setGroupIcon**: group chat icon/photo သတ်မှတ် (`chatGuid`, `media`) — macOS 26 Tahoe တွင် မတည်ငြိမ်နိုင်ပါ (API သည် အောင်မြင်ကြောင်း ပြန်ပေးနိုင်သော်လည်း icon မ sync ဖြစ်နိုင်ပါ)။
- **addParticipant**: group သို့ လူတစ်ဦး ထည့် (`chatGuid`, `address`)
- **removeParticipant**: group မှ လူတစ်ဦး ဖယ် (`chatGuid`, `address`)
- **leaveGroup**: group chat မှ ထွက် (`chatGuid`)
- **sendAttachment**: media/files ပို့ (`to`, `buffer`, `filename`, `asVoice`)
  - 22. Voice memo များ: iMessage voice message အဖြစ် ပို့ရန် **MP3** သို့မဟုတ် **CAF** audio နှင့်အတူ `asVoice: true` ကို သတ်မှတ်ပါ။ 23. Voice memo ပို့သည့်အခါ BlueBubbles သည် MP3 ကို CAF အဖြစ် ပြောင်းလဲပေးသည်။

### Message IDs (short vs full)

Token များကို ချွေတာရန် OpenClaw သည် _short_ message IDs (ဥပမာ: `1`, `2`) ကို ပြသနိုင်ပါသည်။

- `MessageSid` / `ReplyToId` သည် short IDs ဖြစ်နိုင်ပါသည်။
- `MessageSidFull` / `ReplyToIdFull` တွင် provider full IDs ပါဝင်ပါသည်။
- Short IDs များသည် memory အတွင်းသာ ရှိပြီး restart သို့မဟုတ် cache ဖယ်ရှားခြင်းဖြင့် သက်တမ်းကုန်နိုင်ပါသည်။
- Actions များသည် short သို့မဟုတ် full `messageId` ကို လက်ခံသော်လည်း short IDs မရရှိတော့ပါက error ဖြစ်ပါမည်။

ကြာရှည် အသုံးချရမည့် automation နှင့် storage များအတွက် full IDs ကို အသုံးပြုပါ—

- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: inbound payloads တွင် `MessageSidFull` / `ReplyToIdFull`

Template variables များအတွက် [Configuration](/gateway/configuration) ကို ကြည့်ပါ။

## Block streaming

တုံ့ပြန်ချက်များကို မက်ဆေ့ချ်တစ်ခုတည်းဖြင့် ပို့မည်လား၊ ဘလောက်များအဖြစ် စီးဆင်းပို့မည်လားကို ထိန်းချုပ်ရန်—

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + limits

- ဝင်လာသော attachments များကို download လုပ်ပြီး media cache တွင် သိမ်းဆည်းပါသည်။
- Media ကန့်သတ်ချက်ကို `channels.bluebubbles.mediaMaxMb` ဖြင့် သတ်မှတ်ပါသည် (မူလတန်ဖိုး: 8 MB)။
- ထွက်သည့် စာသားကို `channels.bluebubbles.textChunkLimit` အထိ ခွဲပိုင်းပါသည် (မူလတန်ဖိုး: စာလုံး 4000)။

## Configuration reference

Configuration အပြည့်အစုံ: [Configuration](/gateway/configuration)

Provider options—

- `channels.bluebubbles.enabled`: ချန်နယ်ကို ဖွင့်/ပိတ်။
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API base URL။
- `channels.bluebubbles.password`: API password။
- `channels.bluebubbles.webhookPath`: Webhook endpoint path (မူလတန်ဖိုး: `/bluebubbles-webhook`)။
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (မူလတန်ဖိုး: `pairing`)။
- `channels.bluebubbles.allowFrom`: DM allowlist (handles, emails, E.164 numbers, `chat_id:*`, `chat_guid:*`)။
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (မူလတန်ဖိုး: `allowlist`)။
- `channels.bluebubbles.groupAllowFrom`: Group sender allowlist။
- `channels.bluebubbles.groups`: Group တစ်ခုချင်းစီအလိုက် config (`requireMention` စသည်)။
- `channels.bluebubbles.sendReadReceipts`: Read receipts ပို့ခြင်း (မူလတန်ဖိုး: `true`)။
- `channels.bluebubbles.blockStreaming`: Block streaming ကို ဖွင့် (မူလတန်ဖိုး: `false`; streaming replies အတွက် လိုအပ်)။
- `channels.bluebubbles.textChunkLimit`: ထွက်သည့် chunk size (စာလုံးရေ) (မူလတန်ဖိုး: 4000)။
- `channels.bluebubbles.chunkMode`: `length` (မူလ) သည် `textChunkLimit` ကို ကျော်လွန်သည့်အခါသာ ခွဲပါသည်; `newline` သည် အလွတ်လိုင်းများ (paragraph boundaries) အပေါ် အရင် ခွဲပြီးမှ အရှည်အလိုက် ခွဲပါသည်။
- `channels.bluebubbles.mediaMaxMb`: ဝင်လာသော media ကန့်သတ်ချက် (MB) (မူလတန်ဖိုး: 8)။
- `channels.bluebubbles.historyLimit`: Context အတွက် အများဆုံး group မက်ဆေ့ချ်များ (0 ဆိုလျှင် ပိတ်)။
- `channels.bluebubbles.dmHistoryLimit`: DM history ကန့်သတ်ချက်။
- `channels.bluebubbles.actions`: သီးသန့် actions များကို ဖွင့်/ပိတ်။
- `channels.bluebubbles.accounts`: Multi-account configuration။

ဆက်စပ် global options—

- `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`)။
- `messages.responsePrefix`။

## Addressing / delivery targets

တည်ငြိမ်သော routing အတွက် `chat_guid` ကို ဦးစားပေးပါ—

- `chat_guid:iMessage;-;+15555550123` (groups အတွက် အကြံပြု)
- `chat_id:123`
- `chat_identifier:...`
- Direct handles: `+15555550123`, `user@example.com`
  - 24. Direct handle တွင် ရှိပြီးသား DM chat မရှိပါက OpenClaw သည် `POST /api/v1/chat/new` မှတစ်ဆင့် အသစ်တစ်ခု ဖန်တီးပေးမည်ဖြစ်သည်။ 25. ထိုအတွက် BlueBubbles Private API ကို enable လုပ်ထားရမည်။

## Security

- 26. Webhook request များကို `guid`/`password` query param သို့မဟုတ် header များကို `channels.bluebubbles.password` နှင့် နှိုင်းယှဉ်ခြင်းဖြင့် authentication ပြုလုပ်သည်။ 27. `localhost` မှ လာသော request များကိုလည်း လက်ခံသည်။
- API password နှင့် webhook endpoint ကို လျှို့ဝှက်ထားပါ (credentials ကဲ့သို့ ကိုင်တွယ်ပါ)။
- 28. Localhost trust ကြောင့် same-host reverse proxy တစ်ခုသည် မလိုလားအပ်ဘဲ password ကို ကျော်ဖြတ်နိုင်သည်။ 29. Gateway ကို proxy လုပ်ပါက proxy တွင် auth ကို မဖြစ်မနေ တောင်းခံပြီး `gateway.trustedProxies` ကို configure လုပ်ပါ။ 30. [Gateway security](/gateway/security#reverse-proxy-configuration) ကို ကြည့်ပါ။
- LAN အပြင်သို့ ဖွင့်ထားပါက BlueBubbles server တွင် HTTPS + firewall rules များကို ဖွင့်ပါ။

## Troubleshooting

- Typing/read events မလုပ်တော့ပါက BlueBubbles webhook logs ကို စစ်ဆေးပြီး gateway path သည် `channels.bluebubbles.webhookPath` နှင့် ကိုက်ညီကြောင်း အတည်ပြုပါ။
- Pairing codes များသည် တစ်နာရီအကြာတွင် သက်တမ်းကုန်ပါသည်; `openclaw pairing list bluebubbles` နှင့် `openclaw pairing approve bluebubbles <code>` ကို အသုံးပြုပါ။
- Reactions များအတွက် BlueBubbles private API (`POST /api/v1/message/react`) လိုအပ်ပါသည်; server version တွင် ထုတ်ပေးထားကြောင်း သေချာပါစေ။
- 31. Edit/unsend သည် macOS 13+ နှင့် ကိုက်ညီသော BlueBubbles server version ကို လိုအပ်သည်။ 32. macOS 26 (Tahoe) တွင် private API ပြောင်းလဲမှုကြောင့် edit သည် လက်ရှိတွင် ပျက်နေပါသည်။
- macOS 26 (Tahoe) တွင် group icon updates များသည် မတည်ငြိမ်နိုင်ပါသည်—API သည် အောင်မြင်ကြောင်း ပြန်ပေးနိုင်သော်လည်း icon အသစ် မ sync ဖြစ်နိုင်ပါသည်။
- 33. OpenClaw သည် BlueBubbles server ၏ macOS version အပေါ် အခြေခံ၍ သိပြီးသား ပျက်နေသော action များကို အလိုအလျောက် ဖျောက်ထားသည်။ 34. macOS 26 (Tahoe) တွင် edit ပေါ်နေသေးပါက `channels.bluebubbles.actions.edit=false` ဖြင့် လက်ဖြင့် ပိတ်ပါ။
- Status/health အချက်အလက်များအတွက်: `openclaw status --all` သို့မဟုတ် `openclaw status --deep`။

ချန်နယ် လုပ်ငန်းစဉ် အထွေထွေကို သိရှိရန် [Channels](/channels) နှင့် [Plugins](/tools/plugin) လမ်းညွှန်ကို ကြည့်ပါ။
