---
summary: "Matrix समर्थन स्थिति, क्षमताएँ, और विन्यास"
read_when:
  - Matrix चैनल सुविधाओं पर कार्य करते समय
title: "Matrix"
x-i18n:
  source_path: channels/matrix.md
  source_hash: 199b954b901cbb17
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:11Z
---

# Matrix (प्लगइन)

Matrix एक खुला, विकेंद्रीकृत मैसेजिंग प्रोटोकॉल है। OpenClaw किसी भी homeserver पर एक Matrix **उपयोगकर्ता**
के रूप में कनेक्ट होता है, इसलिए बॉट के लिए आपको एक Matrix खाता चाहिए। लॉग इन होने के बाद, आप सीधे बॉट को DM कर सकते हैं
या उसे कमरों (Matrix “groups”) में आमंत्रित कर सकते हैं। Beeper भी एक वैध क्लाइंट विकल्प है,
लेकिन इसके लिए E2EE सक्षम होना आवश्यक है।

स्थिति: प्लगइन के माध्यम से समर्थित (@vector-im/matrix-bot-sdk)। प्रत्यक्ष संदेश, कमरे, थ्रेड्स, मीडिया, प्रतिक्रियाएँ,
पोल (भेजना + poll-start को टेक्स्ट के रूप में), लोकेशन, और E2EE (क्रिप्टो समर्थन सहित)।

## प्लगइन आवश्यक

Matrix एक प्लगइन के रूप में आता है और कोर इंस्टॉल के साथ बंडल नहीं होता।

CLI के माध्यम से इंस्टॉल करें (npm रजिस्ट्री):

```bash
openclaw plugins install @openclaw/matrix
```

स्थानीय चेकआउट (जब git रिपॉज़िटरी से चला रहे हों):

```bash
openclaw plugins install ./extensions/matrix
```

यदि आप configure/onboarding के दौरान Matrix चुनते हैं और git चेकआउट का पता चलता है,
तो OpenClaw स्थानीय इंस्टॉल पथ स्वचालित रूप से प्रस्तावित करेगा।

विवरण: [Plugins](/tools/plugin)

## सेटअप

1. Matrix प्लगइन इंस्टॉल करें:
   - npm से: `openclaw plugins install @openclaw/matrix`
   - स्थानीय चेकआउट से: `openclaw plugins install ./extensions/matrix`
2. किसी homeserver पर Matrix खाता बनाएँ:
   - होस्टिंग विकल्प देखें: [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - या स्वयं होस्ट करें।
3. बॉट खाते के लिए एक एक्सेस टोकन प्राप्त करें:
   - अपने homeserver पर Matrix लॉगिन API को `curl` के साथ उपयोग करें:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - `matrix.example.org` को अपने homeserver URL से बदलें।
   - या `channels.matrix.userId` + `channels.matrix.password` सेट करें: OpenClaw वही
     लॉगिन एंडपॉइंट कॉल करता है, एक्सेस टोकन को `~/.openclaw/credentials/matrix/credentials.json` में संग्रहीत करता है,
     और अगली शुरुआत पर उसे पुनः उपयोग करता है।

4. क्रेडेंशियल्स कॉन्फ़िगर करें:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (या `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - या config: `channels.matrix.*`
   - यदि दोनों सेट हों, तो config को प्राथमिकता दी जाती है।
   - एक्सेस टोकन के साथ: उपयोगकर्ता ID स्वचालित रूप से `/whoami` के माध्यम से प्राप्त की जाती है।
   - जब सेट हो, तो `channels.matrix.userId` पूर्ण Matrix ID होना चाहिए (उदाहरण: `@bot:example.org`)।
5. Gateway को पुनः प्रारंभ करें (या onboarding पूरा करें)।
6. किसी भी Matrix क्लाइंट से बॉट के साथ DM शुरू करें या उसे किसी कमरे में आमंत्रित करें
   (Element, Beeper आदि; देखें [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/))। Beeper के लिए E2EE आवश्यक है,
   इसलिए `channels.matrix.encryption: true` सेट करें और डिवाइस सत्यापित करें।

न्यूनतम config (एक्सेस टोकन, उपयोगकर्ता ID स्वचालित रूप से प्राप्त):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE config (एंड-टू-एंड एन्क्रिप्शन सक्षम):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## एन्क्रिप्शन (E2EE)

एंड-टू-एंड एन्क्रिप्शन Rust क्रिप्टो SDK के माध्यम से **समर्थित** है।

`channels.matrix.encryption: true` के साथ सक्षम करें:

- यदि क्रिप्टो मॉड्यूल लोड हो जाता है, तो एन्क्रिप्टेड कमरे स्वचालित रूप से डिक्रिप्ट हो जाते हैं।
- एन्क्रिप्टेड कमरों में भेजते समय आउटबाउंड मीडिया एन्क्रिप्ट किया जाता है।
- पहली कनेक्शन पर, OpenClaw आपकी अन्य सत्रों से डिवाइस सत्यापन का अनुरोध करता है।
- कुंजी साझा करने को सक्षम करने के लिए किसी अन्य Matrix क्लाइंट (Element आदि) में डिवाइस सत्यापित करें।
- यदि क्रिप्टो मॉड्यूल लोड नहीं हो पाता, तो E2EE अक्षम हो जाता है और एन्क्रिप्टेड कमरे डिक्रिप्ट नहीं होंगे;
  OpenClaw एक चेतावनी लॉग करता है।
- यदि आपको क्रिप्टो मॉड्यूल से संबंधित त्रुटियाँ दिखें (उदाहरण के लिए, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  तो `@matrix-org/matrix-sdk-crypto-nodejs` के लिए बिल्ड स्क्रिप्ट्स को अनुमति दें और
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` चलाएँ या बाइनरी को
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` से प्राप्त करें।

क्रिप्टो स्थिति प्रति खाता + एक्सेस टोकन के आधार पर
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite डेटाबेस) में संग्रहीत होती है। सिंक स्थिति इसके साथ ही
`bot-storage.json` में रहती है।
यदि एक्सेस टोकन (डिवाइस) बदलता है, तो एक नया स्टोर बनाया जाता है और बॉट को
एन्क्रिप्टेड कमरों के लिए पुनः सत्यापित करना होगा।

**डिवाइस सत्यापन:**
जब E2EE सक्षम होता है, तो बॉट स्टार्टअप पर आपकी अन्य सत्रों से सत्यापन का अनुरोध करेगा।
Element (या किसी अन्य क्लाइंट) को खोलें और विश्वास स्थापित करने के लिए सत्यापन अनुरोध को स्वीकृत करें।
एक बार सत्यापित होने पर, बॉट एन्क्रिप्टेड कमरों में संदेशों को डिक्रिप्ट कर सकता है।

## रूटिंग मॉडल

- उत्तर हमेशा Matrix पर वापस जाते हैं।
- DMs एजेंट के मुख्य सत्र को साझा करते हैं; कमरे समूह सत्रों से मैप होते हैं।

## प्रवेश नियंत्रण (DMs)

- डिफ़ॉल्ट: `channels.matrix.dm.policy = "pairing"`। अज्ञात प्रेषकों को एक पेयरिंग कोड मिलता है।
- स्वीकृति दें:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- सार्वजनिक DMs: `channels.matrix.dm.policy="open"` तथा `channels.matrix.dm.allowFrom=["*"]`।
- `channels.matrix.dm.allowFrom` पूर्ण Matrix उपयोगकर्ता IDs स्वीकार करता है (उदाहरण: `@user:server`)। विज़ार्ड तब डिस्प्ले नामों को उपयोगकर्ता IDs में बदल देता है जब डायरेक्टरी खोज में एकल सटीक मिलान मिलता है।

## कमरे (समूह)

- डिफ़ॉल्ट: `channels.matrix.groupPolicy = "allowlist"` (मेंटियन-गेटेड)। जब अनसेट हो तो डिफ़ॉल्ट को ओवरराइड करने के लिए `channels.defaults.groupPolicy` उपयोग करें।
- `channels.matrix.groups` के साथ कमरों को allowlist करें (रूम IDs या उपनाम; जब डायरेक्टरी खोज में एकल सटीक मिलान मिलता है तो नाम IDs में बदले जाते हैं):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` उस कमरे में ऑटो-रिप्लाई सक्षम करता है।
- `groups."*"` कमरों में मेंशन गेटिंग के लिए डिफ़ॉल्ट सेट कर सकता है।
- `groupAllowFrom` यह सीमित करता है कि कमरों में कौन से प्रेषक बॉट को ट्रिगर कर सकते हैं (पूर्ण Matrix उपयोगकर्ता IDs)।
- प्रति-कमरा `users` allowlist किसी विशिष्ट कमरे के भीतर प्रेषकों को और सीमित कर सकती है (पूर्ण Matrix उपयोगकर्ता IDs का उपयोग करें)।
- configure विज़ार्ड रूम allowlists (रूम IDs, उपनाम, या नाम) के लिए पूछता है और केवल सटीक, अद्वितीय मिलान पर नामों को रिज़ॉल्व करता है।
- स्टार्टअप पर, OpenClaw allowlists में रूम/यूज़र नामों को IDs में बदलता है और मैपिंग लॉग करता है; अनसुलझी प्रविष्टियाँ allowlist मिलान के लिए अनदेखी की जाती हैं।
- आमंत्रण डिफ़ॉल्ट रूप से ऑटो-जॉइन होते हैं; `channels.matrix.autoJoin` और `channels.matrix.autoJoinAllowlist` से नियंत्रित करें।
- **कोई भी कमरे** अनुमति न देने के लिए, `channels.matrix.groupPolicy: "disabled"` सेट करें (या खाली allowlist रखें)।
- लेगेसी कुंजी: `channels.matrix.rooms` (आकृति `groups` के समान)।

## थ्रेड्स

- रिप्लाई थ्रेडिंग समर्थित है।
- `channels.matrix.threadReplies` नियंत्रित करता है कि उत्तर थ्रेड्स में ही रहें या नहीं:
  - `off`, `inbound` (डिफ़ॉल्ट), `always`
- `channels.matrix.replyToMode` नियंत्रित करता है कि थ्रेड में उत्तर न देने पर reply-to मेटाडेटा कैसे हो:
  - `off` (डिफ़ॉल्ट), `first`, `all`

## क्षमताएँ

| Feature         | Status                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| Direct messages | ✅ समर्थित                                                                                   |
| Rooms           | ✅ समर्थित                                                                                   |
| Threads         | ✅ समर्थित                                                                                   |
| Media           | ✅ समर्थित                                                                                   |
| E2EE            | ✅ समर्थित (क्रिप्टो मॉड्यूल आवश्यक)                                                         |
| Reactions       | ✅ समर्थित (टूल्स के माध्यम से भेजना/पढ़ना)                                                  |
| Polls           | ✅ भेजना समर्थित; इनबाउंड पोल स्टार्ट्स टेक्स्ट में परिवर्तित (प्रतिक्रियाएँ/समाप्ति अनदेखी) |
| Location        | ✅ समर्थित (geo URI; ऊँचाई अनदेखी)                                                           |
| Native commands | ✅ समर्थित                                                                                   |

## समस्या-निवारण

सबसे पहले यह लैडर चलाएँ:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

फिर आवश्यकता होने पर DM पेयरिंग स्थिति की पुष्टि करें:

```bash
openclaw pairing list matrix
```

सामान्य विफलताएँ:

- लॉग इन है लेकिन कमरे के संदेश अनदेखे हो रहे हैं: कमरा `groupPolicy` या रूम allowlist द्वारा ब्लॉक है।
- DMs अनदेखे: जब `channels.matrix.dm.policy="pairing"` हो तो प्रेषक अनुमोदन लंबित है।
- एन्क्रिप्टेड कमरे विफल: क्रिप्टो समर्थन या एन्क्रिप्शन सेटिंग्स में असंगति।

ट्रायेज फ़्लो के लिए: [/channels/troubleshooting](/channels/troubleshooting)।

## विन्यास संदर्भ (Matrix)

पूर्ण विन्यास: [Configuration](/gateway/configuration)

प्रदाता विकल्प:

- `channels.matrix.enabled`: चैनल स्टार्टअप सक्षम/अक्षम करें।
- `channels.matrix.homeserver`: homeserver URL।
- `channels.matrix.userId`: Matrix उपयोगकर्ता ID (एक्सेस टोकन के साथ वैकल्पिक)।
- `channels.matrix.accessToken`: एक्सेस टोकन।
- `channels.matrix.password`: लॉगिन के लिए पासवर्ड (टोकन संग्रहीत होता है)।
- `channels.matrix.deviceName`: डिवाइस डिस्प्ले नाम।
- `channels.matrix.encryption`: E2EE सक्षम करें (डिफ़ॉल्ट: false)।
- `channels.matrix.initialSyncLimit`: प्रारंभिक सिंक सीमा।
- `channels.matrix.threadReplies`: `off | inbound | always` (डिफ़ॉल्ट: inbound)।
- `channels.matrix.textChunkLimit`: आउटबाउंड टेक्स्ट चंक आकार (अक्षर)।
- `channels.matrix.chunkMode`: `length` (डिफ़ॉल्ट) या `newline` ताकि लंबाई चंकिंग से पहले खाली पंक्तियों (अनुच्छेद सीमाएँ) पर विभाजित किया जा सके।
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (डिफ़ॉल्ट: pairing)।
- `channels.matrix.dm.allowFrom`: DM allowlist (पूर्ण Matrix उपयोगकर्ता IDs)। `open` के लिए `"*"` आवश्यक है। विज़ार्ड जहाँ संभव हो नामों को IDs में बदल देता है।
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (डिफ़ॉल्ट: allowlist)।
- `channels.matrix.groupAllowFrom`: समूह संदेशों के लिए allowlisted प्रेषक (पूर्ण Matrix उपयोगकर्ता IDs)।
- `channels.matrix.allowlistOnly`: DMs + कमरों के लिए allowlist नियमों को बाध्य करें।
- `channels.matrix.groups`: समूह allowlist + प्रति-कमरा सेटिंग्स मैप।
- `channels.matrix.rooms`: लेगेसी समूह allowlist/विन्यास।
- `channels.matrix.replyToMode`: थ्रेड्स/टैग्स के लिए reply-to मोड।
- `channels.matrix.mediaMaxMb`: इनबाउंड/आउटबाउंड मीडिया सीमा (MB)।
- `channels.matrix.autoJoin`: आमंत्रण हैंडलिंग (`always | allowlist | off`, डिफ़ॉल्ट: always)।
- `channels.matrix.autoJoinAllowlist`: ऑटो-जॉइन के लिए अनुमत रूम IDs/उपनाम।
- `channels.matrix.actions`: प्रति-एक्शन टूल गेटिंग (reactions/messages/pins/memberInfo/channelInfo)।
