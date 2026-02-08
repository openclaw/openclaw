---
summary: "imsg के माध्यम से लीगेसी iMessage समर्थन (stdio पर JSON-RPC)। नए सेटअप के लिए BlueBubbles का उपयोग करना चाहिए।"
read_when:
  - iMessage समर्थन सेट करते समय
  - iMessage भेजने/प्राप्त करने में डिबगिंग
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:21Z
---

# iMessage (लीगेसी: imsg)

> **अनुशंसित:** नए iMessage सेटअप के लिए [BlueBubbles](/channels/bluebubbles) का उपयोग करें।
>
> `imsg` चैनल एक लीगेसी बाहरी-CLI एकीकरण है और भविष्य के किसी रिलीज़ में हटाया जा सकता है।

स्थिति: लीगेसी बाहरी CLI एकीकरण। Gateway, `imsg rpc` (stdio पर JSON-RPC) को स्पॉन करता है।

## त्वरित सेटअप (शुरुआती)

1. सुनिश्चित करें कि इस Mac पर Messages में साइन इन है।
2. `imsg` इंस्टॉल करें:
   - `brew install steipete/tap/imsg`
3. OpenClaw को `channels.imessage.cliPath` और `channels.imessage.dbPath` के साथ कॉन्फ़िगर करें।
4. Gateway प्रारंभ करें और किसी भी macOS प्रॉम्प्ट (Automation + Full Disk Access) को स्वीकृत करें।

न्यूनतम विन्यास:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## यह क्या है

- macOS पर `imsg` द्वारा समर्थित iMessage चैनल।
- निर्धारक रूटिंग: उत्तर हमेशा iMessage पर ही वापस जाते हैं।
- DMs एजेंट के मुख्य सत्र को साझा करते हैं; समूह अलग-थलग होते हैं (`agent:<agentId>:imessage:group:<chat_id>`)।
- यदि किसी बहु-प्रतिभागी थ्रेड का आगमन `is_group=false` के साथ होता है, तो भी आप `channels.imessage.groups` का उपयोग करके `chat_id` द्वारा इसे अलग कर सकते हैं (नीचे “Group-ish threads” देखें)।

## Config writes

डिफ़ॉल्ट रूप से, iMessage को `/config set|unset` द्वारा ट्रिगर किए गए config अपडेट लिखने की अनुमति है (इसके लिए `commands.config: true` आवश्यक है)।

इसे अक्षम करने के लिए:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## आवश्यकताएँ

- Messages में साइन इन के साथ macOS।
- OpenClaw + `imsg` के लिए Full Disk Access (Messages DB एक्सेस)।
- भेजते समय Automation अनुमति।
- `channels.imessage.cliPath` किसी भी ऐसे कमांड की ओर इंगित कर सकता है जो stdin/stdout को प्रॉक्सी करता हो (उदाहरण के लिए, एक रैपर स्क्रिप्ट जो SSH के माध्यम से दूसरे Mac से जुड़कर `imsg rpc` चलाती है)।

## macOS Privacy and Security TCC समस्या-निवारण

यदि भेजना/प्राप्त करना विफल होता है (उदाहरण के लिए, `imsg rpc` नॉन-ज़ीरो के साथ एग्ज़िट हो जाए, टाइम आउट हो, या Gateway अटका हुआ दिखे), तो एक सामान्य कारण macOS अनुमति प्रॉम्प्ट का कभी स्वीकृत न होना है।

macOS TCC अनुमतियाँ प्रति ऐप/प्रोसेस संदर्भ के आधार पर देता है। उसी संदर्भ में प्रॉम्प्ट स्वीकृत करें जो `imsg` चलाता है (उदाहरण के लिए, Terminal/iTerm, LaunchAgent सत्र, या SSH से शुरू की गई प्रक्रिया)।

चेकलिस्ट:

- **Full Disk Access**: OpenClaw चलाने वाली प्रक्रिया (और कोई भी shell/SSH रैपर जो `imsg` निष्पादित करता है) के लिए अनुमति दें। Messages डेटाबेस (`chat.db`) पढ़ने के लिए यह आवश्यक है।
- **Automation → Messages**: आउटबाउंड भेजने के लिए OpenClaw (और/या आपका टर्मिनल) चलाने वाली प्रक्रिया को **Messages.app** नियंत्रित करने की अनुमति दें।
- **`imsg` CLI स्वास्थ्य**: सत्यापित करें कि `imsg` इंस्टॉल है और RPC (`imsg rpc --help`) का समर्थन करता है।

सुझाव: यदि OpenClaw हेडलेस (LaunchAgent/systemd/SSH) चल रहा है, तो macOS प्रॉम्प्ट आसानी से छूट सकता है। प्रॉम्प्ट को मजबूर करने के लिए GUI टर्मिनल में एक बार इंटरैक्टिव कमांड चलाएँ, फिर पुनः प्रयास करें:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

संबंधित macOS फ़ोल्डर अनुमतियाँ (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions)।

## सेटअप (त्वरित मार्ग)

1. सुनिश्चित करें कि इस Mac पर Messages में साइन इन है।
2. iMessage कॉन्फ़िगर करें और Gateway प्रारंभ करें।

### समर्पित बॉट macOS उपयोगकर्ता (अलग पहचान के लिए)

यदि आप चाहते हैं कि बॉट **अलग iMessage पहचान** से भेजे (और आपके व्यक्तिगत Messages साफ़ रहें), तो एक समर्पित Apple ID + एक समर्पित macOS उपयोगकर्ता का उपयोग करें।

1. एक समर्पित Apple ID बनाएँ (उदाहरण: `my-cool-bot@icloud.com`)।
   - Apple सत्यापन / 2FA के लिए फ़ोन नंबर मांग सकता है।
2. एक macOS उपयोगकर्ता बनाएँ (उदाहरण: `openclawhome`) और उसमें साइन इन करें।
3. उस macOS उपयोगकर्ता में Messages खोलें और बॉट Apple ID से iMessage में साइन इन करें।
4. Remote Login सक्षम करें (System Settings → General → Sharing → Remote Login)।
5. `imsg` इंस्टॉल करें:
   - `brew install steipete/tap/imsg`
6. SSH सेटअप करें ताकि `ssh <bot-macos-user>@localhost true` बिना पासवर्ड के काम करे।
7. `channels.imessage.accounts.bot.cliPath` को ऐसे SSH रैपर की ओर इंगित करें जो बॉट उपयोगकर्ता के रूप में `imsg` चलाए।

पहली बार चलाने का नोट: भेजना/प्राप्त करना _बॉट macOS उपयोगकर्ता_ में GUI अनुमोदनों (Automation + Full Disk Access) की आवश्यकता हो सकती है। यदि `imsg rpc` अटका हुआ लगे या एग्ज़िट हो जाए, तो उस उपयोगकर्ता में लॉग इन करें (Screen Sharing सहायक होता है), एक बार `imsg chats --limit 1` / `imsg send ...` चलाएँ, प्रॉम्प्ट स्वीकृत करें, फिर पुनः प्रयास करें। देखें [Troubleshooting macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc)।

उदाहरण रैपर (`chmod +x`)। `<bot-macos-user>` को अपने वास्तविक macOS उपयोगकर्ता नाम से बदलें:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

उदाहरण विन्यास:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

एकल-खाता सेटअप के लिए, `accounts` मैप के बजाय फ्लैट विकल्प (`channels.imessage.cliPath`, `channels.imessage.dbPath`) का उपयोग करें।

### रिमोट/SSH वैरिएंट (वैकल्पिक)

यदि आप iMessage को किसी अन्य Mac पर चाहते हैं, तो `channels.imessage.cliPath` को ऐसे रैपर पर सेट करें जो SSH के माध्यम से रिमोट macOS होस्ट पर `imsg` चलाता हो। OpenClaw को केवल stdio की आवश्यकता होती है।

उदाहरण रैपर:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**रिमोट अटैचमेंट्स:** जब `cliPath` SSH के माध्यम से किसी रिमोट होस्ट की ओर इंगित करता है, तो Messages डेटाबेस में अटैचमेंट पाथ रिमोट मशीन की फ़ाइलों को संदर्भित करते हैं। `channels.imessage.remoteHost` सेट करके OpenClaw इन्हें SCP के माध्यम से स्वचालित रूप से प्राप्त कर सकता है:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

यदि `remoteHost` सेट नहीं है, तो OpenClaw आपके रैपर स्क्रिप्ट में SSH कमांड को पार्स करके इसे स्वतः पहचानने का प्रयास करता है। विश्वसनीयता के लिए स्पष्ट कॉन्फ़िगरेशन की अनुशंसा की जाती है।

#### Tailscale के माध्यम से रिमोट Mac (उदाहरण)

यदि Gateway किसी Linux होस्ट/VM पर चलता है लेकिन iMessage को Mac पर चलना आवश्यक है, तो Tailscale सबसे सरल ब्रिज है: Gateway tailnet के माध्यम से Mac से बात करता है, SSH के जरिए `imsg` चलाता है, और SCP के जरिए अटैचमेंट्स वापस लाता है।

आर्किटेक्चर:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

ठोस विन्यास उदाहरण (Tailscale होस्टनेम):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

उदाहरण रैपर (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

नोट्स:

- सुनिश्चित करें कि Mac में Messages में साइन इन है, और Remote Login सक्षम है।
- SSH कुंजियों का उपयोग करें ताकि `ssh bot@mac-mini.tailnet-1234.ts.net` बिना प्रॉम्प्ट के काम करे।
- `remoteHost` को SSH लक्ष्य से मेल खाना चाहिए ताकि SCP अटैचमेंट्स ला सके।

मल्टी-अकाउंट समर्थन: प्रति-अकाउंट विन्यास और वैकल्पिक `name` के साथ `channels.imessage.accounts` का उपयोग करें। साझा पैटर्न के लिए देखें [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)। `~/.openclaw/openclaw.json` को कमिट न करें (इसमें अक्सर टोकन होते हैं)।

## प्रवेश नियंत्रण (DMs + समूह)

DMs:

- डिफ़ॉल्ट: `channels.imessage.dmPolicy = "pairing"`।
- अज्ञात प्रेषकों को एक पेयरिंग कोड मिलता है; स्वीकृत होने तक संदेश अनदेखा किए जाते हैं (कोड 1 घंटे बाद समाप्त हो जाते हैं)।
- स्वीकृति:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- पेयरिंग iMessage DMs के लिए डिफ़ॉल्ट टोकन एक्सचेंज है। विवरण: [Pairing](/channels/pairing)

समूह:

- `channels.imessage.groupPolicy = open | allowlist | disabled`।
- `allowlist` सेट होने पर समूहों में कौन ट्रिगर कर सकता है, यह `channels.imessage.groupAllowFrom` नियंत्रित करता है।
- मेंशन गेटिंग `agents.list[].groupChat.mentionPatterns` (या `messages.groupChat.mentionPatterns`) का उपयोग करती है क्योंकि iMessage में मूल मेंशन मेटाडेटा नहीं है।
- मल्टी-एजेंट ओवरराइड: `agents.list[].groupChat.mentionPatterns` पर प्रति-एजेंट पैटर्न सेट करें।

## यह कैसे काम करता है (व्यवहार)

- `imsg` संदेश इवेंट्स स्ट्रीम करता है; Gateway उन्हें साझा चैनल एनवेलप में सामान्यीकृत करता है।
- उत्तर हमेशा उसी चैट आईडी या हैंडल पर रूट होते हैं।

## Group-ish थ्रेड्स (`is_group=false`)

कुछ iMessage थ्रेड्स में कई प्रतिभागी हो सकते हैं, लेकिन Messages द्वारा चैट पहचानकर्ता को संग्रहीत करने के तरीके के आधार पर वे फिर भी `is_group=false` के साथ आ सकते हैं।

यदि आप `channels.imessage.groups` के अंतर्गत स्पष्ट रूप से एक `chat_id` कॉन्फ़िगर करते हैं, तो OpenClaw उस थ्रेड को निम्न के लिए “समूह” के रूप में मानता है:

- सत्र पृथक्करण (अलग `agent:<agentId>:imessage:group:<chat_id>` सत्र कुंजी)
- समूह allowlisting / मेंशन गेटिंग व्यवहार

उदाहरण:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

यह तब उपयोगी है जब आप किसी विशिष्ट थ्रेड के लिए अलग व्यक्तित्व/मॉडल चाहते हों (देखें [Multi-agent routing](/concepts/multi-agent))। फ़ाइलसिस्टम पृथक्करण के लिए, देखें [Sandboxing](/gateway/sandboxing)।

## मीडिया + सीमाएँ

- `channels.imessage.includeAttachments` के माध्यम से वैकल्पिक अटैचमेंट इनजेस्ट।
- `channels.imessage.mediaMaxMb` के माध्यम से मीडिया कैप।

## सीमाएँ

- आउटबाउंड टेक्स्ट `channels.imessage.textChunkLimit` तक चंक किया जाता है (डिफ़ॉल्ट 4000)।
- वैकल्पिक न्यूलाइन चंकिंग: लंबाई चंकिंग से पहले खाली पंक्तियों (अनुच्छेद सीमाएँ) पर विभाजित करने के लिए `channels.imessage.chunkMode="newline"` सेट करें।
- मीडिया अपलोड `channels.imessage.mediaMaxMb` द्वारा सीमित हैं (डिफ़ॉल्ट 16)।

## एड्रेसिंग / डिलीवरी लक्ष्य

स्थिर रूटिंग के लिए `chat_id` को प्राथमिकता दें:

- `chat_id:123` (प्राथमिक)
- `chat_guid:...`
- `chat_identifier:...`
- सीधे हैंडल: `imessage:+1555` / `sms:+1555` / `user@example.com`

चैट सूचीबद्ध करें:

```
imsg chats --limit 20
```

## विन्यास संदर्भ (iMessage)

पूर्ण विन्यास: [Configuration](/gateway/configuration)

प्रदाता विकल्प:

- `channels.imessage.enabled`: चैनल स्टार्टअप सक्षम/अक्षम करें।
- `channels.imessage.cliPath`: `imsg` का पाथ।
- `channels.imessage.dbPath`: Messages DB पाथ।
- `channels.imessage.remoteHost`: जब `cliPath` किसी रिमोट Mac की ओर इंगित करता है (उदाहरण: `user@gateway-host`) तब SCP अटैचमेंट ट्रांसफ़र के लिए SSH होस्ट। यदि सेट नहीं है तो SSH रैपर से स्वतः पहचाना जाता है।
- `channels.imessage.service`: `imessage | sms | auto`।
- `channels.imessage.region`: SMS क्षेत्र।
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (डिफ़ॉल्ट: pairing)।
- `channels.imessage.allowFrom`: DM allowlist (हैंडल, ईमेल, E.164 नंबर, या `chat_id:*`)। `open` के लिए `"*"` आवश्यक है। iMessage में उपयोगकर्ता नाम नहीं होते; हैंडल या चैट लक्ष्य का उपयोग करें।
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (डिफ़ॉल्ट: allowlist)।
- `channels.imessage.groupAllowFrom`: समूह प्रेषक allowlist।
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: संदर्भ में शामिल करने के लिए अधिकतम समूह संदेश (0 अक्षम करता है)।
- `channels.imessage.dmHistoryLimit`: उपयोगकर्ता टर्न्स में DM इतिहास सीमा। प्रति-उपयोगकर्ता ओवरराइड: `channels.imessage.dms["<handle>"].historyLimit`।
- `channels.imessage.groups`: प्रति-समूह डिफ़ॉल्ट + allowlist (वैश्विक डिफ़ॉल्ट के लिए `"*"` का उपयोग करें)।
- `channels.imessage.includeAttachments`: अटैचमेंट्स को संदर्भ में इनजेस्ट करें।
- `channels.imessage.mediaMaxMb`: इनबाउंड/आउटबाउंड मीडिया कैप (MB)।
- `channels.imessage.textChunkLimit`: आउटबाउंड चंक आकार (अक्षर)।
- `channels.imessage.chunkMode`: लंबाई चंकिंग से पहले खाली पंक्तियों (अनुच्छेद सीमाएँ) पर विभाजित करने के लिए `length` (डिफ़ॉल्ट) या `newline`।

संबंधित वैश्विक विकल्प:

- `agents.list[].groupChat.mentionPatterns` (या `messages.groupChat.mentionPatterns`)।
- `messages.responsePrefix`।
