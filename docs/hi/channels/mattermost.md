---
summary: "Mattermost बॉट सेटअप और OpenClaw विन्यास"
read_when:
  - Mattermost सेटअप करते समय
  - Mattermost रूटिंग का डिबग करते समय
title: "Mattermost"
---

# Mattermost (प्लगइन)

Status: supported via plugin (bot token + WebSocket events). Channels, groups, and DMs are supported.
Mattermost is a self-hostable team messaging platform; see the official site at
[mattermost.com](https://mattermost.com) for product details and downloads.

## प्लगइन आवश्यक

Mattermost एक प्लगइन के रूप में प्रदान किया जाता है और कोर इंस्टॉल के साथ बंडल नहीं होता।

CLI के माध्यम से इंस्टॉल करें (npm रजिस्ट्री):

```bash
openclaw plugins install @openclaw/mattermost
```

स्थानीय चेकआउट (जब git रिपॉज़िटरी से चला रहे हों):

```bash
openclaw plugins install ./extensions/mattermost
```

यदि आप configure/onboarding के दौरान Mattermost चुनते हैं और git चेकआउट का पता चलता है,
तो OpenClaw स्थानीय इंस्टॉल पथ स्वतः प्रदान करेगा।

विवरण: [Plugins](/tools/plugin)

## त्वरित सेटअप

1. Mattermost प्लगइन इंस्टॉल करें।
2. एक Mattermost बॉट खाता बनाएँ और **बॉट टोकन** कॉपी करें।
3. Mattermost **बेस URL** कॉपी करें (उदा., `https://chat.example.com`)।
4. OpenClaw को विन्यस्त करें और Gateway प्रारंभ करें।

न्यूनतम विन्यास:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## पर्यावरण चर (डिफ़ॉल्ट खाता)

यदि आप env vars पसंद करते हैं, तो इन्हें Gateway होस्ट पर सेट करें:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars apply only to the **default** account (`default`). Other accounts must use config values.

## चैट मोड

Mattermost responds to DMs automatically. Channel behavior is controlled by `chatmode`:

- `oncall` (डिफ़ॉल्ट): चैनलों में केवल @mention होने पर उत्तर दें।
- `onmessage`: हर चैनल संदेश का उत्तर दें।
- `onchar`: जब संदेश किसी ट्रिगर प्रीफ़िक्स से शुरू हो, तब उत्तर दें।

विन्यास उदाहरण:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

टिप्पणियाँ:

- `onchar` स्पष्ट @mentions पर अभी भी प्रतिक्रिया देता है।
- `channels.mattermost.requireMention` लेगेसी विन्यासों के लिए मान्य है, लेकिन `chatmode` को प्राथमिकता दी जाती है।

## प्रवेश नियंत्रण (DMs)

- डिफ़ॉल्ट: `channels.mattermost.dmPolicy = "pairing"` (अज्ञात प्रेषकों को एक पेयरिंग कोड मिलता है)।
- स्वीकृति दें:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- सार्वजनिक DMs: `channels.mattermost.dmPolicy="open"` के साथ `channels.mattermost.allowFrom=["*"]`।

## चैनल (समूह)

- डिफ़ॉल्ट: `channels.mattermost.groupPolicy = "allowlist"` (mention-आधारित)।
- `channels.mattermost.groupAllowFrom` के साथ प्रेषकों को allowlist करें (यूज़र IDs या `@username`)।
- खुले चैनल: `channels.mattermost.groupPolicy="open"` (mention-आधारित)।

## आउटबाउंड डिलीवरी के लिए लक्ष्य

`openclaw message send` या cron/webhooks के साथ इन लक्ष्य फ़ॉर्मैट्स का उपयोग करें:

- चैनल के लिए `channel:<id>`
- DM के लिए `user:<id>`
- DM के लिए `@username` (Mattermost API के माध्यम से रेज़ॉल्व किया गया)

केवल IDs को चैनल माना जाता है।

## मल्टी-अकाउंट

Mattermost `channels.mattermost.accounts` के अंतर्गत कई खातों का समर्थन करता है:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## समस्या-निवारण

- चैनलों में कोई उत्तर नहीं: सुनिश्चित करें कि बॉट चैनल में है और उसे mention करें (oncall), ट्रिगर प्रीफ़िक्स का उपयोग करें (onchar), या `chatmode: "onmessage"` सेट करें।
- प्रमाणीकरण त्रुटियाँ: बॉट टोकन, बेस URL, और खाते के सक्षम होने की जाँच करें।
- मल्टी-अकाउंट समस्याएँ: env vars केवल `default` खाते पर लागू होते हैं।
