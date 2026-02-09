---
summary: "Twitch चैट बॉट का विन्यास और सेटअप"
read_when:
  - OpenClaw के लिए Twitch चैट एकीकरण सेट करते समय
title: "Twitch"
---

# Twitch (प्लगइन)

Twitch chat support via IRC connection. OpenClaw connects as a Twitch user (bot account) to receive and send messages in channels.

## आवश्यक प्लगइन

Twitch एक प्लगइन के रूप में उपलब्ध है और कोर इंस्टॉल के साथ बंडल नहीं होता।

CLI के माध्यम से इंस्टॉल करें (npm रजिस्ट्री):

```bash
openclaw plugins install @openclaw/twitch
```

लोकल चेकआउट (जब git repo से चलाया जा रहा हो):

```bash
openclaw plugins install ./extensions/twitch
```

विवरण: [Plugins](/tools/plugin)

## त्वरित सेटअप (शुरुआती)

1. बॉट के लिए एक समर्पित Twitch खाता बनाएँ (या किसी मौजूदा खाते का उपयोग करें)।
2. क्रेडेंशियल्स बनाएँ: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** चुनें
   - सुनिश्चित करें कि स्कोप्स `chat:read` और `chat:write` चुने गए हों
   - **Client ID** और **Access Token** कॉपी करें
3. अपना Twitch user ID खोजें: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. टोकन कॉन्फ़िगर करें:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (केवल डिफ़ॉल्ट खाते के लिए)
   - या config: `channels.twitch.accessToken`
   - यदि दोनों सेट हैं, तो config को प्राथमिकता मिलेगी (env फ़ॉलबैक केवल डिफ़ॉल्ट खाते के लिए है)।
5. Gateway शुरू करें।

**⚠️ Important:** Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot. `requireMention` defaults to `true`.

न्यूनतम config:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## यह क्या है

- Gateway के स्वामित्व वाला एक Twitch चैनल।
- निर्धारक रूटिंग: उत्तर हमेशा Twitch पर ही वापस जाते हैं।
- प्रत्येक खाता एक पृथक सत्र कुंजी `agent:<agentId>:twitch:<accountName>` से मैप होता है।
- `username` बॉट का खाता है (जो प्रमाणीकरण करता है), `channel` वह चैट रूम है जिसमें शामिल होना है।

## सेटअप (विस्तृत)

### क्रेडेंशियल्स बनाएँ

[Twitch Token Generator](https://twitchtokengenerator.com/) का उपयोग करें:

- **Bot Token** चुनें
- सुनिश्चित करें कि स्कोप्स `chat:read` और `chat:write` चुने गए हों
- **Client ID** और **Access Token** कॉपी करें

No manual app registration needed. Tokens expire after several hours.

### बॉट कॉन्फ़िगर करें

**Env var (केवल डिफ़ॉल्ट खाता):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**या config:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

यदि env और config दोनों सेट हैं, तो config को प्राथमिकता मिलेगी।

### एक्सेस कंट्रोल (अनुशंसित)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefer `allowFrom` for a hard allowlist. Use `allowedRoles` instead if you want role-based access.

**उपलब्ध भूमिकाएँ:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`।

**Why user IDs?** Usernames can change, allowing impersonation. User IDs are permanent.

अपना Twitch user ID खोजें: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (अपने Twitch उपयोगकर्ता नाम को ID में बदलें)

## टोकन रिफ़्रेश (वैकल्पिक)

[Twitch Token Generator](https://twitchtokengenerator.com/) से प्राप्त टोकन अपने आप रिफ़्रेश नहीं हो सकते — समाप्त होने पर पुनः जनरेट करें।

स्वचालित टोकन रिफ़्रेश के लिए, [Twitch Developer Console](https://dev.twitch.tv/console) पर अपना Twitch ऐप बनाएँ और config में जोड़ें:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

बॉट समाप्ति से पहले टोकन को स्वतः रिफ़्रेश करता है और रिफ़्रेश इवेंट्स को लॉग करता है।

## मल्टी-अकाउंट समर्थन

Use `channels.twitch.accounts` with per-account tokens. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

उदाहरण (एक बॉट खाता दो चैनलों में):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**टिप्पणी:** प्रत्येक खाते को अपना स्वयं का टोकन चाहिए (प्रति चैनल एक टोकन)।

## एक्सेस कंट्रोल

### भूमिका-आधारित प्रतिबंध

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### User ID द्वारा allowlist (सबसे सुरक्षित)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### भूमिका-आधारित एक्सेस (वैकल्पिक)

`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
If you want role-based access, leave `allowFrom` unset and configure `allowedRoles` instead:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### @mention आवश्यकता अक्षम करें

By default, `requireMention` is `true`. To disable and respond to all messages:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## समस्या-निवारण

सबसे पहले, डायग्नोस्टिक कमांड चलाएँ:

```bash
openclaw doctor
openclaw channels status --probe
```

### बॉट संदेशों का उत्तर नहीं देता

**एक्सेस कंट्रोल जाँचें:** सुनिश्चित करें कि आपका user ID `allowFrom` में है, या परीक्षण के लिए अस्थायी रूप से
`allowFrom` हटाएँ और `allowedRoles: ["all"]` सेट करें।

**जाँचें कि बॉट चैनल में है:** बॉट को `channel` में निर्दिष्ट चैनल में शामिल होना चाहिए।

### टोकन संबंधी समस्याएँ

**"Failed to connect" या प्रमाणीकरण त्रुटियाँ:**

- सत्यापित करें कि `accessToken` OAuth access token का मान है (आमतौर पर `oauth:` प्रीफ़िक्स से शुरू होता है)
- जाँचें कि टोकन में `chat:read` और `chat:write` स्कोप्स हैं
- यदि टोकन रिफ़्रेश का उपयोग कर रहे हैं, तो सुनिश्चित करें कि `clientSecret` और `refreshToken` सेट हैं

### टोकन रिफ़्रेश काम नहीं कर रहा

**रिफ़्रेश इवेंट्स के लिए लॉग्स जाँचें:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

यदि आपको "token refresh disabled (no refresh token)" दिखाई दे:

- सुनिश्चित करें कि `clientSecret` प्रदान किया गया है
- सुनिश्चित करें कि `refreshToken` प्रदान किया गया है

## Config

**खाता config:**

- `username` - बॉट उपयोगकर्ता नाम
- `accessToken` - OAuth access token जिसमें `chat:read` और `chat:write` शामिल हों
- `clientId` - Twitch Client ID (Token Generator या आपके ऐप से)
- `channel` - जॉइन करने के लिए चैनल (आवश्यक)
- `enabled` - इस खाते को सक्षम करें (डिफ़ॉल्ट: `true`)
- `clientSecret` - वैकल्पिक: स्वचालित टोकन रिफ़्रेश के लिए
- `refreshToken` - वैकल्पिक: स्वचालित टोकन रिफ़्रेश के लिए
- `expiresIn` - सेकंड में टोकन समाप्ति
- `obtainmentTimestamp` - टोकन प्राप्त करने का टाइमस्टैम्प
- `allowFrom` - User ID allowlist
- `allowedRoles` - भूमिका-आधारित एक्सेस कंट्रोल (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @mention आवश्यक (डिफ़ॉल्ट: `true`)

**प्रदाता विकल्प:**

- `channels.twitch.enabled` - चैनल स्टार्टअप सक्षम/अक्षम करें
- `channels.twitch.username` - बॉट उपयोगकर्ता नाम (सरलीकृत सिंगल-अकाउंट config)
- `channels.twitch.accessToken` - OAuth access token (सरलीकृत सिंगल-अकाउंट config)
- `channels.twitch.clientId` - Twitch Client ID (सरलीकृत सिंगल-अकाउंट config)
- `channels.twitch.channel` - जॉइन करने के लिए चैनल (सरलीकृत सिंगल-अकाउंट config)
- `channels.twitch.accounts.<accountName>` - Multi-account config (all account fields above)

पूर्ण उदाहरण:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## टूल क्रियाएँ

एजेंट `twitch` को निम्न action के साथ कॉल कर सकता है:

- `send` - किसी चैनल पर संदेश भेजें

उदाहरण:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## सुरक्षा और संचालन

- **टोकन को पासवर्ड की तरह मानें** — टोकन को कभी भी git में कमिट न करें
- **लंबे समय तक चलने वाले बॉट्स** के लिए **स्वचालित टोकन रिफ़्रेश** का उपयोग करें
- एक्सेस कंट्रोल के लिए उपयोगकर्ता नामों के बजाय **User ID allowlists** का उपयोग करें
- टोकन रिफ़्रेश इवेंट्स और कनेक्शन स्थिति के लिए **लॉग्स की निगरानी** करें
- **टोकन स्कोप्स को न्यूनतम रखें** — केवल `chat:read` और `chat:write` का अनुरोध करें
- **यदि अटके हों**: यह सुनिश्चित करने के बाद कि कोई अन्य प्रक्रिया सत्र की मालिक नहीं है, Gateway को पुनः प्रारंभ करें

## सीमाएँ

- प्रति संदेश **500 वर्ण** (शब्द सीमाओं पर स्वतः विभाजित)
- विभाजन से पहले Markdown हटा दिया जाता है
- कोई रेट लिमिटिंग नहीं (Twitch की अंतर्निहित रेट लिमिट्स का उपयोग करता है)
