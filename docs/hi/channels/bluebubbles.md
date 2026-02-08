---
summary: "BlueBubbles macOS सर्वर के माध्यम से iMessage (REST भेजना/प्राप्त करना, टाइपिंग, रिएक्शन, पेयरिंग, उन्नत क्रियाएँ)।"
read_when:
  - BlueBubbles चैनल सेटअप करना
  - वेबहुक पेयरिंग का समस्या-निवारण
  - macOS पर iMessage का विन्यास
title: "BlueBubbles"
x-i18n:
  source_path: channels/bluebubbles.md
  source_hash: a5208867c934460a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:18Z
---

# BlueBubbles (macOS REST)

स्थिति: बंडल्ड प्लगइन जो HTTP के माध्यम से BlueBubbles macOS सर्वर से बात करता है। **iMessage एकीकरण के लिए अनुशंसित**, क्योंकि इसकी API अधिक समृद्ध है और लेगेसी imsg चैनल की तुलना में सेटअप आसान है।

## अवलोकन

- macOS पर BlueBubbles सहायक ऐप के माध्यम से चलता है ([bluebubbles.app](https://bluebubbles.app)).
- अनुशंसित/परीक्षित: macOS Sequoia (15)। macOS Tahoe (26) काम करता है; Tahoe पर edit वर्तमान में टूटा हुआ है, और group icon अपडेट सफल रिपोर्ट हो सकते हैं लेकिन सिंक नहीं होते।
- OpenClaw इसके REST API के माध्यम से बात करता है (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`)।
- आने वाले संदेश वेबहुक के माध्यम से आते हैं; बाहर जाने वाले उत्तर, टाइपिंग संकेतक, read receipts और tapbacks REST कॉल होते हैं।
- अटैचमेंट और स्टिकर को इनबाउंड मीडिया के रूप में लिया जाता है (और संभव होने पर एजेंट को दिखाया जाता है)।
- पेयरिंग/allowlist अन्य चैनलों की तरह ही काम करता है (`/channels/pairing` आदि) `channels.bluebubbles.allowFrom` + पेयरिंग कोड के साथ।
- रिएक्शन को Slack/Telegram की तरह सिस्टम इवेंट्स के रूप में दिखाया जाता है ताकि एजेंट उत्तर देने से पहले उन्हें “mention” कर सकें।
- उन्नत विशेषताएँ: edit, unsend, reply threading, message effects, group management।

## त्वरित प्रारंभ

1. अपने Mac पर BlueBubbles सर्वर इंस्टॉल करें ([bluebubbles.app/install](https://bluebubbles.app/install) पर निर्देशों का पालन करें)।
2. BlueBubbles विन्यास में web API सक्षम करें और एक पासवर्ड सेट करें।
3. `openclaw onboard` चलाएँ और BlueBubbles चुनें, या मैन्युअली विन्यास करें:

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

4. BlueBubbles वेबहुक्स को अपने Gateway की ओर इंगित करें (उदाहरण: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)।
5. Gateway प्रारंभ करें; यह वेबहुक हैंडलर पंजीकृत करेगा और पेयरिंग शुरू करेगा।

## Messages.app को सक्रिय रखना (VM / हेडलेस सेटअप)

कुछ macOS VM / हमेशा-चालू सेटअप में Messages.app “idle” हो सकता है (ऐप खोले/foreground किए बिना इनकमिंग इवेंट रुक जाते हैं)। एक सरल उपाय है AppleScript + LaunchAgent का उपयोग करके **हर 5 मिनट में Messages को poke करना**।

### 1) AppleScript सहेजें

इसे इस नाम से सहेजें:

- `~/Scripts/poke-messages.scpt`

उदाहरण स्क्रिप्ट (non-interactive; फोकस नहीं चुराती):

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

### 2) LaunchAgent इंस्टॉल करें

इसे इस नाम से सहेजें:

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

नोट्स:

- यह **हर 300 सेकंड** और **लॉगिन पर** चलता है।
- पहली रन पर macOS **Automation** प्रॉम्प्ट आ सकते हैं (`osascript` → Messages)। इन्हें उसी यूज़र सत्र में अनुमोदित करें जो LaunchAgent चलाता है।

इसे लोड करें:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## ऑनबोर्डिंग

BlueBubbles इंटरैक्टिव सेटअप विज़ार्ड में उपलब्ध है:

```
openclaw onboard
```

विज़ार्ड इनकी मांग करता है:

- **Server URL** (आवश्यक): BlueBubbles सर्वर पता (उदा., `http://192.168.1.100:1234`)
- **Password** (आवश्यक): BlueBubbles Server सेटिंग्स से API पासवर्ड
- **Webhook path** (वैकल्पिक): डिफ़ॉल्ट `/bluebubbles-webhook`
- **DM policy**: pairing, allowlist, open, या disabled
- **Allow list**: फ़ोन नंबर, ईमेल, या चैट टार्गेट

आप CLI के माध्यम से भी BlueBubbles जोड़ सकते हैं:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## प्रवेश नियंत्रण (DMs + समूह)

DMs:

- डिफ़ॉल्ट: `channels.bluebubbles.dmPolicy = "pairing"`।
- अज्ञात प्रेषकों को पेयरिंग कोड मिलता है; अनुमोदन तक संदेश अनदेखे रहते हैं (कोड 1 घंटे बाद समाप्त होते हैं)।
- अनुमोदन करें:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- पेयरिंग डिफ़ॉल्ट टोकन एक्सचेंज है। विवरण: [Pairing](/channels/pairing)

समूह:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (डिफ़ॉल्ट: `allowlist`)।
- `channels.bluebubbles.groupAllowFrom` यह नियंत्रित करता है कि समूहों में कौन ट्रिगर कर सकता है जब `allowlist` सेट हो।

### Mention gating (समूह)

BlueBubbles समूह चैट्स के लिए mention gating का समर्थन करता है, जो iMessage/WhatsApp व्यवहार से मेल खाता है:

- मेंशन पहचानने के लिए `agents.list[].groupChat.mentionPatterns` (या `messages.groupChat.mentionPatterns`) का उपयोग करता है।
- जब किसी समूह के लिए `requireMention` सक्षम हो, एजेंट केवल मेंशन होने पर उत्तर देता है।
- अधिकृत प्रेषकों के कंट्रोल कमांड mention gating को बायपास करते हैं।

प्रति-समूह विन्यास:

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

- कंट्रोल कमांड (जैसे, `/config`, `/model`) के लिए प्रमाणीकरण आवश्यक है।
- कमांड प्रमाणीकरण निर्धारित करने के लिए `allowFrom` और `groupAllowFrom` का उपयोग होता है।
- अधिकृत प्रेषक समूहों में बिना मेंशन किए भी कंट्रोल कमांड चला सकते हैं।

## टाइपिंग + read receipts

- **Typing indicators**: उत्तर निर्माण से पहले और दौरान स्वचालित रूप से भेजे जाते हैं।
- **Read receipts**: `channels.bluebubbles.sendReadReceipts` द्वारा नियंत्रित (डिफ़ॉल्ट: `true`)।
- **Typing indicators**: OpenClaw typing start इवेंट भेजता है; BlueBubbles भेजने पर या टाइमआउट पर typing स्वतः साफ़ करता है (DELETE द्वारा मैन्युअल stop अविश्वसनीय है)।

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## उन्नत क्रियाएँ

विन्यास में सक्षम होने पर BlueBubbles उन्नत संदेश क्रियाओं का समर्थन करता है:

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

उपलब्ध क्रियाएँ:

- **react**: tapback रिएक्शन जोड़ें/हटाएँ (`messageId`, `emoji`, `remove`)
- **edit**: भेजे गए संदेश को संपादित करें (`messageId`, `text`)
- **unsend**: संदेश वापस लें (`messageId`)
- **reply**: किसी विशिष्ट संदेश का उत्तर दें (`messageId`, `text`, `to`)
- **sendWithEffect**: iMessage प्रभाव के साथ भेजें (`text`, `to`, `effectId`)
- **renameGroup**: समूह चैट का नाम बदलें (`chatGuid`, `displayName`)
- **setGroupIcon**: समूह चैट का आइकन/फ़ोटो सेट करें (`chatGuid`, `media`) — macOS 26 Tahoe पर अस्थिर (API सफलता लौटा सकता है लेकिन आइकन सिंक नहीं होता)।
- **addParticipant**: समूह में किसी को जोड़ें (`chatGuid`, `address`)
- **removeParticipant**: समूह से किसी को हटाएँ (`chatGuid`, `address`)
- **leaveGroup**: समूह चैट छोड़ें (`chatGuid`)
- **sendAttachment**: मीडिया/फ़ाइलें भेजें (`to`, `buffer`, `filename`, `asVoice`)
  - Voice memos: iMessage वॉइस संदेश के रूप में भेजने के लिए **MP3** या **CAF** ऑडियो के साथ `asVoice: true` सेट करें। BlueBubbles वॉइस मेमो भेजते समय MP3 → CAF में रूपांतरण करता है।

### Message IDs (short बनाम full)

OpenClaw टोकन बचाने के लिए _short_ message IDs (उदा., `1`, `2`) दिखा सकता है।

- `MessageSid` / `ReplyToId` short IDs हो सकते हैं।
- `MessageSidFull` / `ReplyToIdFull` में प्रदाता के full IDs होते हैं।
- Short IDs मेमोरी में होते हैं; रीस्टार्ट या कैश eviction पर समाप्त हो सकते हैं।
- क्रियाएँ short या full `messageId` स्वीकार करती हैं, लेकिन उपलब्ध न रहने पर short IDs त्रुटि देंगी।

स्थायी ऑटोमेशन और स्टोरेज के लिए full IDs का उपयोग करें:

- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Context: इनबाउंड payloads में `MessageSidFull` / `ReplyToIdFull`

Template वेरिएबल्स के लिए [Configuration](/gateway/configuration) देखें।

## ब्लॉक स्ट्रीमिंग

उत्तर एकल संदेश के रूप में भेजे जाएँ या ब्लॉक्स में स्ट्रीम हों, इसे नियंत्रित करें:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## मीडिया + सीमाएँ

- इनबाउंड अटैचमेंट डाउनलोड होकर मीडिया कैश में संग्रहीत होते हैं।
- मीडिया सीमा `channels.bluebubbles.mediaMaxMb` के माध्यम से (डिफ़ॉल्ट: 8 MB)।
- आउटबाउंड टेक्स्ट `channels.bluebubbles.textChunkLimit` तक चंक किया जाता है (डिफ़ॉल्ट: 4000 अक्षर)।

## विन्यास संदर्भ

पूर्ण विन्यास: [Configuration](/gateway/configuration)

Provider विकल्प:

- `channels.bluebubbles.enabled`: चैनल सक्षम/अक्षम करें।
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API base URL।
- `channels.bluebubbles.password`: API पासवर्ड।
- `channels.bluebubbles.webhookPath`: Webhook endpoint path (डिफ़ॉल्ट: `/bluebubbles-webhook`)।
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (डिफ़ॉल्ट: `pairing`)।
- `channels.bluebubbles.allowFrom`: DM allowlist (handles, ईमेल, E.164 नंबर, `chat_id:*`, `chat_guid:*`)।
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (डिफ़ॉल्ट: `allowlist`)।
- `channels.bluebubbles.groupAllowFrom`: समूह प्रेषक allowlist।
- `channels.bluebubbles.groups`: प्रति-समूह विन्यास (`requireMention` आदि)।
- `channels.bluebubbles.sendReadReceipts`: read receipts भेजें (डिफ़ॉल्ट: `true`)।
- `channels.bluebubbles.blockStreaming`: ब्लॉक स्ट्रीमिंग सक्षम करें (डिफ़ॉल्ट: `false`; स्ट्रीमिंग उत्तरों के लिए आवश्यक)।
- `channels.bluebubbles.textChunkLimit`: आउटबाउंड चंक आकार (अक्षरों में) (डिफ़ॉल्ट: 4000)।
- `channels.bluebubbles.chunkMode`: `length` (डिफ़ॉल्ट) केवल `textChunkLimit` से अधिक होने पर विभाजित करता है; `newline` लंबाई चंकिंग से पहले खाली पंक्तियों (पैराग्राफ सीमाएँ) पर विभाजित करता है।
- `channels.bluebubbles.mediaMaxMb`: इनबाउंड मीडिया सीमा MB में (डिफ़ॉल्ट: 8)।
- `channels.bluebubbles.historyLimit`: कॉन्टेक्स्ट के लिए अधिकतम समूह संदेश (0 अक्षम करता है)।
- `channels.bluebubbles.dmHistoryLimit`: DM इतिहास सीमा।
- `channels.bluebubbles.actions`: विशिष्ट क्रियाएँ सक्षम/अक्षम करें।
- `channels.bluebubbles.accounts`: मल्टी-अकाउंट विन्यास।

संबंधित वैश्विक विकल्प:

- `agents.list[].groupChat.mentionPatterns` (या `messages.groupChat.mentionPatterns`)।
- `messages.responsePrefix`।

## Addressing / delivery targets

स्थिर रूटिंग के लिए `chat_guid` को प्राथमिकता दें:

- `chat_guid:iMessage;-;+15555550123` (समूहों के लिए प्राथमिक)
- `chat_id:123`
- `chat_identifier:...`
- Direct handles: `+15555550123`, `user@example.com`
  - यदि किसी direct handle के लिए मौजूदा DM चैट नहीं है, OpenClaw `POST /api/v1/chat/new` के माध्यम से एक बनाएगा। इसके लिए BlueBubbles Private API सक्षम होना आवश्यक है।

## सुरक्षा

- वेबहुक अनुरोधों का प्रमाणीकरण `guid`/`password` क्वेरी पैरामीटर या हेडर को `channels.bluebubbles.password` से मिलान करके किया जाता है। `localhost` से आने वाले अनुरोध भी स्वीकार किए जाते हैं।
- API पासवर्ड और वेबहुक endpoint को गोपनीय रखें (इन्हें क्रेडेंशियल्स की तरह मानें)।
- Localhost trust का अर्थ है कि same-host reverse proxy अनजाने में पासवर्ड बायपास कर सकता है। यदि आप Gateway को प्रॉक्सी करते हैं, तो प्रॉक्सी पर auth अनिवार्य करें और `gateway.trustedProxies` विन्यस्त करें। देखें [Gateway security](/gateway/security#reverse-proxy-configuration)।
- यदि BlueBubbles सर्वर को अपने LAN के बाहर एक्सपोज़ करते हैं, तो HTTPS + फ़ायरवॉल नियम सक्षम करें।

## समस्या-निवारण

- यदि typing/read इवेंट्स काम करना बंद कर दें, तो BlueBubbles वेबहुक लॉग जाँचें और सुनिश्चित करें कि Gateway path `channels.bluebubbles.webhookPath` से मेल खाता है।
- पेयरिंग कोड एक घंटे बाद समाप्त हो जाते हैं; `openclaw pairing list bluebubbles` और `openclaw pairing approve bluebubbles <code>` का उपयोग करें।
- रिएक्शन के लिए BlueBubbles private API (`POST /api/v1/message/react`) आवश्यक है; सुनिश्चित करें कि सर्वर संस्करण इसे एक्सपोज़ करता है।
- Edit/unsend के लिए macOS 13+ और संगत BlueBubbles सर्वर संस्करण आवश्यक है। macOS 26 (Tahoe) पर private API बदलावों के कारण edit वर्तमान में टूटा हुआ है।
- macOS 26 (Tahoe) पर group icon अपडेट अस्थिर हो सकते हैं: API सफलता लौटा सकता है लेकिन नया आइकन सिंक नहीं होता।
- OpenClaw BlueBubbles सर्वर के macOS संस्करण के आधार पर ज्ञात-टूटी क्रियाओं को स्वतः छिपा देता है। यदि macOS 26 (Tahoe) पर edit फिर भी दिखे, तो `channels.bluebubbles.actions.edit=false` के साथ इसे मैन्युअली अक्षम करें।
- स्थिति/स्वास्थ्य जानकारी के लिए: `openclaw status --all` या `openclaw status --deep`।

सामान्य चैनल वर्कफ़्लो संदर्भ के लिए [Channels](/channels) और [Plugins](/tools/plugin) गाइड देखें।
