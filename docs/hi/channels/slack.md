---
summary: "Socket या HTTP webhook मोड के लिए Slack सेटअप"
read_when: "Slack सेटअप करते समय या Slack socket/HTTP मोड का डिबग करते समय"
title: "Slack"
---

# Slack

## Socket मोड (डिफ़ॉल्ट)

### त्वरित सेटअप (शुरुआती)

1. एक Slack ऐप बनाएँ और **Socket Mode** सक्षम करें।
2. एक **App Token** (`xapp-...`) और **Bot Token** (`xoxb-...`) बनाएँ।
3. OpenClaw के लिए टोकन सेट करें और Gateway प्रारंभ करें।

न्यूनतम विन्यास:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### सेटअप

1. [https://api.slack.com/apps](https://api.slack.com/apps) पर एक Slack ऐप बनाएँ (From scratch)।
2. 8. **Socket Mode** → चालू करें। 9. फिर **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** पर जाएँ और `connections:write` स्कोप चुनें। 10. **App Token** (`xapp-...`) कॉपी करें।
3. 11. **OAuth & Permissions** → बॉट टोकन स्कोप्स जोड़ें (नीचे दिए गए मैनिफेस्ट का उपयोग करें)। 12. **Install to Workspace** पर क्लिक करें। 13. **Bot User OAuth Token** (`xoxb-...`) कॉपी करें।
4. 14. वैकल्पिक: **OAuth & Permissions** → **User Token Scopes** जोड़ें (नीचे दी गई केवल-पढ़ने योग्य सूची देखें)। 15. ऐप को पुनः इंस्टॉल करें और **User OAuth Token** (`xoxp-...`) कॉपी करें।
5. **Event Subscriptions** → events सक्षम करें और निम्न पर सब्सक्राइब करें:
   - `message.*` (संपादन/हटाने/थ्रेड ब्रॉडकास्ट शामिल)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. जिन चैनलों को आप पढ़वाना चाहते हैं, उनमें बॉट को आमंत्रित करें।
7. 16. Slash Commands → यदि आप `channels.slack.slashCommand` का उपयोग करते हैं तो `/openclaw` बनाएँ। 17. यदि आप नेटिव कमांड सक्षम करते हैं, तो प्रत्येक बिल्ट-इन कमांड के लिए एक स्लैश कमांड जोड़ें ( `/help` जैसे ही नाम)। 18. Slack के लिए नेटिव डिफ़ॉल्ट रूप से बंद रहता है जब तक आप `channels.slack.commands.native: true` सेट न करें (ग्लोबल `commands.native` `"auto"` है, जो Slack को बंद ही रहने देता है)।
8. App Home → **Messages Tab** सक्षम करें ताकि उपयोगकर्ता बॉट को DM कर सकें।

स्कोप और events को सिंक में रखने के लिए नीचे दिया गया manifest उपयोग करें।

मल्टी-अकाउंट समर्थन: प्रति-अकाउंट टोकन और वैकल्पिक `name` के साथ `channels.slack.accounts` का उपयोग करें। 19. साझा पैटर्न के लिए [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) देखें।

### OpenClaw विन्यास (Socket मोड)

env vars के माध्यम से टोकन सेट करें (अनुशंसित):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

या विन्यास के माध्यम से:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### User token (वैकल्पिक)

20. OpenClaw पढ़ने के कार्यों (इतिहास, पिन्स, रिएक्शन्स, इमोजी, सदस्य जानकारी) के लिए Slack यूज़र टोकन (`xoxp-...`) का उपयोग कर सकता है। 21. डिफ़ॉल्ट रूप से यह केवल-पढ़ने योग्य रहता है: पढ़ने के लिए, उपलब्ध होने पर यूज़र टोकन को प्राथमिकता दी जाती है, और लिखने के लिए तब तक बॉट टोकन का उपयोग होता है जब तक आप स्पष्ट रूप से ऑप्ट-इन न करें। 22. `userTokenReadOnly: false` होने पर भी, लिखने के लिए उपलब्ध होने पर बॉट टोकन को ही प्राथमिकता दी जाती है।

23. यूज़र टोकन कॉन्फ़िग फ़ाइल में कॉन्फ़िगर किए जाते हैं (env var सपोर्ट नहीं)। For
    multi-account, set `channels.slack.accounts.<id>25. .userToken` सेट करें।

bot + app + user tokens के साथ उदाहरण:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

userTokenReadOnly को स्पष्ट रूप से सेट करने का उदाहरण (user token writes की अनुमति):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### टोकन उपयोग

- पढ़ने के कार्य (history, reactions list, pins list, emoji list, member info,
  search) कॉन्फ़िगर होने पर user token को प्राथमिकता देते हैं, अन्यथा bot token।
- 26. लिखने के कार्य (मैसेज भेजना/संपादित/हटाना, रिएक्शन जोड़ना/हटाना, पिन/अनपिन, फ़ाइल अपलोड) डिफ़ॉल्ट रूप से बॉट टोकन का उपयोग करते हैं। 27. यदि `userTokenReadOnly: false` है और कोई बॉट टोकन उपलब्ध नहीं है, तो OpenClaw यूज़र टोकन पर फ़ॉलबैक करता है।

### History संदर्भ

- `channels.slack.historyLimit` (या `channels.slack.accounts.*.historyLimit`) यह नियंत्रित करता है कि कितने हालिया चैनल/ग्रुप संदेश prompt में जोड़े जाएँ।
- 28. `messages.groupChat.historyLimit` पर फ़ॉलबैक करता है। 29. अक्षम करने के लिए `0` सेट करें (डिफ़ॉल्ट 50)।

## HTTP मोड (Events API)

30. जब आपका Gateway HTTPS के माध्यम से Slack द्वारा पहुँचा जा सकता हो (आमतौर पर सर्वर डिप्लॉयमेंट्स के लिए) तब HTTP webhook मोड का उपयोग करें।
31. HTTP मोड साझा रिक्वेस्ट URL के साथ Events API + Interactivity + Slash Commands का उपयोग करता है।

### सेटअप (HTTP मोड)

1. एक Slack ऐप बनाएँ और **Socket Mode** अक्षम करें (यदि आप केवल HTTP का उपयोग करते हैं तो वैकल्पिक)।
2. **Basic Information** → **Signing Secret** कॉपी करें।
3. **OAuth & Permissions** → ऐप इंस्टॉल करें और **Bot User OAuth Token** (`xoxb-...`) कॉपी करें।
4. **Event Subscriptions** → events सक्षम करें और **Request URL** को अपने gateway webhook पाथ पर सेट करें (डिफ़ॉल्ट `/slack/events`)।
5. **Interactivity & Shortcuts** → सक्षम करें और वही **Request URL** सेट करें।
6. **Slash Commands** → अपने कमांड(स) के लिए वही **Request URL** सेट करें।

उदाहरण request URL:
`https://gateway-host/slack/events`

### OpenClaw विन्यास (न्यूनतम)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

32. मल्टी-अकाउंट HTTP मोड: `channels.slack.accounts.<id>33. .mode = "http"` सेट करें और प्रत्येक अकाउंट के लिए एक यूनिक `webhookPath` प्रदान करें ताकि हर Slack ऐप अपनी अलग URL पर पॉइंट कर सके।

### Manifest (वैकल्पिक)

34. ऐप को जल्दी बनाने के लिए इस Slack ऐप मैनिफेस्ट का उपयोग करें (यदि चाहें तो नाम/कमांड समायोजित करें)। 35. यदि आप यूज़र टोकन कॉन्फ़िगर करने की योजना बना रहे हैं तो यूज़र स्कोप्स शामिल करें।

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

36. यदि आप नेटिव कमांड सक्षम करते हैं, तो जिन कमांड्स को एक्सपोज़ करना चाहते हैं उनके लिए एक-एक `slash_commands` एंट्री जोड़ें ( `/help` सूची से मेल खाते हुए)। 37. `channels.slack.commands.native` के साथ ओवरराइड करें।

## Scopes (वर्तमान बनाम वैकल्पिक)

38. Slack का Conversations API टाइप-स्कोप्ड है: आपको केवल उन्हीं कन्वर्सेशन टाइप्स के लिए स्कोप्स चाहिए जिन्हें आप वास्तव में उपयोग करते हैं (channels, groups, im, mpim)। 39. अवलोकन के लिए [https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) देखें।

### Bot token scopes (आवश्यक)

- `chat:write` (`chat.postMessage` के माध्यम से संदेश भेजना/अपडेट/हटाना)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (user DMs के लिए `conversations.open` के माध्यम से DMs खोलना)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (user lookup)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (`files.uploadV2` के माध्यम से अपलोड)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User token scopes (वैकल्पिक, डिफ़ॉल्ट रूप से read-only)

यदि आप `channels.slack.userToken` कॉन्फ़िगर करते हैं, तो इन्हें **User Token Scopes** के अंतर्गत जोड़ें।

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### आज आवश्यक नहीं (लेकिन भविष्य में संभव)

- `mpim:write` (केवल यदि हम `conversations.open` के माध्यम से group-DM open/DM start जोड़ते हैं)
- `groups:write` (केवल यदि हम private-channel प्रबंधन जोड़ते हैं: create/rename/invite/archive)
- `chat:write.public` (केवल यदि हम उन चैनलों में पोस्ट करना चाहते हैं जिनमें बॉट नहीं है)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (केवल यदि हमें `users.info` से email फ़ील्ड चाहिए)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (केवल यदि हम फ़ाइल मेटाडेटा सूचीबद्ध/पढ़ना शुरू करते हैं)

## Config

40. Slack केवल Socket Mode का उपयोग करता है (कोई HTTP webhook सर्वर नहीं)। 41. दोनों टोकन प्रदान करें:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

टोकन env vars के माध्यम से भी दिए जा सकते हैं:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

42. Ack रिएक्शन्स को वैश्विक रूप से `messages.ackReaction` + `messages.ackReactionScope` के माध्यम से नियंत्रित किया जाता है। 43. बॉट के उत्तर देने के बाद ack रिएक्शन हटाने के लिए `messages.removeAckAfterReply` का उपयोग करें।

## Limits

- आउटबाउंड टेक्स्ट को `channels.slack.textChunkLimit` तक chunk किया जाता है (डिफ़ॉल्ट 4000)।
- वैकल्पिक newline chunking: लंबाई के अनुसार chunking से पहले खाली पंक्तियों (paragraph boundaries) पर विभाजित करने के लिए `channels.slack.chunkMode="newline"` सेट करें।
- मीडिया अपलोड `channels.slack.mediaMaxMb` द्वारा सीमित हैं (डिफ़ॉल्ट 20)।

## Reply threading

44. डिफ़ॉल्ट रूप से, OpenClaw मुख्य चैनल में उत्तर देता है। 45. स्वचालित थ्रेडिंग को नियंत्रित करने के लिए `channels.slack.replyToMode` का उपयोग करें:

| Mode    | Behavior                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | 46. **डिफ़ॉल्ट।** मुख्य चैनल में उत्तर दें। 47. केवल तब थ्रेड करें जब ट्रिगर करने वाला संदेश पहले से थ्रेड में हो।                                                                     |
| `first` | 48. पहला उत्तर थ्रेड में जाता है (ट्रिगर संदेश के नीचे), बाद के उत्तर मुख्य चैनल में जाते हैं। 49. थ्रेड की भीड़ से बचते हुए संदर्भ को दृश्यमान रखने के लिए उपयोगी। |
| `all`   | 50. सभी उत्तर थ्रेड में जाते हैं। बातचीत को सीमित रखता है, लेकिन दृश्यता कम कर सकता है।                                                                                                                |

यह मोड auto-replies और agent tool calls (`slack sendMessage`) दोनों पर लागू होता है।

### प्रति-चैट-प्रकार threading

आप `channels.slack.replyToModeByChatType` सेट करके प्रति चैट प्रकार अलग-अलग threading व्यवहार कॉन्फ़िगर कर सकते हैं:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

समर्थित चैट प्रकार:

- `direct`: 1:1 DMs (Slack `im`)
- `group`: group DMs / MPIMs (Slack `mpim`)
- `channel`: मानक चैनल (public/private)

प्राथमिकता क्रम:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. प्रदाता डिफ़ॉल्ट (`off`)

Legacy `channels.slack.dm.replyToMode` अब भी `direct` के लिए फ़ॉलबैक के रूप में स्वीकार किया जाता है जब कोई chat-type override सेट न हो।

उदाहरण:

केवल DMs को thread करें:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Group DMs को thread करें लेकिन चैनलों को root में रखें:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

चैनलों को thread करें, DMs को root में रखें:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Manual threading tags

सूक्ष्म नियंत्रण के लिए, agent responses में इन टैग्स का उपयोग करें:

- `[[reply_to_current]]` — ट्रिगर करने वाले संदेश का उत्तर दें (thread शुरू/जारी रखें)।
- `[[reply_to:<id>]]` — किसी विशिष्ट message id का उत्तर दें।

## Sessions + routing

- DMs `main` सत्र साझा करते हैं (WhatsApp/Telegram की तरह)।
- चैनल `agent:<agentId>:slack:channel:<channelId>` सत्रों से मैप होते हैं।
- Slash commands `agent:<agentId>:slack:slash:<userId>` सत्रों का उपयोग करते हैं (prefix `channels.slack.slashCommand.sessionPrefix` के माध्यम से कॉन्फ़िगर करने योग्य)।
- यदि Slack `channel_type` प्रदान नहीं करता, तो OpenClaw इसे channel ID prefix (`D`, `C`, `G`) से अनुमानित करता है और सत्र कुंजियों को स्थिर रखने के लिए डिफ़ॉल्ट रूप से `channel` का उपयोग करता है।
- नेटिव कमांड रजिस्ट्रेशन `commands.native` (ग्लोबल डिफ़ॉल्ट `"auto"` → Slack बंद) का उपयोग करता है और इसे प्रति-वर्कस्पेस `channels.slack.commands.native` के साथ ओवरराइड किया जा सकता है। टेक्स्ट कमांड के लिए अलग `/...` संदेशों की आवश्यकता होती है और इन्हें `commands.text: false` के साथ अक्षम किया जा सकता है। Slack स्लैश कमांड Slack ऐप में प्रबंधित होते हैं और अपने आप नहीं हटाए जाते। कमांड के लिए एक्सेस-ग्रुप जाँच को बायपास करने हेतु `commands.useAccessGroups: false` का उपयोग करें।
- पूर्ण कमांड सूची + विन्यास: [Slash commands](/tools/slash-commands)

## DM सुरक्षा (pairing)

- डिफ़ॉल्ट: `channels.slack.dm.policy="pairing"` — अज्ञात DM प्रेषकों को एक pairing कोड मिलता है (1 घंटे बाद समाप्त)।
- स्वीकृति: `openclaw pairing approve slack <code>` के माध्यम से।
- सभी को अनुमति देने के लिए: `channels.slack.dm.policy="open"` और `channels.slack.dm.allowFrom=["*"]` सेट करें।
- `channels.slack.dm.allowFrom` यूज़र IDs, @handles, या ईमेल स्वीकार करता है (जब टोकन अनुमति दें तो स्टार्टअप पर रेज़ॉल्व किए जाते हैं)। विज़ार्ड यूज़रनेम स्वीकार करता है और सेटअप के दौरान उन्हें ids में रेज़ॉल्व करता है, जब टोकन अनुमति दें।

## Group नीति

- `channels.slack.groupPolicy` चैनल हैंडलिंग को नियंत्रित करता है (`open|disabled|allowlist`)।
- `allowlist` के लिए चैनलों का `channels.slack.channels` में सूचीबद्ध होना आवश्यक है।
- यदि आप केवल `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` सेट करते हैं और कभी `channels.slack` सेक्शन नहीं बनाते, तो रनटाइम डिफ़ॉल्ट रूप से `groupPolicy` को `open` पर सेट करता है। इसे लॉक डाउन करने के लिए `channels.slack.groupPolicy`, `channels.defaults.groupPolicy`, या एक चैनल allowlist जोड़ें।
- कॉन्फ़िगर विज़ार्ड `#channel` नाम स्वीकार करता है और जहाँ संभव हो IDs में resolve करता है
  (public + private); यदि कई मैच हों, तो सक्रिय चैनल को प्राथमिकता देता है।
- startup पर, OpenClaw allowlists में channel/user नामों को IDs में resolve करता है (जब टोकन अनुमति दें)
  और मैपिंग लॉग करता है; अनरिज़ॉल्व्ड एंट्रीज़ को यथावत रखा जाता है।
- **कोई चैनल अनुमति न देने** के लिए, `channels.slack.groupPolicy: "disabled"` सेट करें (या खाली allowlist रखें)।

चैनल विकल्प (`channels.slack.channels.<id>` या `channels.slack.channels.<name>`):

- `allow`: जब `groupPolicy="allowlist"` हो, चैनल को allow/deny करें।
- `requireMention`: चैनल के लिए mention gating।
- `tools`: वैकल्पिक प्रति-चैनल tool नीति overrides (`allow`/`deny`/`alsoAllow`)।
- `toolsBySender`: चैनल के भीतर वैकल्पिक प्रति-प्रेषक tool नीति overrides (keys sender ids/@handles/emails; `"*"` wildcard समर्थित)।
- `allowBots`: इस चैनल में बॉट-लिखित संदेशों की अनुमति दें (डिफ़ॉल्ट: false)।
- `users`: वैकल्पिक प्रति-चैनल user allowlist।
- `skills`: skill फ़िल्टर (omit = सभी skills, empty = कोई नहीं)।
- `systemPrompt`: चैनल के लिए अतिरिक्त system prompt (topic/purpose के साथ संयोजित)।
- `enabled`: चैनल अक्षम करने के लिए `false` सेट करें।

## Delivery targets

cron/CLI sends के साथ इनका उपयोग करें:

- DMs के लिए `user:<id>`
- चैनलों के लिए `channel:<id>`

## Tool actions

Slack tool actions को `channels.slack.actions.*` के साथ gated किया जा सकता है:

| Action group | Default | Notes                     |
| ------------ | ------- | ------------------------- |
| reactions    | enabled | React + reactions सूची    |
| messages     | enabled | पढ़ना/भेजना/संपादित/हटाना |
| pins         | enabled | Pin/unpin/सूची            |
| memberInfo   | enabled | सदस्य जानकारी             |
| emojiList    | enabled | कस्टम emoji सूची          |

## सुरक्षा नोट्स

- लिखने के कार्य डिफ़ॉल्ट रूप से bot token का उपयोग करते हैं ताकि state-changing क्रियाएँ
  ऐप के बॉट अनुमतियों और पहचान तक सीमित रहें।
- `userTokenReadOnly: false` सेट करने से, जब बॉट टोकन उपलब्ध न हो, तो यूज़र टोकन को लिखने (write) के ऑपरेशनों के लिए उपयोग किया जा सकता है, जिसका मतलब है कि कार्रवाइयाँ इंस्टॉल करने वाले यूज़र की एक्सेस के साथ चलती हैं। यूज़र टोकन को अत्यधिक विशेषाधिकार प्राप्त मानें और एक्शन गेट्स व allowlists को कड़ा रखें।
- यदि आप user-token writes सक्षम करते हैं, तो सुनिश्चित करें कि user token में अपेक्षित
  write scopes शामिल हों (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`), अन्यथा वे ऑपरेशन विफल हो जाएँगे।

## समस्या-निवारण

पहले यह ladder चलाएँ:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

फिर आवश्यकता होने पर DM pairing स्थिति की पुष्टि करें:

```bash
openclaw pairing list slack
```

सामान्य विफलताएँ:

- Connected है लेकिन चैनल में उत्तर नहीं: चैनल `groupPolicy` द्वारा ब्लॉक है या `channels.slack.channels` allowlist में नहीं है।
- DMs अनदेखी: जब `channels.slack.dm.policy="pairing"` हो, प्रेषक अनुमोदित नहीं है।
- API त्रुटियाँ (`missing_scope`, `not_in_channel`, auth विफलताएँ): bot/app tokens या Slack scopes अपूर्ण हैं।

triage flow के लिए: [/channels/troubleshooting](/channels/troubleshooting)।

## Notes

- Mention gating `channels.slack.channels` के माध्यम से नियंत्रित होती है (`requireMention` को `true` पर सेट करें); `agents.list[].groupChat.mentionPatterns` (या `messages.groupChat.mentionPatterns`) भी mentions माने जाते हैं।
- Multi-agent override: प्रति-एजेंट पैटर्न `agents.list[].groupChat.mentionPatterns` पर सेट करें।
- Reaction notifications `channels.slack.reactionNotifications` का पालन करती हैं (`reactionAllowlist` को मोड `allowlist` के साथ उपयोग करें)।
- बॉट द्वारा लिखे गए संदेश डिफ़ॉल्ट रूप से अनदेखा किए जाते हैं; `channels.slack.allowBots` या `channels.slack.channels.<id>.allowBots` के माध्यम से सक्षम करें।
- चेतावनी: यदि आप अन्य बॉट्स को जवाब देने की अनुमति देते हैं (`channels.slack.allowBots=true` या `channels.slack.channels.<id>.allowBots=true`), तो `requireMention`, `channels.slack.channels.<id>.users` allowlists, और/या `AGENTS.md` और `SOUL.md` में स्पष्ट गार्डरेल्स के साथ बॉट-टू-बॉट रिप्लाई लूप्स को रोकें।
- Slack टूल के लिए, reaction removal semantics [/tools/reactions](/tools/reactions) में हैं।
- संलग्नक (attachments) अनुमति होने पर और आकार सीमा के भीतर होने पर media store में डाउनलोड किए जाते हैं।
