---
summary: "Feishu बॉट का अवलोकन, विशेषताएँ और विन्यास"
read_when:
  - आप Feishu/Lark बॉट को कनेक्ट करना चाहते हैं
  - आप Feishu चैनल का विन्यास कर रहे हैं
title: Feishu
---

# Feishu बॉट

36. एक ऐप बनाएं 37. 3.

---

## आवश्यक प्लगइन

Feishu प्लगइन इंस्टॉल करें:

```bash
openclaw plugins install @openclaw/feishu
```

स्थानीय चेकआउट (जब git रिपॉज़िटरी से चला रहे हों):

```bash
openclaw plugins install ./extensions/feishu
```

---

## त्वरित प्रारंभ

Feishu चैनल जोड़ने के दो तरीके हैं:

### तरीका 1: ऑनबोर्डिंग विज़ार्ड (अनुशंसित)

यदि आपने अभी OpenClaw इंस्टॉल किया है, तो विज़ार्ड चलाएँ:

```bash
openclaw onboard
```

विज़ार्ड आपको इन चरणों में मार्गदर्शन करता है:

1. Feishu ऐप बनाना और क्रेडेंशियल एकत्र करना
2. OpenClaw में ऐप क्रेडेंशियल का विन्यास
3. Gateway प्रारंभ करना

✅ **विन्यास के बाद**, Gateway की स्थिति जाँचें:

- `openclaw gateway status`
- `openclaw logs --follow`

### तरीका 2: CLI सेटअप

यदि आपने प्रारंभिक इंस्टॉलेशन पहले ही पूरा कर लिया है, तो CLI के माध्यम से चैनल जोड़ें:

```bash
openclaw channels add
```

**Feishu** चुनें, फिर App ID और App Secret दर्ज करें।

✅ **विन्यास के बाद**, Gateway का प्रबंधन करें:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## चरण 1: Feishu ऐप बनाएँ

### 38. क्रेडेंशियल्स कॉपी करें 39. 4.

[Feishu Open Platform](https://open.feishu.cn/app) पर जाएँ और साइन इन करें।

Lark (ग्लोबल) टेनेंट्स को [https://open.larksuite.com/app](https://open.larksuite.com/app) का उपयोग करना चाहिए और Feishu विन्यास में `domain: "lark"` सेट करना चाहिए।

### 40. अनुमतियाँ कॉन्फ़िगर करें 41. 5.

1. **Create enterprise app** पर क्लिक करें
2. ऐप नाम + विवरण भरें
3. ऐप आइकन चुनें

![Create enterprise app](../images/feishu-step2-create-app.png)

### 42. 6. 43. इवेंट सब्सक्रिप्शन कॉन्फ़िगर करें

**Credentials & Basic Info** से कॉपी करें:

- **App ID** (फ़ॉर्मेट: `cli_xxx`)
- **App Secret**

❗ **महत्वपूर्ण:** App Secret को निजी रखें।

![Get credentials](../images/feishu-step3-credentials.png)

### 44. 7. 45. ऐप प्रकाशित करें

**Permissions** में **Batch import** पर क्लिक करें और पेस्ट करें:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 46. यदि आपका टेनेंट Lark (अंतरराष्ट्रीय) पर है, तो डोमेन को `lark` (या पूर्ण डोमेन स्ट्रिंग) पर सेट करें। बॉट क्षमता सक्षम करें

**App Capability** > **Bot** में:

1. बॉट क्षमता सक्षम करें
2. बॉट का नाम सेट करें

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 47. आप इसे `channels.feishu.domain` पर या प्रति खाते (`channels.feishu.accounts.<id>`
48. `.domain`) पर सेट कर सकते हैं। 49. 1.

⚠️ **महत्वपूर्ण:** इवेंट सब्सक्रिप्शन सेट करने से पहले सुनिश्चित करें:

1. आपने Feishu के लिए पहले ही `openclaw channels add` चला लिया है
2. Gateway चल रहा है (`openclaw gateway status`)

**Event Subscription** में:

1. **Use long connection to receive events** (WebSocket) चुनें
2. इवेंट जोड़ें: `im.message.receive_v1`

⚠️ यदि Gateway नहीं चल रहा है, तो long-connection सेटअप सहेजा नहीं जा सकता।

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 50. गेटवे शुरू करें Publish the app

1. **Version Management & Release** में एक संस्करण बनाएँ
2. समीक्षा के लिए सबमिट करें और प्रकाशित करें
3. एडमिन स्वीकृति की प्रतीक्षा करें (एंटरप्राइज़ ऐप्स आमतौर पर स्वतः स्वीकृत हो जाते हैं)

---

## चरण 2: OpenClaw का विन्यास

### विज़ार्ड के साथ विन्यास (अनुशंसित)

```bash
openclaw channels add
```

**Feishu** चुनें और अपना App ID + App Secret पेस्ट करें।

### कॉन्फ़िग फ़ाइल के माध्यम से विन्यास

`~/.openclaw/openclaw.json` संपादित करें:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### पर्यावरण चर के माध्यम से विन्यास

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (ग्लोबल) डोमेन

If your tenant is on Lark (international), set the domain to `lark` (or a full domain string). You can set it at `channels.feishu.domain` or per account (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## चरण 3: प्रारंभ + परीक्षण

### 1. Start the gateway

```bash
openclaw gateway
```

### 2. Send a test message

Feishu में अपने बॉट को खोजें और एक संदेश भेजें।

### 3. Approve pairing

By default, the bot replies with a pairing code. Approve it:

```bash
openclaw pairing approve feishu <CODE>
```

स्वीकृति के बाद, आप सामान्य रूप से चैट कर सकते हैं।

---

## अवलोकन

- **Feishu बॉट चैनल**: Gateway द्वारा प्रबंधित Feishu बॉट
- **निर्धारित रूटिंग**: उत्तर हमेशा Feishu पर ही लौटते हैं
- **सत्र पृथक्करण**: DMs एक मुख्य सत्र साझा करते हैं; समूह अलग-थलग होते हैं
- **WebSocket कनेक्शन**: Feishu SDK के माध्यम से लंबा कनेक्शन, किसी सार्वजनिक URL की आवश्यकता नहीं

---

## प्रवेश नियंत्रण

### डायरेक्ट मैसेज

- **डिफ़ॉल्ट**: `dmPolicy: "pairing"` (अज्ञात उपयोगकर्ताओं को पेयरिंग कोड मिलता है)

- **पेयरिंग स्वीकृत करें**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Allowlist मोड**: अनुमत Open IDs के साथ `channels.feishu.allowFrom` सेट करें

### समूह चैट

**1. Group policy** (`channels.feishu.groupPolicy`):

- `"open"` = समूहों में सभी को अनुमति दें (डिफ़ॉल्ट)
- `"allowlist"` = केवल `groupAllowFrom` को अनुमति दें
- `"disabled"` = समूह संदेश अक्षम करें

**2. Mention requirement** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @mention आवश्यक (डिफ़ॉल्ट)
- `false` = बिना मेंशन के उत्तर दें

---

## समूह विन्यास उदाहरण

### सभी समूहों की अनुमति, @mention आवश्यक (डिफ़ॉल्ट)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### सभी समूहों की अनुमति, @mention आवश्यक नहीं

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### केवल समूहों में विशिष्ट उपयोगकर्ताओं की अनुमति

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## समूह/उपयोगकर्ता ID प्राप्त करें

### समूह ID (chat_id)

समूह ID इस प्रकार दिखते हैं: `oc_xxx`।

**तरीका 1 (अनुशंसित)**

1. Gateway प्रारंभ करें और समूह में बॉट को @mention करें
2. `openclaw logs --follow` चलाएँ और `chat_id` देखें

**तरीका 2**

Feishu API डिबगर का उपयोग करके समूह चैट सूचीबद्ध करें।

### उपयोगकर्ता ID (open_id)

उपयोगकर्ता ID इस प्रकार दिखते हैं: `ou_xxx`।

**तरीका 1 (अनुशंसित)**

1. Gateway प्रारंभ करें और बॉट को DM करें
2. `openclaw logs --follow` चलाएँ और `open_id` देखें

**तरीका 2**

उपयोगकर्ता Open IDs के लिए पेयरिंग अनुरोध जाँचें:

```bash
openclaw pairing list feishu
```

---

## सामान्य कमांड

| Command   | Description          |
| --------- | -------------------- |
| `/status` | बॉट की स्थिति दिखाएँ |
| `/reset`  | सत्र रीसेट करें      |
| `/model`  | मॉडल दिखाएँ/बदलें    |

> टिप्पणी: Feishu अभी नेटिव कमांड मेनू का समर्थन नहीं करता, इसलिए कमांड टेक्स्ट के रूप में भेजने होंगे।

## Gateway प्रबंधन कमांड

| Command                    | Description                       |
| -------------------------- | --------------------------------- |
| `openclaw gateway status`  | Gateway की स्थिति दिखाएँ          |
| `openclaw gateway install` | Gateway सेवा इंस्टॉल/प्रारंभ करें |
| `openclaw gateway stop`    | Gateway सेवा रोकें                |
| `openclaw gateway restart` | Gateway सेवा पुनः प्रारंभ करें    |
| `openclaw logs --follow`   | Gateway लॉग देखें                 |

---

## समस्या-निवारण

### समूह चैट में बॉट उत्तर नहीं देता

1. सुनिश्चित करें कि बॉट समूह में जोड़ा गया है
2. सुनिश्चित करें कि आप बॉट को @mention कर रहे हैं (डिफ़ॉल्ट व्यवहार)
3. जाँचें कि `groupPolicy` को `"disabled"` पर सेट नहीं किया गया है
4. लॉग जाँचें: `openclaw logs --follow`

### बॉट संदेश प्राप्त नहीं करता

1. सुनिश्चित करें कि ऐप प्रकाशित और स्वीकृत है
2. सुनिश्चित करें कि इवेंट सब्सक्रिप्शन में `im.message.receive_v1` शामिल है
3. सुनिश्चित करें कि **long connection** सक्षम है
4. सुनिश्चित करें कि ऐप अनुमतियाँ पूर्ण हैं
5. सुनिश्चित करें कि Gateway चल रहा है: `openclaw gateway status`
6. लॉग जाँचें: `openclaw logs --follow`

### App Secret लीक

1. Feishu Open Platform में App Secret रीसेट करें
2. अपने विन्यास में App Secret अपडेट करें
3. Gateway पुनः प्रारंभ करें

### संदेश भेजने में विफलता

1. सुनिश्चित करें कि ऐप के पास `im:message:send_as_bot` अनुमति है
2. सुनिश्चित करें कि ऐप प्रकाशित है
3. विस्तृत त्रुटियों के लिए लॉग जाँचें

---

## उन्नत विन्यास

### एकाधिक खाते

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### संदेश सीमाएँ

- `textChunkLimit`: आउटबाउंड टेक्स्ट चंक आकार (डिफ़ॉल्ट: 2000 अक्षर)
- `mediaMaxMb`: मीडिया अपलोड/डाउनलोड सीमा (डिफ़ॉल्ट: 30MB)

### स्ट्रीमिंग

Feishu supports streaming replies via interactive cards. When enabled, the bot updates a card as it generates text.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

पूरा उत्तर भेजने से पहले प्रतीक्षा करने के लिए `streaming: false` सेट करें।

### मल्टी-एजेंट रूटिंग

Feishu DMs या समूहों को विभिन्न एजेंट्स पर रूट करने के लिए `bindings` का उपयोग करें।

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

रूटिंग फ़ील्ड्स:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` या `"group"`
- `match.peer.id`: उपयोगकर्ता Open ID (`ou_xxx`) या समूह ID (`oc_xxx`)

लुकअप सुझावों के लिए [Get group/user IDs](#get-groupuser-ids) देखें।

---

## विन्यास संदर्भ

पूर्ण विन्यास: [Gateway configuration](/gateway/configuration)

मुख्य विकल्प:

| Setting                                           | Description                                                         | Default   |
| ------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | चैनल सक्षम/अक्षम करें                                               | `true`    |
| `channels.feishu.domain`                          | API डोमेन (`feishu` या `lark`)                   | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                              | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                          | -         |
| `channels.feishu.accounts.<id>.domain`            | प्रति-खाता API डोमेन ओवरराइड                                        | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM नीति                                                             | `pairing` |
| `channels.feishu.allowFrom`                       | DM allowlist (open_id सूची) | -         |
| `channels.feishu.groupPolicy`                     | समूह नीति                                                           | `open`    |
| `channels.feishu.groupAllowFrom`                  | समूह allowlist                                                      | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @mention आवश्यक                                        | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | समूह सक्षम करें                                                     | `true`    |
| `channels.feishu.textChunkLimit`                  | संदेश चंक आकार                                                      | `2000`    |
| `channels.feishu.mediaMaxMb`                      | मीडिया आकार सीमा                                                    | `30`      |
| `channels.feishu.streaming`                       | स्ट्रीमिंग कार्ड आउटपुट सक्षम करें                                  | `true`    |
| `channels.feishu.blockStreaming`                  | ब्लॉक स्ट्रीमिंग सक्षम करें                                         | `true`    |

---

## dmPolicy संदर्भ

| Value         | Behavior                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------ |
| `"pairing"`   | **डिफ़ॉल्ट.** अज्ञात उपयोगकर्ताओं को पेयरिंग कोड मिलता है; स्वीकृति आवश्यक |
| `"allowlist"` | केवल `allowFrom` में मौजूद उपयोगकर्ता ही चैट कर सकते हैं                                   |
| `"open"`      | सभी उपयोगकर्ताओं को अनुमति दें (allowFrom में `"*"` आवश्यक)             |
| `"disabled"`  | DMs अक्षम करें                                                                             |

---

## समर्थित संदेश प्रकार

### प्राप्त करें

- ✅ टेक्स्ट
- ✅ रिच टेक्स्ट (पोस्ट)
- ✅ इमेज
- ✅ फ़ाइलें
- ✅ ऑडियो
- ✅ वीडियो
- ✅ स्टिकर्स

### भेजें

- ✅ टेक्स्ट
- ✅ इमेज
- ✅ फ़ाइलें
- ✅ ऑडियो
- ⚠️ रिच टेक्स्ट (आंशिक समर्थन)
