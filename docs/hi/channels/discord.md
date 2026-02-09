---
summary: "Discord बॉट समर्थन स्थिति, क्षमताएँ और विन्यास"
read_when:
  - Discord चैनल सुविधाओं पर काम करते समय
title: "Discord"
---

# Discord (Bot API)

स्थिति: आधिकारिक Discord बॉट गेटवे के माध्यम से DM और guild टेक्स्ट चैनलों के लिए तैयार।

## त्वरित सेटअप (शुरुआती)

1. एक Discord बॉट बनाएँ और बॉट टोकन कॉपी करें।
2. Discord ऐप सेटिंग्स में **Message Content Intent** सक्षम करें (और यदि आप allowlist या नाम लुकअप का उपयोग करने की योजना बनाते हैं तो **Server Members Intent** भी)।
3. OpenClaw के लिए टोकन सेट करें:
   - Env: `DISCORD_BOT_TOKEN=...`
   - या config: `channels.discord.token: "..."`।
   - यदि दोनों सेट हैं, तो config को प्राथमिकता मिलती है (env fallback केवल default-account के लिए है)।
4. संदेश अनुमतियों के साथ बॉट को अपने सर्वर में आमंत्रित करें (यदि आपको केवल DMs चाहिए तो एक निजी सर्वर बनाएँ)।
5. Gateway शुरू करें।
6. DM एक्सेस डिफ़ॉल्ट रूप से pairing है; पहले संपर्क पर pairing कोड को अनुमोदित करें।

न्यूनतम config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## लक्ष्य

- Discord DMs या guild चैनलों के माध्यम से OpenClaw से बात करना।
- डायरेक्ट चैट्स एजेंट के मुख्य सत्र में विलय हो जाती हैं (डिफ़ॉल्ट `agent:main:main`); guild चैनल `agent:<agentId>:discord:channel:<channelId>` के रूप में अलग रहते हैं (डिस्प्ले नाम `discord:<guildSlug>#<channelSlug>` का उपयोग करते हैं)।
- Group DMs डिफ़ॉल्ट रूप से अनदेखी की जाती हैं; `channels.discord.dm.groupEnabled` के माध्यम से सक्षम करें और वैकल्पिक रूप से `channels.discord.dm.groupChannels` द्वारा सीमित करें।
- रूटिंग को निर्धारक रखें: उत्तर हमेशा उसी चैनल पर लौटते हैं जहाँ से वे आए थे।

## यह कैसे काम करता है

1. एक Discord एप्लिकेशन → Bot बनाएँ, आवश्यक intents (DMs + guild संदेश + message content) सक्षम करें, और बॉट टोकन प्राप्त करें।
2. जहाँ आप इसका उपयोग करना चाहते हैं वहाँ संदेश पढ़ने/भेजने की आवश्यक अनुमतियों के साथ बॉट को अपने सर्वर में आमंत्रित करें।
3. OpenClaw को `channels.discord.token` के साथ कॉन्फ़िगर करें (या fallback के रूप में `DISCORD_BOT_TOKEN`)।
4. Gateway चलाएँ; जब टोकन उपलब्ध होता है (पहले config, env fallback) और `channels.discord.enabled` `false` नहीं होता, तो यह Discord चैनल को स्वतः शुरू कर देता है।
   - यदि आप env vars पसंद करते हैं, तो `DISCORD_BOT_TOKEN` सेट करें (config ब्लॉक वैकल्पिक है)।
5. डायरेक्ट चैट्स: डिलीवरी के समय `user:<id>` (या `<@id>` mention) का उपयोग करें; सभी टर्न साझा `main` सेशन में जाते हैं। केवल संख्यात्मक IDs अस्पष्ट होते हैं और अस्वीकृत कर दिए जाते हैं।
6. गिल्ड चैनल्स: डिलीवरी के लिए `channel:<channelId>` का उपयोग करें। डिफ़ॉल्ट रूप से mentions आवश्यक होते हैं और इन्हें प्रति गिल्ड या प्रति चैनल सेट किया जा सकता है।
7. डायरेक्ट चैट्स: `channels.discord.dm.policy` के माध्यम से डिफ़ॉल्ट रूप से सुरक्षित (डिफ़ॉल्ट: `"pairing"`)। अज्ञात प्रेषकों को एक pairing कोड मिलता है (1 घंटे बाद समाप्त); `openclaw pairing approve discord <code>` के माध्यम से अनुमोदित करें।
   - पुराने “किसी के लिए भी खुला” व्यवहार को बनाए रखने के लिए: `channels.discord.dm.policy="open"` और `channels.discord.dm.allowFrom=["*"]` सेट करें।
   - हार्ड allowlist के लिए: `channels.discord.dm.policy="allowlist"` सेट करें और `channels.discord.dm.allowFrom` में प्रेषकों की सूची दें।
   - सभी DMs को अनदेखा करने के लिए: `channels.discord.dm.enabled=false` या `channels.discord.dm.policy="disabled"` सेट करें।
8. Group DMs डिफ़ॉल्ट रूप से अनदेखी की जाती हैं; `channels.discord.dm.groupEnabled` के माध्यम से सक्षम करें और वैकल्पिक रूप से `channels.discord.dm.groupChannels` द्वारा सीमित करें।
9. वैकल्पिक guild नियम: `channels.discord.guilds` को guild id (पसंदीदा) या slug द्वारा कुंजीबद्ध सेट करें, प्रति-चैनल नियमों के साथ।
10. वैकल्पिक नेटिव कमांड्स: `commands.native` का डिफ़ॉल्ट `"auto"` है (Discord/Telegram के लिए चालू, Slack के लिए बंद)। `channels.discord.commands.native: true|false|"auto"` से ओवरराइड करें; `false` पहले से पंजीकृत कमांड्स को साफ़ कर देता है। टेक्स्ट कमांड्स `commands.text` द्वारा नियंत्रित होते हैं और इन्हें स्वतंत्र `/...` संदेशों के रूप में भेजना आवश्यक है। कमांड्स के लिए access‑group जाँच को बायपास करने हेतु `commands.useAccessGroups: false` का उपयोग करें।
    - पूर्ण command सूची + config: [Slash commands](/tools/slash-commands)
11. वैकल्पिक गिल्ड संदर्भ इतिहास: mention के उत्तर देते समय संदर्भ के रूप में पिछले N गिल्ड संदेश शामिल करने के लिए `channels.discord.historyLimit` (डिफ़ॉल्ट 20, `messages.groupChat.historyLimit` पर फ़ॉलबैक) सेट करें। अक्षम करने के लिए `0` सेट करें।
12. Reactions: एजेंट `discord` टूल के माध्यम से reactions ट्रिगर कर सकता है (`channels.discord.actions.*` द्वारा gated)।
    - Reaction removal semantics: [/tools/reactions](/tools/reactions) देखें।
    - `discord` टूल केवल तब उपलब्ध होता है जब वर्तमान चैनल Discord हो।
13. Native commands साझा `main` सत्र के बजाय पृथक सत्र कुंजियाँ (`agent:<agentId>:discord:slash:<userId>`) उपयोग करते हैं।

नोट: नाम → id रिज़ॉल्यूशन गिल्ड सदस्य खोज का उपयोग करता है और Server Members Intent की आवश्यकता होती है; यदि बॉट सदस्य खोज नहीं कर सकता, तो ids या `<@id>` mentions का उपयोग करें।
नोट: स्लग्स लोअरकेस होते हैं और स्पेस को `-` से बदला जाता है। चैनल नामों को अग्रणी `#` के बिना स्लग किया जाता है।
नोट: गिल्ड संदर्भ `[from:]` पंक्तियों में ping‑ready उत्तरों को आसान बनाने के लिए `author.tag` + `id` शामिल होता है।

## Config writes

डिफ़ॉल्ट रूप से, Discord को `/config set|unset` द्वारा ट्रिगर किए गए config अपडेट लिखने की अनुमति है (इसके लिए `commands.config: true` आवश्यक है)।

अक्षम करने के लिए:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## अपना स्वयं का बॉट कैसे बनाएँ

यह सर्वर (guild) चैनल जैसे `#help` में OpenClaw चलाने के लिए “Discord Developer Portal” सेटअप है।

### 1. Discord ऐप + बॉट उपयोगकर्ता बनाएँ

1. Discord Developer Portal → **Applications** → **New Application**
2. अपने ऐप में:
   - **Bot** → **Add Bot**
   - **Bot Token** कॉपी करें (यही `DISCORD_BOT_TOKEN` में डालते हैं)

### 2) OpenClaw को जिन gateway intents की आवश्यकता है, उन्हें सक्षम करें

Discord “privileged intents” को तब तक ब्लॉक करता है जब तक आप उन्हें स्पष्ट रूप से सक्षम न करें।

**Bot** → **Privileged Gateway Intents** में सक्षम करें:

- **Message Content Intent** (अधिकांश guilds में संदेश पाठ पढ़ने के लिए आवश्यक; इसके बिना आपको “Used disallowed intents” दिखेगा या बॉट कनेक्ट होगा लेकिन संदेशों पर प्रतिक्रिया नहीं देगा)
- **Server Members Intent** (अनुशंसित; कुछ सदस्य/उपयोगकर्ता लुकअप और guilds में allowlist मिलान के लिए आवश्यक)

आमतौर पर आपको **Presence Intent** की आवश्यकता **नहीं** होती। बॉट की अपनी उपस्थिति सेट करना (`setPresence` एक्शन) gateway OP3 का उपयोग करता है और इस intent की आवश्यकता नहीं होती; यह केवल तब आवश्यक है जब आप अन्य गिल्ड सदस्यों के presence अपडेट प्राप्त करना चाहते हैं।

### 3. Invite URL बनाएँ (OAuth2 URL Generator)

अपने ऐप में: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (native commands के लिए आवश्यक)

**Bot Permissions** (न्यूनतम आधार)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (वैकल्पिक लेकिन अनुशंसित)
- ✅ Use External Emojis / Stickers (वैकल्पिक; केवल यदि आप इन्हें चाहते हैं)

डिबगिंग के अलावा **Administrator** से बचें और केवल तभी उपयोग करें जब आप बॉट पर पूर्ण विश्वास करते हों।

जनरेट किया गया URL कॉपी करें, उसे खोलें, अपना सर्वर चुनें और बॉट इंस्टॉल करें।

### 4. ids प्राप्त करें (guild/user/channel)

Discord हर जगह संख्यात्मक ids का उपयोग करता है; OpenClaw config ids को प्राथमिकता देता है।

1. Discord (डेस्कटॉप/वेब) → **User Settings** → **Advanced** → **Developer Mode** सक्षम करें
2. राइट-क्लिक:
   - सर्वर नाम → **Copy Server ID** (guild id)
   - चैनल (जैसे `#help`) → **Copy Channel ID**
   - आपका उपयोगकर्ता → **Copy User ID**

### 5) OpenClaw कॉन्फ़िगर करें

#### Token

env var के माध्यम से बॉट टोकन सेट करें (सर्वरों पर अनुशंसित):

- `DISCORD_BOT_TOKEN=...`

या config के माध्यम से:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

मल्टी-अकाउंट समर्थन: प्रति-अकाउंट टोकन और वैकल्पिक `name` के साथ `channels.discord.accounts` का उपयोग करें। [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) में साझा पैटर्न देखें।

#### Allowlist + चैनल रूटिंग

उदाहरण “एकल सर्वर, केवल मुझे अनुमति, केवल #help की अनुमति”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

नोट्स:

- `requireMention: true` का अर्थ है कि बॉट केवल mention होने पर उत्तर देता है (साझा चैनलों के लिए अनुशंसित)।
- `agents.list[].groupChat.mentionPatterns` (या `messages.groupChat.mentionPatterns`) guild संदेशों के लिए mentions के रूप में भी गिने जाते हैं।
- मल्टी-एजेंट ओवरराइड: `agents.list[].groupChat.mentionPatterns` पर प्रति-एजेंट पैटर्न सेट करें।
- यदि `channels` मौजूद है, तो सूचीबद्ध न किए गए किसी भी चैनल को डिफ़ॉल्ट रूप से अस्वीकार किया जाता है।
- सभी चैनलों में डिफ़ॉल्ट लागू करने के लिए `"*"` चैनल एंट्री का उपयोग करें; स्पष्ट चैनल एंट्रीज़ wildcard को ओवरराइड करती हैं।
- थ्रेड्स पैरेंट चैनल कॉन्फ़िगरेशन (allowlist, `requireMention`, skills, prompts, आदि) को इनहेरिट करते हैं जब तक आप थ्रेड चैनल id को स्पष्ट रूप से नहीं जोड़ते।
- Owner संकेत: जब प्रति‑गिल्ड या प्रति‑चैनल `users` allowlist प्रेषक से मेल खाती है, तो OpenClaw सिस्टम प्रॉम्प्ट में उस प्रेषक को owner मानता है। चैनलों के पार एक ग्लोबल owner के लिए, `commands.ownerAllowFrom` सेट करें।
- बॉट-लेखित संदेश डिफ़ॉल्ट रूप से अनदेखे किए जाते हैं; उन्हें अनुमति देने के लिए `channels.discord.allowBots=true` सेट करें (अपने स्वयं के संदेश फ़िल्टर रहते हैं)।
- चेतावनी: यदि आप अन्य बॉट्स को उत्तर देने की अनुमति देते हैं (`channels.discord.allowBots=true`), तो `requireMention`, `channels.discord.guilds.*.channels.<id>
  .users` allowlists, और/या `AGENTS.md` और `SOUL.md` में guardrails को साफ़ करके बॉट‑टू‑बॉट उत्तर लूप्स को रोकें।`channels.discord.groupPolicy` का डिफ़ॉल्ट **allowlist** है; इसे `"open"` पर सेट करें या `channels.discord.guilds` के अंतर्गत एक गिल्ड एंट्री जोड़ें (वैकल्पिक रूप से `channels.discord.guilds.<id>
  .channels` के अंतर्गत चैनल सूचीबद्ध करके प्रतिबंधित करें)।

### 6. सत्यापित करें कि यह काम करता है

1. Gateway शुरू करें।
2. अपने सर्वर चैनल में भेजें: `@Krill hello` (या आपके बॉट का जो भी नाम हो)।
3. यदि कुछ नहीं होता: नीचे **Troubleshooting** देखें।

### समस्या-निवारण

- पहले: `openclaw doctor` और `openclaw channels status --probe` चलाएँ (कार्यान्वयन योग्य चेतावनियाँ + त्वरित ऑडिट)।
- **“Used disallowed intents”**: Developer Portal में **Message Content Intent** (और संभवतः **Server Members Intent**) सक्षम करें, फिर Gateway रीस्टार्ट करें।
- **बॉट कनेक्ट होता है लेकिन guild चैनल में कभी उत्तर नहीं देता**:
  - **Message Content Intent** अनुपस्थित है, या
  - बॉट के पास चैनल अनुमतियाँ नहीं हैं (View/Send/Read History), या
  - आपके config में mentions आवश्यक हैं और आपने mention नहीं किया, या
  - आपका guild/channel allowlist चैनल/उपयोगकर्ता को अस्वीकार करता है।
- **`requireMention: false` लेकिन फिर भी कोई उत्तर नहीं**:
- यदि आप केवल `DISCORD_BOT_TOKEN` सेट करते हैं और कभी `channels.discord` सेक्शन नहीं बनाते, तो रनटाइम
  `groupPolicy` को `open` पर डिफ़ॉल्ट कर देता है।इसे लॉक डाउन करने के लिए `channels.discord.groupPolicy`,
  `channels.defaults.groupPolicy`, या किसी गिल्ड/चैनल allowlist को जोड़ें।
  - `requireMention` को `channels.discord.guilds` (या किसी विशिष्ट चैनल) के अंतर्गत होना चाहिए। `channels.discord.requireMention` को टॉप‑लेवल पर अनदेखा कर दिया जाता है।
- `requireMention` must live under `channels.discord.guilds` (or a specific channel). `channels.discord.requireMention` at the top level is ignored.
- 1. **Permission audits** (`channels status --probe`) केवल संख्यात्मक चैनल IDs की जाँच करते हैं। 2. यदि आप slugs/names को `channels.discord.guilds.*.channels` keys के रूप में उपयोग करते हैं, तो audit permissions को सत्यापित नहीं कर सकता।
- **DMs काम नहीं करते**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, या आपको अभी तक अनुमोदित नहीं किया गया है (`channels.discord.dm.policy="pairing"`)।
- 3. **Discord में Exec approvals**: Discord DMs में exec approvals के लिए **button UI** को सपोर्ट करता है (Allow once / Always allow / Deny)। 4. `/approve <id> ...` केवल forwarded approvals के लिए है और Discord के button prompts को resolve नहीं करेगा। 5. यदि आपको `❌ Failed to submit approval: Error: unknown approval id` दिखे या UI कभी दिखाई न दे, तो जाँचें:
  - आपके config में `channels.discord.execApprovals.enabled: true`।
  - आपका Discord user ID `channels.discord.execApprovals.approvers` में सूचीबद्ध है (UI केवल approvers को भेजी जाती है)।
  - DM prompt में बटनों का उपयोग करें (**Allow once**, **Always allow**, **Deny**)।
  - व्यापक approvals और command flow के लिए [Exec approvals](/tools/exec-approvals) और [Slash commands](/tools/slash-commands) देखें।

## क्षमताएँ और सीमाएँ

- DMs और guild टेक्स्ट चैनल (threads को अलग चैनलों के रूप में माना जाता है; voice समर्थित नहीं)।
- Typing indicators best-effort भेजे जाते हैं; संदेश chunking `channels.discord.textChunkLimit` (डिफ़ॉल्ट 2000) का उपयोग करता है और लंबे उत्तरों को पंक्ति संख्या (`channels.discord.maxLinesPerMessage`, डिफ़ॉल्ट 17) के अनुसार विभाजित करता है।
- वैकल्पिक newline chunking: लंबाई chunking से पहले खाली पंक्तियों (paragraph boundaries) पर विभाजन के लिए `channels.discord.chunkMode="newline"` सेट करें।
- फ़ाइल अपलोड्स कॉन्फ़िगर किए गए `channels.discord.mediaMaxMb` (डिफ़ॉल्ट 8 MB) तक समर्थित हैं।
- शोर से बचने के लिए डिफ़ॉल्ट रूप से mention-gated guild replies।
- जब कोई संदेश किसी अन्य संदेश को संदर्भित करता है, तो reply context इंजेक्ट किया जाता है (quoted content + ids)।
- Native reply threading **डिफ़ॉल्ट रूप से बंद** है; `channels.discord.replyToMode` और reply tags के साथ सक्षम करें।

## Retry policy

6. Outbound Discord API calls rate limits (429) पर Discord के `retry_after` (जब उपलब्ध हो) का उपयोग करते हुए, exponential backoff और jitter के साथ retry होती हैं। 7. `channels.discord.retry` के माध्यम से कॉन्फ़िगर करें। 8. देखें [Retry policy](/concepts/retry)।

## Config

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

9. Ack reactions को वैश्विक रूप से `messages.ackReaction` +
   `messages.ackReactionScope` द्वारा नियंत्रित किया जाता है। 10. बॉट के reply करने के बाद ack reaction हटाने के लिए `messages.removeAckAfterReply` का उपयोग करें।

- `dm.enabled`: सभी DMs को अनदेखा करने के लिए `false` सेट करें (डिफ़ॉल्ट `true`)।
- 11. `dm.policy`: DM access control (`pairing` अनुशंसित)। 12. `"open"` के लिए `dm.allowFrom=["*"]` आवश्यक है।
- 13. `dm.allowFrom`: DM allowlist (user ids या names)। 14. `dm.policy="allowlist"` द्वारा उपयोग किया जाता है और `dm.policy="open"` की validation के लिए। 15. wizard usernames स्वीकार करता है और जब bot members को खोज सकता है तब उन्हें ids में resolve करता है।
- `dm.groupEnabled`: group DMs सक्षम करें (डिफ़ॉल्ट `false`)।
- `dm.groupChannels`: group DM channel ids या slugs के लिए वैकल्पिक allowlist।
- `groupPolicy`: guild चैनल हैंडलिंग नियंत्रित करता है (`open|disabled|allowlist`); `allowlist` के लिए चैनल allowlists आवश्यक हैं।
- `guilds`: प्रति-guild नियम, guild id (पसंदीदा) या slug द्वारा कुंजीबद्ध।
- `guilds."*"`: डिफ़ॉल्ट प्रति-guild सेटिंग्स, जब कोई स्पष्ट एंट्री मौजूद न हो।
- 16. \`guilds.<id>
  17. .slug`: display names के लिए वैकल्पिक friendly slug।18. `guilds.<id>
  18. .users\`: वैकल्पिक per-guild user allowlist (ids या names)।
- 20. \`guilds.<id>
  21. .tools`: वैकल्पिक per-guild tool policy overrides (`allow`/`deny`/`alsoAllow`), जब channel override गायब हो तब उपयोग किया जाता है।22. `guilds.<id>
  22. .toolsBySender`: guild स्तर पर वैकल्पिक per-sender tool policy overrides (जब channel override गायब हो; `"\*"\` wildcard समर्थित)।
- 24. \`guilds.<id>
  25. .channels.<channel>
  26. .allow`: जब `groupPolicy="allowlist"`हो तब चैनल को allow/deny करें।27.`guilds.<id>
  27. .channels.<channel>
  28. .requireMention\`: चैनल के लिए mention gating।
- 30. \`guilds.<id>
  31. .channels.<channel>
  32. .tools`: वैकल्पिक per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`)।33. `guilds.<id>
  33. .channels.<channel>
  34. .toolsBySender`: चैनल के भीतर वैकल्पिक per-sender tool policy overrides (`"\*"\` wildcard समर्थित)।
- 36. \`guilds.<id>
  37. .channels.<channel>
  38. .users`: वैकल्पिक per-channel user allowlist।39. `guilds.<id>
  39. .channels.<channel>
  40. .skills`: skill filter (omit = सभी skills, empty = कोई नहीं)।40. `guilds.<id>
  41. .channels.<channel>
  42. .systemPrompt\`: चैनल के लिए अतिरिक्त system prompt।
- 41. Discord channel topics को **untrusted** context के रूप में inject किया जाता है (system prompt नहीं)।42. \`guilds.<id>
  42. .channels.<channel>
  43. .enabled`: चैनल को disable करने के लिए `false`सेट करें।43.`guilds.<id>
  44. .channels\`: चैनल नियम (keys चैनल slugs या ids होते हैं)।
- `guilds.<id>.channels.<channel>.tools`: optional per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: optional per-sender tool policy overrides within the channel (`"*"` wildcard supported).
- `guilds.<id>.channels.<channel>.users`: optional per-channel user allowlist.
- `guilds.<id>.channels.<channel>.skills`: skill filter (omit = all skills, empty = none).
- `guilds.<id>.channels.<channel>.systemPrompt`: extra system prompt for the channel. Discord channel topics are injected as **untrusted** context (not system prompt).
- `guilds.<id>.channels.<channel>.enabled`: set `false` to disable the channel.
- `guilds.<id>.channels`: channel rules (keys are channel slugs or ids).
- 1. `guilds.<id>`2. `.requireMention`: प्रति-गिल्ड मेंशन आवश्यकता (प्रति चैनल ओवरराइड की जा सकती है)।
- 3. `guilds.<id>`4. `.reactionNotifications`: रिएक्शन सिस्टम इवेंट मोड (`off`, `own`, `all`, `allowlist`)।
- 5. `textChunkLimit`: आउटबाउंड टेक्स्ट चंक आकार (अक्षरों में)। 6. डिफ़ॉल्ट: 2000।
- `chunkMode`: `length` (डिफ़ॉल्ट) केवल `textChunkLimit` से अधिक होने पर विभाजित करता है; `newline` लंबाई chunking से पहले खाली पंक्तियों (paragraph boundaries) पर विभाजित करता है।
- 7. `maxLinesPerMessage`: प्रति संदेश सॉफ्ट अधिकतम पंक्तियों की संख्या। 8. डिफ़ॉल्ट: 17।
- `mediaMaxMb`: इनबाउंड मीडिया को डिस्क पर सहेजते समय clamp करें।
- `historyLimit`: mention के उत्तर में संदर्भ के रूप में शामिल किए जाने वाले हाल के guild संदेशों की संख्या (डिफ़ॉल्ट 20; `messages.groupChat.historyLimit` पर fallback; `0` अक्षम करता है)।
- 9. `dmHistoryLimit`: उपयोगकर्ता टर्न्स में DM इतिहास सीमा। 10. प्रति-उपयोगकर्ता ओवरराइड्स: `dms["<user_id>"].historyLimit`।
- `retry`: outbound Discord API कॉल्स के लिए retry policy (attempts, minDelayMs, maxDelayMs, jitter)।
- `pluralkit`: PluralKit proxied संदेशों को resolve करें ताकि system members अलग-अलग प्रेषक के रूप में दिखाई दें।
- `actions`: प्रति-action tool gates; omit करने पर सभी की अनुमति (अक्षम करने के लिए `false` सेट करें)।
  - `reactions` (react + read reactions को कवर करता है)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (चैनल + श्रेणियाँ + अनुमतियाँ बनाना/संपादित/हटाना)
  - `roles` (भूमिका जोड़ना/हटाना, डिफ़ॉल्ट `false`)
  - `moderation` (timeout/kick/ban, डिफ़ॉल्ट `false`)
  - `presence` (बॉट स्थिति/गतिविधि, डिफ़ॉल्ट `false`)
- 11. `execApprovals`: केवल Discord के लिए exec अनुमोदन DMs (बटन UI)। 12. `enabled`, `approvers`, `agentFilter`, `sessionFilter` समर्थित हैं।

Reaction notifications use `guilds.<id>15. `allowlist`: `guilds.<id>`16.`.users\` से सभी संदेशों पर रिएक्शन (खाली सूची अक्षम करती है)।

- `off`: कोई reaction events नहीं।
- `own`: बॉट के अपने संदेशों पर reactions (डिफ़ॉल्ट)।
- `all`: सभी संदेशों पर सभी reactions।
- 17. PK लुकअप सक्षम करें ताकि प्रॉक्सी किए गए संदेश अंतर्निहित सिस्टम + सदस्य में रेज़ॉल्व हों।18. सक्षम होने पर, OpenClaw अलाउलिस्ट्स के लिए सदस्य पहचान का उपयोग करता है और आकस्मिक Discord पिंग से बचने के लिए प्रेषक को `Member (PK:System)` के रूप में लेबल करता है।

### PluralKit (PK) समर्थन

19. `dm.allowFrom`, `guilds.<id>`
20. `.users`, या प्रति-चैनल `users` में `pk:<memberId>` का उपयोग करें।
21. `replyToMode`: `off` (डिफ़ॉल्ट), `first`, या `all`।

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Allowlist नोट्स (PK-सक्षम):

- 22. केवल तब लागू होता है जब मॉडल में reply टैग शामिल हो।23. `[[reply_to:<id>]]` — कॉन्टेक्स्ट/इतिहास से किसी विशिष्ट संदेश आईडी को उत्तर दें।
- Member डिस्प्ले नाम भी नाम/slug द्वारा मिलाए जाते हैं।
- Lookups **मूल** Discord संदेश ID (pre-proxy संदेश) का उपयोग करते हैं, इसलिए
  PK API इसे केवल अपनी 30-मिनट की विंडो के भीतर resolve करता है।
- यदि PK lookups विफल होते हैं (जैसे, बिना टोकन वाला निजी सिस्टम), तो proxied संदेश
  बॉट संदेश माने जाते हैं और `channels.discord.allowBots=true` न होने पर हटा दिए जाते हैं।

### Tool action defaults

| Action group   | Default  | Notes                                               |
| -------------- | -------- | --------------------------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList                  |
| stickers       | enabled  | स्टिकर भेजें                                        |
| emojiUploads   | enabled  | इमोजी अपलोड करें                                    |
| stickerUploads | enabled  | स्टिकर अपलोड करें                                   |
| polls          | enabled  | पोल बनाएँ                                           |
| permissions    | enabled  | चैनल अनुमति स्नैपशॉट                                |
| messages       | enabled  | पढ़ें/भेजें/संपादित/हटाएँ                           |
| threads        | enabled  | बनाएँ/सूचीबद्ध/उत्तर दें                            |
| pins           | enabled  | पिन/अनपिन/सूची                                      |
| search         | enabled  | संदेश खोज (preview फीचर)         |
| memberInfo     | enabled  | सदस्य जानकारी                                       |
| roleInfo       | enabled  | भूमिका सूची                                         |
| channelInfo    | enabled  | चैनल जानकारी + सूची                                 |
| channels       | enabled  | चैनल/श्रेणी प्रबंधन                                 |
| voiceStatus    | enabled  | वॉइस स्टेट लुकअप                                    |
| events         | enabled  | शेड्यूल्ड इवेंट्स सूची/निर्माण                      |
| roles          | disabled | भूमिका जोड़ना/हटाना                                 |
| moderation     | disabled | Timeout/kick/ban                                    |
| presence       | disabled | बॉट स्थिति/गतिविधि (setPresence) |

- 24. वर्तमान संदेश आईडी प्रॉम्प्ट्स में `[message_id: …]` के रूप में जोड़ी जाती हैं; इतिहास प्रविष्टियों में पहले से ही आईडी शामिल होती हैं। 25. जब `guilds.<id>`
  25. `.channels` मौजूद हो, तो सूचीबद्ध न किए गए चैनल डिफ़ॉल्ट रूप से अस्वीकृत होते हैं।

## Reply tags

थ्रेडेड उत्तर का अनुरोध करने के लिए, मॉडल अपने आउटपुट में एक टैग शामिल कर सकता है:

- `[[reply_to_current]]` — ट्रिगर करने वाले Discord संदेश का उत्तर दें।
- 27. जब `guilds.<id>`
  28. `.channels` छोड़ा जाता है, तो अलाउलिस्टेड गिल्ड के सभी चैनल अनुमत होते हैं।
  29. Discord संदेश आईडी इंजेक्टेड कॉन्टेक्स्ट (`[discord message id: …]` और इतिहास पंक्तियाँ) में प्रदर्शित की जाती हैं ताकि एजेंट उन्हें लक्षित कर सके।

व्यवहार `channels.discord.replyToMode` द्वारा नियंत्रित होता है:

- `off`: टैग्स को अनदेखा करें।
- `first`: केवल पहला outbound chunk/attachment ही reply होता है।
- `all`: हर outbound chunk/attachment reply होता है।

Allowlist मिलान नोट्स:

- `allowFrom`/`users`/`groupChannels` ids, नाम, टैग्स, या `<@id>` जैसे mentions स्वीकार करते हैं।
- `discord:`/`user:` (users) और `channel:` (group DMs) जैसे prefixes समर्थित हैं।
- किसी भी प्रेषक/चैनल को अनुमति देने के लिए `*` का उपयोग करें।
- 30. इमोजी यूनिकोड (जैसे, `✅`) या कस्टम इमोजी सिंटैक्स जैसे `<:party_blob:1234567890>` हो सकते हैं।31. Feishu (Lark) एक टीम चैट प्लेटफ़ॉर्म है जिसका उपयोग कंपनियाँ संदेश और सहयोग के लिए करती हैं।
- 32. यह प्लगइन प्लेटफ़ॉर्म की WebSocket इवेंट सब्सक्रिप्शन का उपयोग करके OpenClaw को Feishu/Lark बॉट से जोड़ता है ताकि सार्वजनिक वेबहुक URL को उजागर किए बिना संदेश प्राप्त किए जा सकें।33. 1.
- **कोई भी चैनल** अनुमति न देने के लिए `channels.discord.groupPolicy: "disabled"` सेट करें (या खाली allowlist रखें)।
- configure wizard `Guild/Channel` नाम (public + private) स्वीकार करता है और संभव होने पर उन्हें IDs में resolve करता है।
- स्टार्टअप पर, OpenClaw allowlists में चैनल/उपयोगकर्ता नामों को IDs में resolve करता है (जब बॉट सदस्यों को खोज सकता है)
  और मैपिंग लॉग करता है; unresolved प्रविष्टियाँ टाइप की हुई ही रखी जाती हैं।

Native command नोट्स:

- पंजीकृत commands OpenClaw के chat commands को प्रतिबिंबित करते हैं।
- Native commands DMs/guild संदेशों के समान allowlists का सम्मान करते हैं (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, प्रति-चैनल नियम)।
- Slash commands Discord UI में उन उपयोगकर्ताओं को भी दिखाई दे सकते हैं जो allowlisted नहीं हैं; OpenClaw निष्पादन पर allowlists लागू करता है और “not authorized” उत्तर देता है।

## Tool actions

एजेंट `discord` को निम्नलिखित जैसी actions के साथ कॉल कर सकता है:

- `react` / `reactions` (reactions जोड़ें या सूचीबद्ध करें)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Read/search/pin tool payloads में normalized `timestampMs` (UTC epoch ms) और raw Discord `timestamp` के साथ `timestampUtc` शामिल होते हैं।
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (बॉट गतिविधि और ऑनलाइन स्थिति)

34. Feishu Open Platform खोलें
35. 2.

## सुरक्षा और संचालन

- बॉट टोकन को पासवर्ड की तरह मानें; supervised होस्ट्स पर `DISCORD_BOT_TOKEN` env var को प्राथमिकता दें या config फ़ाइल अनुमतियों को लॉक डाउन करें।
- बॉट को केवल आवश्यक अनुमतियाँ दें (आमतौर पर Read/Send Messages)।
- यदि बॉट अटका हुआ है या rate limited है, तो यह पुष्टि करने के बाद कि कोई अन्य प्रक्रिया Discord सत्र का स्वामी नहीं है, Gateway (`openclaw gateway --force`) रीस्टार्ट करें।
