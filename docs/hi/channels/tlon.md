---
summary: "Tlon/Urbit समर्थन की स्थिति, क्षमताएँ, और विन्यास"
read_when:
  - Tlon/Urbit चैनल सुविधाओं पर काम करते समय
title: "Tlon"
---

# Tlon (प्लगइन)

Tlon is a decentralized messenger built on Urbit. OpenClaw connects to your Urbit ship and can
respond to DMs and group chat messages. Group replies require an @ mention by default and can
be further restricted via allowlists.

Status: supported via plugin. DMs, group mentions, thread replies, and text-only media fallback
(URL appended to caption). Reactions, polls, and native media uploads are not supported.

## प्लगइन आवश्यक

Tlon एक प्लगइन के रूप में उपलब्ध है और कोर इंस्टॉल के साथ बंडल नहीं है।

CLI के माध्यम से इंस्टॉल करें (npm रजिस्ट्री):

```bash
openclaw plugins install @openclaw/tlon
```

स्थानीय चेकआउट (जब git रिपॉज़िटरी से चला रहे हों):

```bash
openclaw plugins install ./extensions/tlon
```

विवरण: [Plugins](/tools/plugin)

## सेटअप

1. Tlon प्लगइन इंस्टॉल करें।
2. अपना ship URL और लॉगिन कोड एकत्र करें।
3. `channels.tlon` को विन्यस्त करें।
4. Gateway को पुनः आरंभ करें।
5. बॉट को DM करें या किसी समूह चैनल में उसका उल्लेख करें।

न्यूनतम विन्यास (एकल खाता):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## समूह चैनल

Auto-discovery is enabled by default. You can also pin channels manually:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

स्वचालित डिस्कवरी अक्षम करें:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## प्रवेश नियंत्रण

DM allowlist (खाली = सभी को अनुमति):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

समूह प्राधिकरण (डिफ़ॉल्ट रूप से प्रतिबंधित):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## डिलीवरी लक्ष्य (CLI/cron)

इनका उपयोग `openclaw message send` या cron डिलीवरी के साथ करें:

- DM: `~sampel-palnet` या `dm/~sampel-palnet`
- समूह: `chat/~host-ship/channel` या `group:~host-ship/channel`

## टिप्पणियाँ

- Group replies require a mention (e.g. `~your-bot-ship`) to respond.
- थ्रेड उत्तर: यदि इनबाउंड संदेश किसी थ्रेड में है, तो OpenClaw उसी थ्रेड में उत्तर देता है।
- मीडिया: `sendMedia` पाठ + URL पर फ़ॉलबैक करता है (मूल अपलोड नहीं)।
