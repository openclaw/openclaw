---
summary: "LINE Messaging API प्लगइन का सेटअप, विन्यास और उपयोग"
read_when:
  - आप OpenClaw को LINE से कनेक्ट करना चाहते हैं
  - आपको LINE वेबहुक + क्रेडेंशियल सेटअप की आवश्यकता है
  - आप LINE-विशिष्ट संदेश विकल्प चाहते हैं
title: LINE
x-i18n:
  source_path: channels/line.md
  source_hash: 52eb66d06d616173
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:53Z
---

# LINE (प्लगइन)

LINE, LINE Messaging API के माध्यम से OpenClaw से जुड़ता है। यह प्लगइन Gateway पर
वेबहुक रिसीवर के रूप में चलता है और प्रमाणीकरण के लिए आपके चैनल एक्सेस टोकन और
चैनल सीक्रेट का उपयोग करता है।

स्थिति: प्लगइन के माध्यम से समर्थित। डायरेक्ट संदेश, समूह चैट, मीडिया, लोकेशन,
Flex संदेश, टेम्पलेट संदेश और क्विक रिप्लाई समर्थित हैं। रिएक्शन और थ्रेड्स
समर्थित नहीं हैं।

## Plugin required

LINE प्लगइन इंस्टॉल करें:

```bash
openclaw plugins install @openclaw/line
```

लोकल चेकआउट (जब git repo से चला रहे हों):

```bash
openclaw plugins install ./extensions/line
```

## Setup

1. LINE Developers खाता बनाएं और Console खोलें:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. एक Provider बनाएं (या चुनें) और एक **Messaging API** चैनल जोड़ें।
3. चैनल सेटिंग्स से **Channel access token** और **Channel secret** कॉपी करें।
4. Messaging API सेटिंग्स में **Use webhook** सक्षम करें।
5. वेबहुक URL को अपने Gateway एंडपॉइंट पर सेट करें (HTTPS आवश्यक):

```
https://gateway-host/line/webhook
```

Gateway, LINE के वेबहुक सत्यापन (GET) और इनबाउंड इवेंट्स (POST) का उत्तर देता है।
यदि आपको कस्टम पाथ चाहिए, तो `channels.line.webhookPath` या
`channels.line.accounts.<id>.webhookPath` सेट करें और URL को उसी अनुसार अपडेट करें।

## Configure

न्यूनतम विन्यास:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Env vars (केवल डिफ़ॉल्ट अकाउंट):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

टोकन/सीक्रेट फ़ाइलें:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

एकाधिक अकाउंट्स:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Access control

डायरेक्ट संदेश डिफ़ॉल्ट रूप से pairing पर सेट होते हैं। अज्ञात प्रेषकों को
एक pairing कोड मिलता है और स्वीकृत होने तक उनके संदेश अनदेखा किए जाते हैं।

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Allowlists और नीतियाँ:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: DMs के लिए allowlisted LINE उपयोगकर्ता IDs
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: समूहों के लिए allowlisted LINE उपयोगकर्ता IDs
- प्रति-समूह ओवरराइड्स: `channels.line.groups.<groupId>.allowFrom`

LINE IDs केस-सेंसिटिव होती हैं। वैध IDs इस प्रकार दिखती हैं:

- User: `U` + 32 hex chars
- Group: `C` + 32 hex chars
- Room: `R` + 32 hex chars

## Message behavior

- टेक्स्ट को 5000 अक्षरों पर विभाजित किया जाता है।
- Markdown फ़ॉर्मैटिंग हटा दी जाती है; कोड ब्लॉक्स और टेबल्स को, जहाँ संभव हो,
  Flex कार्ड्स में बदला जाता है।
- स्ट्रीमिंग प्रतिक्रियाएँ बफ़र की जाती हैं; एजेंट के काम करने के दौरान LINE को
  लोडिंग ऐनिमेशन के साथ पूर्ण चंक्स प्राप्त होते हैं।
- मीडिया डाउनलोड्स `channels.line.mediaMaxMb` द्वारा सीमित हैं (डिफ़ॉल्ट 10)।

## Channel data (rich messages)

क्विक रिप्लाई, लोकेशन, Flex कार्ड्स या टेम्पलेट संदेश भेजने के लिए `channelData.line`
का उपयोग करें।

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE प्लगइन Flex संदेश प्रीसेट्स के लिए एक `/card` कमांड भी प्रदान करता है:

```
/card info "Welcome" "Thanks for joining!"
```

## Troubleshooting

- **Webhook verification fails:** सुनिश्चित करें कि वेबहुक URL HTTPS है और
  `channelSecret` LINE console से मेल खाता है।
- **No inbound events:** पुष्टि करें कि वेबहुक पाथ `channels.line.webhookPath` से मेल खाता है
  और Gateway, LINE से पहुँचा जा सकता है।
- **Media download errors:** यदि मीडिया डिफ़ॉल्ट सीमा से अधिक है, तो
  `channels.line.mediaMaxMb` बढ़ाएँ।
