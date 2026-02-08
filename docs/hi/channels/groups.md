---
summary: "विभिन्न प्लेटफ़ॉर्म्स (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams) पर समूह चैट का व्यवहार"
read_when:
  - समूह चैट व्यवहार या मेंशन गेटिंग बदलते समय
title: "समूह"
x-i18n:
  source_path: channels/groups.md
  source_hash: 5380e07ea01f4a8f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:10Z
---

# समूह

OpenClaw सभी प्लेटफ़ॉर्म्स पर समूह चैट को एक समान तरीके से संभालता है: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams।

## शुरुआती परिचय (2 मिनट)

OpenClaw आपके अपने मैसेजिंग अकाउंट्स पर ही “रहता” है। कोई अलग WhatsApp बॉट उपयोगकर्ता नहीं होता।
यदि **आप** किसी समूह में हैं, तो OpenClaw उस समूह को देख सकता है और वहीं उत्तर दे सकता है।

डिफ़ॉल्ट व्यवहार:

- समूह प्रतिबंधित होते हैं (`groupPolicy: "allowlist"`)।
- उत्तर देने के लिए मेंशन आवश्यक है, जब तक कि आप मेंशन गेटिंग को स्पष्ट रूप से अक्षम न करें।

अनुवाद: allowlist किए गए प्रेषक OpenClaw को मेंशन करके सक्रिय कर सकते हैं।

> TL;DR
>
> - **DM पहुँच** `*.allowFrom` द्वारा नियंत्रित होती है।
> - **समूह पहुँच** `*.groupPolicy` + allowlists (`*.groups`, `*.groupAllowFrom`) द्वारा नियंत्रित होती है।
> - **उत्तर ट्रिगर करना** मेंशन गेटिंग (`requireMention`, `/activation`) द्वारा नियंत्रित होता है।

त्वरित प्रवाह (किसी समूह संदेश के साथ क्या होता है):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

यदि आप चाहते हैं...

| लक्ष्य                                                      | क्या सेट करें                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| सभी समूहों को अनुमति दें, लेकिन केवल @mentions पर उत्तर दें | `groups: { "*": { requireMention: true } }`                |
| सभी समूह उत्तर अक्षम करें                                   | `groupPolicy: "disabled"`                                  |
| केवल विशिष्ट समूह                                           | `groups: { "<group-id>": { ... } }` (कोई `"*"` कुंजी नहीं) |
| समूहों में केवल आप ही ट्रिगर कर सकें                        | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## सत्र कुंजियाँ

- समूह सत्र `agent:<agentId>:<channel>:group:<id>` सत्र कुंजियों का उपयोग करते हैं (rooms/channels `agent:<agentId>:<channel>:channel:<id>` का उपयोग करते हैं)।
- Telegram फ़ोरम विषय समूह आईडी में `:topic:<threadId>` जोड़ते हैं ताकि प्रत्येक विषय का अपना सत्र हो।
- डायरेक्ट चैट मुख्य सत्र का उपयोग करती हैं (या यदि कॉन्फ़िगर किया गया हो तो प्रति-प्रेषक)।
- समूह सत्रों के लिए हार्टबीट्स छोड़े जाते हैं।

## पैटर्न: व्यक्तिगत DMs + सार्वजनिक समूह (एकल एजेंट)

हाँ — यदि आपका “व्यक्तिगत” ट्रैफ़िक **DMs** है और आपका “सार्वजनिक” ट्रैफ़िक **समूह** है, तो यह अच्छी तरह काम करता है।

क्यों: एकल-एजेंट मोड में, DMs आमतौर पर **मुख्य** सत्र कुंजी (`agent:main:main`) में जाते हैं, जबकि समूह हमेशा **ग़ैर-मुख्य** सत्र कुंजियों (`agent:main:<channel>:group:<id>`) का उपयोग करते हैं। यदि आप `mode: "non-main"` के साथ sandboxing सक्षम करते हैं, तो वे समूह सत्र Docker में चलते हैं जबकि आपका मुख्य DM सत्र होस्ट पर ही रहता है।

इससे आपको एक एजेंट “मस्तिष्क” (साझा कार्यक्षेत्र + मेमोरी) मिलता है, लेकिन दो निष्पादन स्थितियाँ:

- **DMs**: पूर्ण टूल्स (होस्ट)
- **समूह**: sandbox + प्रतिबंधित टूल्स (Docker)

> यदि आपको वास्तव में अलग कार्यक्षेत्र/पर्सोना चाहिए (“व्यक्तिगत” और “सार्वजनिक” कभी भी न मिलें), तो दूसरा एजेंट + बाइंडिंग्स उपयोग करें। देखें [Multi-Agent Routing](/concepts/multi-agent)।

उदाहरण (DMs होस्ट पर, समूह sandboxed + केवल मैसेजिंग टूल्स):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

“समूह केवल फ़ोल्डर X देख सकें” चाहते हैं, बजाय “कोई होस्ट एक्सेस नहीं”? `workspaceAccess: "none"` रखें और केवल allowlist किए गए पथों को sandbox में माउंट करें:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

संबंधित:

- कॉन्फ़िगरेशन कुंजियाँ और डिफ़ॉल्ट्स: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- यह डिबग करना कि कोई टूल क्यों ब्लॉक है: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Bind mounts विवरण: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## डिस्प्ले लेबल

- UI लेबल उपलब्ध होने पर `displayName` का उपयोग करते हैं, और `<channel>:<token>` के रूप में फ़ॉर्मैट होते हैं।
- `#room` rooms/channels के लिए आरक्षित है; समूह चैट `g-<slug>` का उपयोग करती हैं (लोअरकेस, स्पेस -> `-`, `#@+._-` बनाए रखें)।

## समूह नीति

प्रति चैनल यह नियंत्रित करें कि समूह/रूम संदेश कैसे संभाले जाएँ:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| नीति          | व्यवहार                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `"open"`      | समूह allowlists को बायपास करते हैं; मेंशन गेटिंग फिर भी लागू रहती है।     |
| `"disabled"`  | सभी समूह संदेश पूरी तरह ब्लॉक करें।                                       |
| `"allowlist"` | केवल वे समूह/रूम अनुमति दें जो कॉन्फ़िगर की गई allowlist से मेल खाते हों। |

नोट्स:

- `groupPolicy` मेंशन-गेटिंग से अलग है (जिसके लिए @mentions आवश्यक हैं)।
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` का उपयोग करें (फ़ॉलबैक: स्पष्ट `allowFrom`)।
- Discord: allowlist `channels.discord.guilds.<id>.channels` का उपयोग करती है।
- Slack: allowlist `channels.slack.channels` का उपयोग करती है।
- Matrix: allowlist `channels.matrix.groups` का उपयोग करती है (रूम IDs, एलियास, या नाम)। प्रेषकों को प्रतिबंधित करने के लिए `channels.matrix.groupAllowFrom` का उपयोग करें; प्रति-रूम `users` allowlists भी समर्थित हैं।
- Group DMs अलग से नियंत्रित होते हैं (`channels.discord.dm.*`, `channels.slack.dm.*`)।
- Telegram allowlist उपयोगकर्ता IDs (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) या उपयोगकर्ता नाम (`"@alice"` या `"alice"`) से मेल खा सकती है; प्रीफ़िक्स केस-इनसेंसिटिव होते हैं।
- डिफ़ॉल्ट `groupPolicy: "allowlist"` है; यदि आपकी समूह allowlist खाली है, तो समूह संदेश ब्लॉक हो जाते हैं।

त्वरित मानसिक मॉडल (समूह संदेशों के लिए मूल्यांकन क्रम):

1. `groupPolicy` (open/disabled/allowlist)
2. समूह allowlists (`*.groups`, `*.groupAllowFrom`, चैनल-विशिष्ट allowlist)
3. मेंशन गेटिंग (`requireMention`, `/activation`)

## मेंशन गेटिंग (डिफ़ॉल्ट)

समूह संदेशों के लिए मेंशन आवश्यक है, जब तक कि प्रति-समूह ओवरराइड न किया जाए। डिफ़ॉल्ट्स `*.groups."*"` के अंतर्गत प्रति सबसिस्टम रहते हैं।

किसी बॉट संदेश का उत्तर देना एक निहित मेंशन माना जाता है (जब चैनल reply मेटाडेटा का समर्थन करता है)। यह Telegram, WhatsApp, Slack, Discord, और Microsoft Teams पर लागू होता है।

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

नोट्स:

- `mentionPatterns` केस-इनसेंसिटिव regexes हैं।
- जिन प्लेटफ़ॉर्म्स पर स्पष्ट mentions उपलब्ध हैं, वे हमेशा पास होते हैं; पैटर्न केवल फ़ॉलबैक हैं।
- प्रति-एजेंट ओवरराइड: `agents.list[].groupChat.mentionPatterns` (जब कई एजेंट एक समूह साझा करते हों, तब उपयोगी)।
- मेंशन गेटिंग केवल तब लागू होती है जब मेंशन डिटेक्शन संभव हो (नेटिव mentions या `mentionPatterns` कॉन्फ़िगर हों)।
- Discord के डिफ़ॉल्ट्स `channels.discord.guilds."*"` में रहते हैं (प्रति guild/channel ओवरराइड योग्य)।
- समूह इतिहास संदर्भ सभी चैनलों में समान रूप से रैप किया जाता है और **केवल-पेंडिंग** होता है (मेंशन गेटिंग के कारण छोड़े गए संदेश); वैश्विक डिफ़ॉल्ट के लिए `messages.groupChat.historyLimit` और ओवरराइड्स के लिए `channels.<channel>.historyLimit` (या `channels.<channel>.accounts.*.historyLimit`) का उपयोग करें। अक्षम करने के लिए `0` सेट करें।

## समूह/चैनल टूल प्रतिबंध (वैकल्पिक)

कुछ चैनल कॉन्फ़िग्स किसी विशिष्ट समूह/रूम/चैनल **के अंदर** कौन से टूल उपलब्ध हों, यह सीमित करने का समर्थन करते हैं।

- `tools`: पूरे समूह के लिए टूल्स को allow/deny करें।
- `toolsBySender`: समूह के भीतर प्रति-प्रेषक ओवरराइड्स (कुंजियाँ प्रेषक IDs/उपयोगकर्ता नाम/ईमेल/फ़ोन नंबर होती हैं, चैनल पर निर्भर)। वाइल्डकार्ड के रूप में `"*"` का उपयोग करें।

समाधान क्रम (सबसे विशिष्ट को प्राथमिकता):

1. समूह/चैनल `toolsBySender` मैच
2. समूह/चैनल `tools`
3. डिफ़ॉल्ट (`"*"`) `toolsBySender` मैच
4. डिफ़ॉल्ट (`"*"`) `tools`

उदाहरण (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

नोट्स:

- समूह/चैनल टूल प्रतिबंध वैश्विक/एजेंट टूल नीति के अतिरिक्त लागू होते हैं (deny को प्राथमिकता मिलती है)।
- कुछ चैनल rooms/channels के लिए अलग नेस्टिंग का उपयोग करते हैं (जैसे, Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`)।

## समूह allowlists

जब `channels.whatsapp.groups`, `channels.telegram.groups`, या `channels.imessage.groups` कॉन्फ़िगर हो, तो ये कुंजियाँ समूह allowlist के रूप में कार्य करती हैं। सभी समूहों को अनुमति देने के लिए `"*"` का उपयोग करें, जबकि डिफ़ॉल्ट मेंशन व्यवहार सेट ही रहे।

सामान्य इरादे (कॉपी/पेस्ट):

1. सभी समूह उत्तर अक्षम करें

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. केवल विशिष्ट समूहों को अनुमति दें (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. सभी समूहों को अनुमति दें लेकिन मेंशन आवश्यक करें (स्पष्ट)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. समूहों में केवल मालिक ही ट्रिगर कर सके (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## सक्रियण (केवल मालिक)

समूह मालिक प्रति-समूह सक्रियण टॉगल कर सकते हैं:

- `/activation mention`
- `/activation always`

मालिक `channels.whatsapp.allowFrom` द्वारा निर्धारित होता है (या यदि सेट न हो तो बॉट का स्वयं का E.164)। कमांड को एक स्वतंत्र संदेश के रूप में भेजें। अन्य प्लेटफ़ॉर्म्स वर्तमान में `/activation` को अनदेखा करते हैं।

## संदर्भ फ़ील्ड्स

समूह इनबाउंड पेलोड्स सेट करते हैं:

- `ChatType=group`
- `GroupSubject` (यदि ज्ञात हो)
- `GroupMembers` (यदि ज्ञात हो)
- `WasMentioned` (मेंशन गेटिंग परिणाम)
- Telegram फ़ोरम विषयों में अतिरिक्त रूप से `MessageThreadId` और `IsForum` शामिल होते हैं।

एजेंट सिस्टम प्रॉम्प्ट में नए समूह सत्र के पहले टर्न पर एक समूह परिचय शामिल होता है। यह मॉडल को मानव की तरह उत्तर देने, Markdown तालिकाओं से बचने, और शाब्दिक `\n` अनुक्रम टाइप करने से बचने की याद दिलाता है।

## iMessage विशेषताएँ

- रूटिंग या allowlisting करते समय `chat_id:<id>` को प्राथमिकता दें।
- चैट्स सूचीबद्ध करें: `imsg chats --limit 20`।
- समूह उत्तर हमेशा उसी `chat_id` पर वापस जाते हैं।

## WhatsApp विशेषताएँ

WhatsApp-विशिष्ट व्यवहार (इतिहास इंजेक्शन, मेंशन हैंडलिंग विवरण) के लिए [Group messages](/channels/group-messages) देखें।
