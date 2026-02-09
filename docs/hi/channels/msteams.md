---
summary: "Microsoft Teams बॉट समर्थन की स्थिति, क्षमताएँ और विन्यास"
read_when:
  - MS Teams चैनल फीचर्स पर काम करते समय
title: "Microsoft Teams"
---

# Microsoft Teams (प्लगइन)

> "जो यहाँ प्रवेश करे, सारी आशा त्याग दे।"

अद्यतन: 2026-01-21

Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](#sending-files-in-group-chats)). Polls are sent via Adaptive Cards.

## प्लगइन आवश्यक

Microsoft Teams एक प्लगइन के रूप में उपलब्ध है और कोर इंस्टॉल में शामिल नहीं है।

**Breaking change (2026.1.15):** MS Teams moved out of core. If you use it, you must install the plugin.

स्पष्टीकरण: इससे कोर इंस्टॉल हल्के रहते हैं और MS Teams की निर्भरताएँ स्वतंत्र रूप से अपडेट हो सकती हैं।

CLI के माध्यम से इंस्टॉल करें (npm रजिस्ट्री):

```bash
openclaw plugins install @openclaw/msteams
```

लोकल चेकआउट (जब git रिपॉजिटरी से चला रहे हों):

```bash
openclaw plugins install ./extensions/msteams
```

यदि आप configure/onboarding के दौरान Teams चुनते हैं और git चेकआउट पाया जाता है,
तो OpenClaw स्वतः लोकल इंस्टॉल पाथ ऑफ़र करेगा।

विवरण: [Plugins](/tools/plugin)

## त्वरित सेटअप (शुरुआती)

1. Microsoft Teams प्लगइन इंस्टॉल करें।
2. एक **Azure Bot** बनाएँ (App ID + client secret + tenant ID)।
3. उन क्रेडेंशियल्स के साथ OpenClaw को कॉन्फ़िगर करें।
4. `/api/messages` (डिफ़ॉल्ट रूप से पोर्ट 3978) को सार्वजनिक URL या टनल के माध्यम से एक्सपोज़ करें।
5. Teams ऐप पैकेज इंस्टॉल करें और Gateway प्रारंभ करें।

न्यूनतम विन्यास:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Note: group chats are blocked by default (`channels.msteams.groupPolicy: "allowlist"`). To allow group replies, set `channels.msteams.groupAllowFrom` (or use `groupPolicy: "open"` to allow any member, mention-gated).

## लक्ष्य

- Teams DMs, समूह चैट या चैनलों के माध्यम से OpenClaw से बात करना।
- रूटिंग को निर्धारक रखना: उत्तर हमेशा उसी चैनल में वापस जाएँ जहाँ से वे आए।
- सुरक्षित चैनल व्यवहार को डिफ़ॉल्ट रखना (जब तक अन्यथा कॉन्फ़िगर न हो, mentions आवश्यक)।

## Config लिखना

डिफ़ॉल्ट रूप से, Microsoft Teams को `/config set|unset` द्वारा ट्रिगर किए गए config अपडेट लिखने की अनुमति है (इसके लिए `commands.config: true` आवश्यक है)।

अक्षम करने के लिए:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## प्रवेश नियंत्रण (DMs + समूह)

**DM प्रवेश**

- डिफ़ॉल्ट: `channels.msteams.dmPolicy = "pairing"`। Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` accepts AAD object IDs, UPNs, or display names. The wizard resolves names to IDs via Microsoft Graph when credentials allow.

**समूह प्रवेश**

- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Use `channels.defaults.groupPolicy` to override the default when unset.
- `channels.msteams.groupAllowFrom` नियंत्रित करता है कि समूह चैट/चैनलों में कौन से प्रेषक ट्रिगर कर सकते हैं (fallback: `channels.msteams.allowFrom`)।
- किसी भी सदस्य को अनुमति देने के लिए `groupPolicy: "open"` सेट करें (डिफ़ॉल्ट रूप से अभी भी mention‑gated)।
- **कोई चैनल नहीं** अनुमति देने के लिए `channels.msteams.groupPolicy: "disabled"` सेट करें।

उदाहरण:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + चैनल allowlist**

- `channels.msteams.teams` के अंतर्गत teams और channels सूचीबद्ध करके समूह/चैनल उत्तरों का दायरा सीमित करें।
- Keys टीम IDs या नाम हो सकते हैं; चैनल keys conversation IDs या नाम हो सकते हैं।
- जब `groupPolicy="allowlist"` और teams allowlist मौजूद हो, तो केवल सूचीबद्ध teams/channels स्वीकार किए जाते हैं (mention‑gated)।
- configure विज़ार्ड `Team/Channel` प्रविष्टियाँ स्वीकार करता है और उन्हें आपके लिए सहेज देता है।
- स्टार्टअप पर, OpenClaw टीम/चैनल और उपयोगकर्ता allowlist नामों को IDs में resolve करता है (जब Graph अनुमतियाँ अनुमति दें)
  और मैपिंग लॉग करता है; जो resolve न हों, वे टाइप किए गए रूप में ही रखे जाते हैं।

उदाहरण:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## यह कैसे काम करता है

1. Microsoft Teams प्लगइन इंस्टॉल करें।
2. एक **Azure Bot** बनाएँ (App ID + secret + tenant ID)।
3. एक **Teams ऐप पैकेज** बनाएँ जो बॉट को संदर्भित करे और नीचे दिए गए RSC अनुमतियाँ शामिल करे।
4. Teams ऐप को किसी टीम में (या DMs के लिए personal scope में) अपलोड/इंस्टॉल करें।
5. `~/.openclaw/openclaw.json` (या env vars) में `msteams` कॉन्फ़िगर करें और Gateway प्रारंभ करें।
6. Gateway डिफ़ॉल्ट रूप से `/api/messages` पर Bot Framework webhook ट्रैफ़िक सुनता है।

## Azure Bot सेटअप (पूर्वापेक्षाएँ)

OpenClaw को कॉन्फ़िगर करने से पहले, आपको Azure Bot संसाधन बनाना होगा।

### चरण 1: Azure Bot बनाएँ

1. [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot) पर जाएँ
2. **Basics** टैब भरें:

   | फ़ील्ड             | मान                                                                            |
   | ------------------ | ------------------------------------------------------------------------------ |
   | **Bot handle**     | आपका बॉट नाम, जैसे `openclaw-msteams` (अद्वितीय होना चाहिए) |
   | **Subscription**   | अपनी Azure subscription चुनें                                                  |
   | **Resource group** | नया बनाएँ या मौजूदा का उपयोग करें                                              |
   | **Pricing tier**   | dev/testing के लिए **Free**                                                    |
   | **Type of App**    | **Single Tenant** (अनुशंसित - नीचे नोट देखें)               |
   | **Creation type**  | **Create new Microsoft App ID**                                                |

> **अप्रचलन सूचना:** नए मल्टी-टेनेंट बॉट्स का निर्माण 2025-07-31 के बाद अप्रचलित कर दिया गया। नए बॉट्स के लिए **Single Tenant** का उपयोग करें।

3. **Review + create** → **Create** पर क्लिक करें (~1-2 मिनट प्रतीक्षा करें)

### चरण 2: क्रेडेंशियल्स प्राप्त करें

1. अपने Azure Bot संसाधन → **Configuration** पर जाएँ
2. **Microsoft App ID** कॉपी करें → यही आपका `appId` है
3. **Manage Password** पर क्लिक करें → App Registration पर जाएँ
4. **Certificates & secrets** → **New client secret** → **Value** कॉपी करें → यही आपका `appPassword` है
5. **Overview** → **Directory (tenant) ID** कॉपी करें → यही आपका `tenantId` है

### चरण 3: Messaging Endpoint कॉन्फ़िगर करें

1. Azure Bot → **Configuration**
2. **Messaging endpoint** को अपने webhook URL पर सेट करें:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: एक टनल का उपयोग करें (नीचे [Local Development](#local-development-tunneling) देखें)

### चरण 4: Teams चैनल सक्षम करें

1. Azure Bot → **Channels**
2. **Microsoft Teams** → Configure → Save पर क्लिक करें
3. सेवा की शर्तें स्वीकार करें

## Local Development (Tunneling)

Teams `localhost` तक नहीं पहुँच सकता। लोकल डेवलपमेंट के लिए टनल का उपयोग करें:

**विकल्प A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**विकल्प B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (वैकल्पिक)

मैन्युअली manifest ZIP बनाने के बजाय, आप [Teams Developer Portal](https://dev.teams.microsoft.com/apps) का उपयोग कर सकते हैं:

1. **+ New app** पर क्लिक करें
2. बुनियादी जानकारी भरें (नाम, विवरण, डेवलपर जानकारी)
3. **App features** → **Bot** पर जाएँ
4. **Enter a bot ID manually** चुनें और अपना Azure Bot App ID पेस्ट करें
5. Scopes चुनें: **Personal**, **Team**, **Group Chat**
6. **Distribute** → **Download app package**
7. Teams में: **Apps** → **Manage your apps** → **Upload a custom app** → ZIP चुनें

यह अक्सर JSON manifests को हाथ से एडिट करने से आसान होता है।

## बॉट का परीक्षण

**विकल्प A: Azure Web Chat (पहले webhook सत्यापित करें)**

1. Azure Portal → आपका Azure Bot संसाधन → **Test in Web Chat**
2. एक संदेश भेजें — आपको प्रतिक्रिया दिखनी चाहिए
3. यह पुष्टि करता है कि आपका webhook endpoint Teams सेटअप से पहले काम कर रहा है

**विकल्प B: Teams (ऐप इंस्टॉलेशन के बाद)**

1. Teams ऐप इंस्टॉल करें (sideload या org catalog)
2. Teams में बॉट खोजें और एक DM भेजें
3. आने वाली गतिविधि के लिए Gateway लॉग्स जाँचें

## सेटअप (न्यूनतम, केवल टेक्स्ट)

1. **Microsoft Teams प्लगइन इंस्टॉल करें**
   - npm से: `openclaw plugins install @openclaw/msteams`
   - लोकल चेकआउट से: `openclaw plugins install ./extensions/msteams`

2. **बॉट रजिस्ट्रेशन**
   - Azure Bot बनाएँ (ऊपर देखें) और नोट करें:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

3. **Teams ऐप मैनिफ़ेस्ट**
   - `botId = <App ID>` के साथ एक `bot` प्रविष्टि शामिल करें।
   - Scopes: `personal`, `team`, `groupChat`।
   - `supportsFiles: true` (personal scope फ़ाइल हैंडलिंग के लिए आवश्यक)।
   - RSC अनुमतियाँ जोड़ें (नीचे)।
   - आइकन बनाएँ: `outline.png` (32x32) और `color.png` (192x192)।
   - तीनों फ़ाइलें साथ में ज़िप करें: `manifest.json`, `outline.png`, `color.png`।

4. **OpenClaw कॉन्फ़िगर करें**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   आप config keys की बजाय environment variables भी उपयोग कर सकते हैं:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot endpoint**
   - Azure Bot Messaging Endpoint सेट करें:
     - `https://<host>:3978/api/messages` (या आपका चुना हुआ path/port)।

6. **Gateway चलाएँ**
   - प्लगइन इंस्टॉल होने और `msteams` config में क्रेडेंशियल्स मौजूद होने पर Teams चैनल स्वतः प्रारंभ हो जाता है।

## History संदर्भ

- `channels.msteams.historyLimit` नियंत्रित करता है कि हाल के कितने चैनल/समूह संदेश prompt में शामिल किए जाएँ।
- `messages.groupChat.historyLimit` पर फ़ॉलबैक करता है। अक्षम करने के लिए `0` सेट करें (डिफ़ॉल्ट 50)।
- DM इतिहास को `channels.msteams.dmHistoryLimit` (यूज़र टर्न्स) से सीमित किया जा सकता है। प्रति-यूज़र ओवरराइड्स: `channels.msteams.dms["<user_id>"].historyLimit`।

## वर्तमान Teams RSC अनुमतियाँ (Manifest)

ये हमारे Teams ऐप मैनिफ़ेस्ट में मौजूद **resourceSpecific permissions** हैं। ये केवल उसी टीम/चैट के भीतर लागू होते हैं जहाँ ऐप इंस्टॉल किया गया है।

**चैनलों के लिए (team scope):**

- `ChannelMessage.Read.Group` (Application) - @mention के बिना सभी चैनल संदेश प्राप्त करें
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**समूह चैट के लिए:**

- `ChatMessage.Read.Chat` (Application) - @mention के बिना सभी समूह चैट संदेश प्राप्त करें

## उदाहरण Teams मैनिफ़ेस्ट (redacted)

आवश्यक फ़ील्ड्स के साथ न्यूनतम, वैध उदाहरण। IDs और URLs बदलें।

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Manifest सावधानियाँ (अनिवार्य फ़ील्ड्स)

- `bots[].botId` **अनिवार्य रूप से** Azure Bot App ID से मेल खाना चाहिए।
- `webApplicationInfo.id` **अनिवार्य रूप से** Azure Bot App ID से मेल खाना चाहिए।
- `bots[].scopes` में वे surfaces शामिल होने चाहिए जिन्हें आप उपयोग करने वाले हैं (`personal`, `team`, `groupChat`)।
- `bots[].supportsFiles: true` personal scope में फ़ाइल हैंडलिंग के लिए आवश्यक है।
- `authorization.permissions.resourceSpecific` में चैनल read/send शामिल होना चाहिए यदि आप चैनल ट्रैफ़िक चाहते हैं।

### मौजूदा ऐप अपडेट करना

पहले से इंस्टॉल Teams ऐप को अपडेट करने के लिए (जैसे RSC अनुमतियाँ जोड़ना):

1. नई सेटिंग्स के साथ अपना `manifest.json` अपडेट करें
2. **`version` फ़ील्ड बढ़ाएँ** (जैसे `1.0.0` → `1.1.0`)
3. **Manifest को आइकनों के साथ फिर से ज़िप करें** (`manifest.json`, `outline.png`, `color.png`)
4. नया zip अपलोड करें:
   - **विकल्प A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → अपना ऐप खोजें → Upload new version
   - **विकल्प B (Sideload):** Teams → Apps → Manage your apps → Upload a custom app
5. **टीम चैनलों के लिए:** नई अनुमतियाँ प्रभावी होने के लिए प्रत्येक टीम में ऐप पुनः इंस्टॉल करें
6. **Teams को पूरी तरह बंद कर पुनः खोलें** (केवल विंडो बंद न करें) ताकि cached app metadata साफ़ हो

## क्षमताएँ: केवल RSC बनाम Graph

### **केवल Teams RSC** के साथ (ऐप इंस्टॉल, कोई Graph API अनुमति नहीं)

काम करता है:

- चैनल संदेश **टेक्स्ट** सामग्री पढ़ना।
- चैनल संदेश **टेक्स्ट** सामग्री भेजना।
- **personal (DM)** फ़ाइल अटैचमेंट प्राप्त करना।

काम नहीं करता:

- चैनल/समूह **इमेज या फ़ाइल सामग्री** (payload में केवल HTML stub होता है)।
- SharePoint/OneDrive में संग्रहीत अटैचमेंट डाउनलोड करना।
- संदेश इतिहास पढ़ना (live webhook event से आगे)।

### **Teams RSC + Microsoft Graph Application अनुमतियों** के साथ

जोड़ता है:

- होस्टेड सामग्री डाउनलोड करना (संदेशों में पेस्ट की गई इमेज)।
- SharePoint/OneDrive में संग्रहीत फ़ाइल अटैचमेंट डाउनलोड करना।
- Graph के माध्यम से चैनल/चैट संदेश इतिहास पढ़ना।

### RSC बनाम Graph API

| क्षमता                  | RSC अनुमतियाँ                                 | Graph API                                          |
| ----------------------- | --------------------------------------------- | -------------------------------------------------- |
| **रियल-टाइम संदेश**     | हाँ (webhook के माध्यम से) | नहीं (केवल polling)             |
| **ऐतिहासिक संदेश**      | नहीं                                          | हाँ (इतिहास क्वेरी कर सकते हैं) |
| **सेटअप जटिलता**        | केवल ऐप मैनिफ़ेस्ट                            | admin consent + token flow आवश्यक                  |
| **ऑफ़लाइन काम करता है** | नहीं (चलना आवश्यक)         | हाँ (कभी भी क्वेरी)             |

**निष्कर्ष:** RSC रियल-टाइम लिसनिंग के लिए है; Graph API ऐतिहासिक एक्सेस के लिए है। ऑफ़लाइन रहने के दौरान छूटे संदेशों को पकड़ने के लिए, आपको `ChannelMessage.Read.All` के साथ Graph API चाहिए (एडमिन सहमति आवश्यक)।

## Graph-सक्षम मीडिया + history (चैनलों के लिए आवश्यक)

यदि आपको **चैनलों** में इमेज/फ़ाइल चाहिए या **संदेश इतिहास** प्राप्त करना है, तो Microsoft Graph अनुमतियाँ सक्षम करनी होंगी और admin consent देना होगा।

1. Entra ID (Azure AD) **App Registration** में Microsoft Graph **Application permissions** जोड़ें:
   - `ChannelMessage.Read.All` (चैनल अटैचमेंट + इतिहास)
   - `Chat.Read.All` या `ChatMessage.Read.All` (समूह चैट)
2. टेनेंट के लिए **admin consent** दें।
3. Teams ऐप **manifest version** बढ़ाएँ, पुनः अपलोड करें, और **Teams में ऐप पुनः इंस्टॉल करें**।
4. **Teams को पूरी तरह बंद कर पुनः खोलें** ताकि cached app metadata साफ़ हो।

## ज्ञात सीमाएँ

### Webhook टाइमआउट

Teams संदेशों को HTTP वेबहुक के माध्यम से डिलीवर करता है। यदि प्रोसेसिंग में बहुत समय लगता है (जैसे, धीमे LLM प्रतिक्रियाएँ), तो आप यह देख सकते हैं:

- Gateway टाइमआउट
- Teams द्वारा संदेश का पुनः प्रयास (डुप्लिकेट्स)
- ड्रॉप्ड उत्तर

OpenClaw जल्दी रिटर्न करके और proactive replies भेजकर इसे संभालता है, लेकिन बहुत धीमी प्रतिक्रियाएँ फिर भी समस्याएँ पैदा कर सकती हैं।

### फ़ॉर्मैटिंग

Teams markdown, Slack या Discord की तुलना में अधिक सीमित है:

- बुनियादी फ़ॉर्मैटिंग काम करती है: **bold**, _italic_, `code`, लिंक
- जटिल markdown (टेबल, nested lists) सही से रेंडर नहीं हो सकते
- पोल और arbitrary कार्ड भेजने के लिए Adaptive Cards समर्थित हैं (नीचे देखें)

## विन्यास

मुख्य सेटिंग्स (साझा चैनल पैटर्न के लिए `/gateway/configuration` देखें):

- `channels.msteams.enabled`: चैनल सक्षम/अक्षम।
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: बॉट क्रेडेंशियल्स।
- `channels.msteams.webhook.port` (डिफ़ॉल्ट `3978`)
- `channels.msteams.webhook.path` (डिफ़ॉल्ट `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (डिफ़ॉल्ट: pairing)
- `channels.msteams.allowFrom`: DMs के लिए allowlist (AAD ऑब्जेक्ट IDs, UPNs, या डिस्प्ले नाम)। विज़ार्ड सेटअप के दौरान नामों को IDs में रेज़ॉल्व करता है जब Graph एक्सेस उपलब्ध होता है।
- `channels.msteams.textChunkLimit`: आउटबाउंड टेक्स्ट chunk आकार।
- `channels.msteams.chunkMode`: `length` (डिफ़ॉल्ट) या `newline` ताकि लंबाई chunking से पहले खाली पंक्तियों (पैराग्राफ सीमाएँ) पर विभाजन हो।
- `channels.msteams.mediaAllowHosts`: इनबाउंड अटैचमेंट होस्ट्स के लिए allowlist (डिफ़ॉल्ट Microsoft/Teams डोमेन्स)।
- `channels.msteams.mediaAuthAllowHosts`: मीडिया retries पर Authorization headers जोड़ने के लिए allowlist (डिफ़ॉल्ट Graph + Bot Framework होस्ट्स)।
- `channels.msteams.requireMention`: चैनलों/समूहों में @mention आवश्यक (डिफ़ॉल्ट true)।
- `channels.msteams.replyStyle`: `thread | top-level` (देखें [Reply Style](#reply-style-threads-vs-posts))।
- `channels.msteams.teams.<teamId>
  .replyStyle`: प्रति-टीम ओवरराइड।`channels.msteams.teams.<teamId>
  .requireMention`: प्रति-टीम ओवरराइड।
- `channels.msteams.teams.<teamId>
  .tools`: डिफ़ॉल्ट प्रति-टीम टूल पॉलिसी ओवरराइड्स (`allow`/`deny`/`alsoAllow`), जब चैनल ओवरराइड मौजूद न हो।`channels.msteams.teams.<teamId>
  .toolsBySender`: डिफ़ॉल्ट प्रति-टीम प्रति-सेन्डर टूल पॉलिसी ओवरराइड्स (`"*"` वाइल्डकार्ड समर्थित)।
- `channels.msteams.teams.<teamId>
  .channels.<conversationId>
  .replyStyle`: प्रति-चैनल ओवरराइड।`channels.msteams.teams.<teamId>
  .channels.<conversationId>
  .requireMention`: प्रति-चैनल ओवरराइड।
- `channels.msteams.teams.<teamId>
  .channels.<conversationId>
  .tools`: प्रति-चैनल टूल पॉलिसी ओवरराइड्स (`allow`/`deny`/`alsoAllow`)।`channels.msteams.teams.<teamId>
  .channels.<conversationId>
  .toolsBySender`: प्रति-चैनल प्रति-सेन्डर टूल पॉलिसी ओवरराइड्स (`"*"` वाइल्डकार्ड समर्थित)।
- \`channels.msteams.teams.<teamId>.channels.<conversationId>**चैनल/ग्रुप्स:** अटैचमेंट्स M365 स्टोरेज (SharePoint/OneDrive) में रहते हैं।
- वेबहुक पेलोड में केवल एक HTML स्टब शामिल होता है, वास्तविक फ़ाइल बाइट्स नहीं।चैनल अटैचमेंट्स डाउनलोड करने के लिए **Graph API अनुमतियाँ आवश्यक** हैं।Graph अनुमतियों के बिना, इमेज वाले चैनल संदेश टेक्स्ट-ओनली के रूप में प्राप्त होंगे (इमेज कंटेंट बॉट के लिए सुलभ नहीं होगा)।
- डिफ़ॉल्ट रूप से, OpenClaw केवल Microsoft/Teams होस्टनेम्स से मीडिया डाउनलोड करता है।`channels.msteams.mediaAllowHosts` के साथ ओवरराइड करें (`["*"]` का उपयोग किसी भी होस्ट को अनुमति देने के लिए)।ऑथराइज़ेशन हेडर्स केवल `channels.msteams.mediaAuthAllowHosts` में सूचीबद्ध होस्ट्स के लिए जोड़े जाते हैं (डिफ़ॉल्ट रूप से Graph + Bot Framework होस्ट्स)।
- इस सूची को सख़्त रखें (मल्टी-टेनेंट सफ़िक्स से बचें)।बॉट्स FileConsentCard फ़्लो (बिल्ट-इन) का उपयोग करके DMs में फ़ाइलें भेज सकते हैं।हालाँकि, **ग्रुप चैट्स/चैनल्स में फ़ाइलें भेजने** के लिए अतिरिक्त सेटअप आवश्यक है:
- `channels.msteams.sharePointSiteId`: समूह चैट/चैनलों में फ़ाइल अपलोड के लिए SharePoint साइट ID (देखें [समूह चैट में फ़ाइल भेजना](#sending-files-in-group-chats))।

## Routing और Sessions

- Session keys मानक एजेंट फ़ॉर्मैट का पालन करते हैं (देखें [/concepts/session](/concepts/session)):
  - Direct messages मुख्य session साझा करते हैं (`agent:<agentId>:<mainKey>`)।
  - चैनल/समूह संदेश conversation id का उपयोग करते हैं:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Reply Style: Threads बनाम Posts

Teams ने हाल ही में एक ही अंतर्निहित डेटा मॉडल पर दो चैनल UI स्टाइल्स पेश की हैं:

| स्टाइल                                      | विवरण                                                     | अनुशंसित `replyStyle`                  |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------------------- |
| **Posts** (क्लासिक)      | संदेश कार्ड्स के रूप में दिखते हैं, नीचे threaded replies | `thread` (डिफ़ॉल्ट) |
| **Threads** (Slack-जैसा) | संदेश रैखिक रूप से बहते हैं, Slack जैसा                   | `top-level`                            |

**The problem:** The Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:

- Threads-स्टाइल चैनल में `thread` → replies अजीब तरह से nested दिखते हैं
- Posts-स्टाइल चैनल में `top-level` → replies thread में होने के बजाय अलग top-level posts के रूप में दिखते हैं

**समाधान:** चैनल के सेटअप के अनुसार प्रति-चैनल `replyStyle` कॉन्फ़िगर करें:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## अटैचमेंट्स और इमेज

**वर्तमान सीमाएँ:**

- **DMs:** Teams bot फ़ाइल APIs के माध्यम से इमेज और फ़ाइल अटैचमेंट काम करते हैं।
- **Channels/groups:** Attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Graph API permissions are required** to download channel attachments.

Without Graph permissions, channel messages with images will be received as text-only (the image content is not accessible to the bot).
By default, OpenClaw only downloads media from Microsoft/Teams hostnames. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).

## समूह चैट में फ़ाइल भेजना

Bots can send files in DMs using the FileConsentCard flow (built-in). However, **sending files in group chats/channels** requires additional setup:

| संदर्भ                                           | फ़ाइल कैसे भेजी जाती है                          | आवश्यक सेटअप                                |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------- |
| **DMs**                                          | FileConsentCard → उपयोगकर्ता स्वीकार → बॉट अपलोड | बॉक्स से बाहर काम करता है                   |
| **समूह चैट/चैनल**                                | SharePoint पर अपलोड → शेयर लिंक                  | `sharePointSiteId` + Graph अनुमतियाँ आवश्यक |
| **इमेज (किसी भी संदर्भ में)** | Base64-encoded inline                            | बॉक्स से बाहर काम करता है                   |

### समूह चैट को SharePoint की आवश्यकता क्यों

बॉट्स के पास व्यक्तिगत OneDrive ड्राइव नहीं होता (एप्लिकेशन पहचान के लिए `/me/drive` Graph API एंडपॉइंट काम नहीं करता)। ग्रुप चैट/चैनलों में फ़ाइलें भेजने के लिए, बॉट **SharePoint साइट** पर अपलोड करता है और एक शेयरिंग लिंक बनाता है।

### सेटअप

1. Entra ID (Azure AD) → App Registration में **Graph API अनुमतियाँ** जोड़ें:
   - `Sites.ReadWrite.All` (Application) - SharePoint पर फ़ाइल अपलोड
   - `Chat.Read.All` (Application) - वैकल्पिक, प्रति-उपयोगकर्ता sharing links सक्षम करता है

2. टेनेंट के लिए **admin consent** दें।

3. **अपना SharePoint साइट ID प्राप्त करें:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw कॉन्फ़िगर करें:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Sharing व्यवहार

| अनुमति                                  | Sharing व्यवहार                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| केवल `Sites.ReadWrite.All`              | संगठन-व्यापी sharing link (org का कोई भी सदस्य एक्सेस कर सकता है) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | प्रति-उपयोगकर्ता sharing link (केवल चैट सदस्य एक्सेस कर सकते हैं) |

प्रति-उपयोगकर्ता शेयरिंग अधिक सुरक्षित होती है क्योंकि केवल चैट प्रतिभागी ही फ़ाइल तक पहुँच सकते हैं। यदि `Chat.Read.All` अनुमति अनुपलब्ध है, तो बॉट संगठन-व्यापी शेयरिंग पर वापस चला जाता है।

### Fallback व्यवहार

| परिदृश्य                                        | परिणाम                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| समूह चैट + फ़ाइल + `sharePointSiteId` कॉन्फ़िगर | SharePoint पर अपलोड, sharing link भेजें                                           |
| समूह चैट + फ़ाइल + कोई `sharePointSiteId` नहीं  | OneDrive अपलोड का प्रयास (विफल हो सकता है), केवल टेक्स्ट भेजें |
| Personal चैट + फ़ाइल                            | FileConsentCard flow (SharePoint के बिना काम करता है)          |
| कोई भी संदर्भ + इमेज                            | Base64-encoded inline (SharePoint के बिना काम करता है)         |

### फ़ाइलों का संग्रह स्थान

अपलोड की गई फ़ाइलें कॉन्फ़िगर की गई SharePoint साइट की डिफ़ॉल्ट डॉक्यूमेंट लाइब्रेरी में `/OpenClawShared/` फ़ोल्डर में संग्रहीत होती हैं।

## Polls (Adaptive Cards)

OpenClaw Teams polls को Adaptive Cards के रूप में भेजता है (कोई native Teams poll API नहीं है)।

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- वोट्स Gateway द्वारा `~/.openclaw/msteams-polls.json` में रिकॉर्ड किए जाते हैं।
- वोट रिकॉर्ड करने के लिए Gateway का ऑनलाइन रहना आवश्यक है।
- Polls अभी स्वचालित रूप से परिणाम सारांश पोस्ट नहीं करते (आवश्यक होने पर store फ़ाइल देखें)।

## Adaptive Cards (arbitrary)

`message` टूल या CLI का उपयोग करके किसी भी Adaptive Card JSON को Teams उपयोगकर्ताओं या conversations में भेजें।

`card` पैरामीटर एक Adaptive Card JSON ऑब्जेक्ट स्वीकार करता है। जब `card` प्रदान किया जाता है, तो संदेश पाठ वैकल्पिक होता है।

**Agent tool:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

कार्ड स्कीमा और उदाहरणों के लिए [Adaptive Cards documentation](https://adaptivecards.io/) देखें। लक्ष्य फ़ॉर्मैट के विवरण के लिए नीचे [Target formats](#target-formats) देखें।

## Target formats

MSTeams targets उपयोगकर्ताओं और conversations में अंतर करने के लिए prefixes का उपयोग करते हैं:

| Target प्रकार                          | फ़ॉर्मैट                         | उदाहरण                                                                  |
| -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| User (ID द्वारा)    | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                             |
| User (नाम द्वारा)   | `user:<display-name>`            | `user:John Smith` (Graph API आवश्यक)                 |
| Group/channel                          | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (यदि `@thread` शामिल हो) |

**CLI उदाहरण:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Agent tool उदाहरण:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

नोट: `user:` प्रीफ़िक्स के बिना, नाम डिफ़ॉल्ट रूप से समूह/टीम रेज़ोल्यूशन पर जाते हैं। डिस्प्ले नाम से लोगों को लक्षित करते समय हमेशा `user:` का उपयोग करें।

## Proactive messaging

- Proactive संदेश केवल **उसके बाद** संभव हैं जब किसी उपयोगकर्ता ने इंटरैक्ट किया हो, क्योंकि उस समय हम conversation references सहेजते हैं।
- `/gateway/configuration` देखें, `dmPolicy` और allowlist gating के लिए।

## Team और Channel IDs (आम समस्या)

Teams URLs में `groupId` क्वेरी पैरामीटर वह टीम ID नहीं है जिसका उपयोग कॉन्फ़िगरेशन के लिए किया जाता है। इसके बजाय URL पाथ से IDs निकालें:

**Team URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**Channel URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Config के लिए:**

- Team ID = `/team/` के बाद का path segment (URL-decoded, जैसे `19:Bk4j...@thread.tacv2`)
- Channel ID = `/channel/` के बाद का path segment (URL-decoded)
- `groupId` query parameter को **अनदेखा** करें

## Private Channels

Private channels में बॉट्स का समर्थन सीमित है:

| फीचर                                            | Standard Channels | Private Channels                          |
| ----------------------------------------------- | ----------------- | ----------------------------------------- |
| Bot installation                                | हाँ               | सीमित                                     |
| Real-time messages (webhook) | हाँ               | काम न कर सकता है                          |
| RSC अनुमतियाँ                                   | हाँ               | अलग व्यवहार कर सकती हैं                   |
| @mentions                          | हाँ               | यदि बॉट सुलभ हो                           |
| Graph API history                               | हाँ               | हाँ (अनुमतियों के साथ) |

**यदि private channels काम न करें तो उपाय:**

1. बॉट इंटरैक्शन के लिए standard channels का उपयोग करें
2. DMs का उपयोग करें — उपयोगकर्ता हमेशा सीधे बॉट को संदेश भेज सकते हैं
3. ऐतिहासिक एक्सेस के लिए Graph API का उपयोग करें ( `ChannelMessage.Read.All` आवश्यक)

## समस्या-निवारण

### सामान्य समस्याएँ

- **चैनलों में इमेज नहीं दिख रहीं:** Graph अनुमतियाँ या एडमिन सहमति अनुपलब्ध। Teams ऐप को पुनः इंस्टॉल करें और Teams को पूरी तरह से बंद करके दोबारा खोलें।
- **चैनल में कोई प्रतिक्रिया नहीं:** डिफ़ॉल्ट रूप से mentions आवश्यक हैं; `channels.msteams.requireMention=false` सेट करें या प्रति टीम/चैनल कॉन्फ़िगर करें।
- **Version mismatch (Teams अभी भी पुराना manifest दिखाता है):** ऐप हटाएँ + फिर से जोड़ें और Teams को पूरी तरह बंद करें।
- **वेबहुक से 401 Unauthorized:** Azure JWT के बिना मैन्युअल परीक्षण करते समय अपेक्षित—इसका मतलब एंडपॉइंट पहुँचा जा सकता है लेकिन प्रमाणीकरण विफल हुआ। सही तरीके से परीक्षण करने के लिए Azure Web Chat का उपयोग करें।

### Manifest अपलोड त्रुटियाँ

- **"Icon file cannot be empty":** मैनिफ़ेस्ट उन आइकन फ़ाइलों को संदर्भित करता है जिनका आकार 0 बाइट है। मान्य PNG आइकन बनाएँ (`outline.png` के लिए 32x32, `color.png` के लिए 192x192)।
- **"webApplicationInfo.Id already in use":** ऐप अभी भी किसी अन्य टीम/चैट में इंस्टॉल है। पहले उसे खोजकर अनइंस्टॉल करें, या प्रसार के लिए 5–10 मिनट प्रतीक्षा करें।
- **अपलोड पर "Something went wrong":** इसके बजाय [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) के माध्यम से अपलोड करें, ब्राउज़र DevTools (F12) → Network टैब खोलें, और वास्तविक त्रुटि के लिए response body देखें।
- **Sideload विफल:** "Upload a custom app" की बजाय "Upload an app to your org's app catalog" आज़माएँ — यह अक्सर sideload प्रतिबंधों को बायपास कर देता है।

### RSC अनुमतियाँ काम नहीं कर रहीं

1. सुनिश्चित करें कि `webApplicationInfo.id` आपके बॉट के App ID से बिल्कुल मेल खाता है
2. ऐप पुनः अपलोड करें और टीम/चैट में पुनः इंस्टॉल करें
3. जाँचें कि आपकी org admin ने RSC अनुमतियाँ ब्लॉक तो नहीं की हैं
4. सही scope का उपयोग सुनिश्चित करें: teams के लिए `ChannelMessage.Read.Group`, समूह चैट के लिए `ChatMessage.Read.Chat`

## संदर्भ

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot सेटअप गाइड
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - Teams ऐप्स बनाएँ/प्रबंधित करें
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (चैनल/समूह के लिए Graph आवश्यक)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
