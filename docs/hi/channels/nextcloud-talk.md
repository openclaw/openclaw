---
summary: "Nextcloud Talk समर्थन की स्थिति, क्षमताएँ, और विन्यास"
read_when:
  - Nextcloud Talk चैनल की विशेषताओं पर काम करते समय
title: "Nextcloud Talk"
---

# Nextcloud Talk (प्लगइन)

स्थिति: प्लगइन (वेबहुक बॉट) के माध्यम से समर्थित। डायरेक्ट मैसेज, रूम्स, रिएक्शन्स और मार्कडाउन संदेश समर्थित हैं।

## प्लगइन आवश्यक

Nextcloud Talk एक प्लगइन के रूप में उपलब्ध है और कोर इंस्टॉल के साथ बंडल नहीं होता।

CLI के माध्यम से इंस्टॉल करें (npm रजिस्ट्री):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

लोकल चेकआउट (जब git रिपॉज़िटरी से चला रहे हों):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

यदि आप कॉन्फ़िगर/ऑनबोर्डिंग के दौरान Nextcloud Talk चुनते हैं और git चेकआउट का पता चलता है,
तो OpenClaw स्वतः ही लोकल इंस्टॉल पथ प्रदान करेगा।

विवरण: [Plugins](/tools/plugin)

## त्वरित सेटअप (शुरुआती)

1. Nextcloud Talk प्लगइन इंस्टॉल करें।

2. अपने Nextcloud सर्वर पर एक बॉट बनाएँ:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. लक्ष्य कमरे की सेटिंग्स में बॉट सक्षम करें।

4. OpenClaw को कॉन्फ़िगर करें:
   - विन्यास: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - या env: `NEXTCLOUD_TALK_BOT_SECRET` (केवल डिफ़ॉल्ट अकाउंट)

5. Gateway को पुनः प्रारंभ करें (या ऑनबोर्डिंग पूर्ण करें)।

न्यूनतम विन्यास:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## टिप्पणियाँ

- बॉट्स DMs की शुरुआत नहीं कर सकते। उपयोगकर्ता को पहले बॉट को संदेश भेजना होगा।
- वेबहुक URL Gateway द्वारा पहुँचा जा सकना चाहिए; यदि प्रॉक्सी के पीछे हों तो `webhookPublicUrl` सेट करें।
- मीडिया अपलोड बॉट API द्वारा समर्थित नहीं हैं; मीडिया URLs के रूप में भेजा जाता है।
- वेबहुक पेलोड DMs और कमरों में अंतर नहीं करता; कमरे-प्रकार लुकअप सक्षम करने के लिए `apiUser` + `apiPassword` सेट करें (अन्यथा DMs को कमरे माना जाता है)।

## प्रवेश नियंत्रण (DMs)

- डिफ़ॉल्ट: `channels.nextcloud-talk.dmPolicy = "pairing"`। Unknown senders get a pairing code.
- स्वीकृति के माध्यम से:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- सार्वजनिक DMs: `channels.nextcloud-talk.dmPolicy="open"` के साथ `channels.nextcloud-talk.allowFrom=["*"]`।
- `allowFrom` केवल Nextcloud उपयोगकर्ता IDs से मेल खाता है; डिस्प्ले नामों की अनदेखी की जाती है।

## कमरे (समूह)

- डिफ़ॉल्ट: `channels.nextcloud-talk.groupPolicy = "allowlist"` (मेंटशन-गेटेड)।
- `channels.nextcloud-talk.rooms` के साथ कमरों को अलाउलिस्ट करें:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- किसी भी कमरे को अनुमति न देने के लिए, अलाउलिस्ट खाली रखें या `channels.nextcloud-talk.groupPolicy="disabled"` सेट करें।

## क्षमताएँ

| विशेषता         | स्थिति       |
| --------------- | ------------ |
| प्रत्यक्ष संदेश | समर्थित      |
| कमरे            | समर्थित      |
| थ्रेड्स         | समर्थित नहीं |
| मीडिया          | केवल-URL     |
| रिएक्शन         | समर्थित      |
| नेटिव कमांड्स   | समर्थित नहीं |

## विन्यास संदर्भ (Nextcloud Talk)

पूर्ण विन्यास: [Configuration](/gateway/configuration)

प्रदाता विकल्प:

- `channels.nextcloud-talk.enabled`: चैनल स्टार्टअप सक्षम/अक्षम करें।
- `channels.nextcloud-talk.baseUrl`: Nextcloud इंस्टेंस URL।
- `channels.nextcloud-talk.botSecret`: बॉट साझा सीक्रेट।
- `channels.nextcloud-talk.botSecretFile`: सीक्रेट फ़ाइल पथ।
- `channels.nextcloud-talk.apiUser`: कमरे लुकअप (DM पहचान) के लिए API उपयोगकर्ता।
- `channels.nextcloud-talk.apiPassword`: कमरे लुकअप के लिए API/ऐप पासवर्ड।
- `channels.nextcloud-talk.apiPasswordFile`: API पासवर्ड फ़ाइल पथ।
- `channels.nextcloud-talk.webhookPort`: वेबहुक लिस्नर पोर्ट (डिफ़ॉल्ट: 8788)।
- `channels.nextcloud-talk.webhookHost`: वेबहुक होस्ट (डिफ़ॉल्ट: 0.0.0.0)।
- `channels.nextcloud-talk.webhookPath`: वेबहुक पथ (डिफ़ॉल्ट: /nextcloud-talk-webhook)।
- `channels.nextcloud-talk.webhookPublicUrl`: बाहरी रूप से पहुँचा जा सकने वाला वेबहुक URL।
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`।
- `channels.nextcloud-talk.allowFrom`: DM अलाउलिस्ट (यूज़र IDs)। `open` के लिए `"*"` आवश्यक है।
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`।
- `channels.nextcloud-talk.groupAllowFrom`: समूह अलाउलिस्ट (उपयोगकर्ता IDs)।
- `channels.nextcloud-talk.rooms`: प्रति-कमरा सेटिंग्स और अलाउलिस्ट।
- `channels.nextcloud-talk.historyLimit`: समूह इतिहास सीमा (0 अक्षम करता है)।
- `channels.nextcloud-talk.dmHistoryLimit`: DM इतिहास सीमा (0 अक्षम करता है)।
- `channels.nextcloud-talk.dms`: प्रति-DM ओवरराइड्स (historyLimit)।
- `channels.nextcloud-talk.textChunkLimit`: आउटबाउंड टेक्स्ट चंक आकार (अक्षर)।
- `channels.nextcloud-talk.chunkMode`: `length` (डिफ़ॉल्ट) या लंबाई के अनुसार चंकिंग से पहले खाली पंक्तियों (अनुच्छेद सीमाएँ) पर विभाजित करने के लिए `newline`।
- `channels.nextcloud-talk.blockStreaming`: इस चैनल के लिए ब्लॉक स्ट्रीमिंग अक्षम करें।
- `channels.nextcloud-talk.blockStreamingCoalesce`: ब्लॉक स्ट्रीमिंग कोएलैस ट्यूनिंग।
- `channels.nextcloud-talk.mediaMaxMb`: इनबाउंड मीडिया सीमा (MB)।
