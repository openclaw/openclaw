---
summary: "Microsoft Teams بوٹ سپورٹ کی حیثیت، صلاحیتیں، اور کنفیگریشن"
read_when:
  - MS Teams چینل کی خصوصیات پر کام کرتے وقت
title: "Microsoft Teams"
---

# Microsoft Teams (پلگ اِن)

> "اے داخل ہونے والو، تمام امید چھوڑ دو۔"

اپ ڈیٹ: 2026-01-21

اسٹیٹس: متن + DM اٹیچمنٹس سپورٹڈ ہیں؛ چینل/گروپ فائل بھیجنے کے لیے `sharePointSiteId` + Graph اجازتیں درکار ہیں (دیکھیں [Sending files in group chats](#sending-files-in-group-chats))۔ پولز Adaptive Cards کے ذریعے بھیجے جاتے ہیں۔

## پلگ اِن درکار ہے

Microsoft Teams ایک پلگ اِن کے طور پر فراہم کیا جاتا ہے اور کور انسٹال میں شامل نہیں۔

**Breaking change (2026.1.15):** MS Teams moved out of core. اگر آپ اسے استعمال کرتے ہیں تو آپ کو پلگ اِن انسٹال کرنا ہوگا۔

وجہ: اس سے کور انسٹال ہلکا رہتا ہے اور MS Teams کی dependencies آزادانہ طور پر اپ ڈیٹ ہو سکتی ہیں۔

CLI کے ذریعے انسٹال کریں (npm رجسٹری):

```bash
openclaw plugins install @openclaw/msteams
```

لوکل چیک آؤٹ (جب git repo سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/msteams
```

اگر کنفیگریشن/آن بورڈنگ کے دوران Teams منتخب کیا جائے اور git چیک آؤٹ موجود ہو،
تو OpenClaw خودکار طور پر لوکل انسٹال راستہ پیش کرے گا۔

تفصیلات: [Plugins](/tools/plugin)

## فوری سیٹ اپ (مبتدی)

1. Microsoft Teams پلگ اِن انسٹال کریں۔
2. ایک **Azure Bot** بنائیں (App ID + client secret + tenant ID)۔
3. ان اسناد کے ساتھ OpenClaw کنفیگر کریں۔
4. `/api/messages` (بطورِ طے شدہ پورٹ 3978) کو کسی عوامی URL یا ٹنل کے ذریعے ایکسپوز کریں۔
5. Teams ایپ پیکیج انسٹال کریں اور گیٹ وے شروع کریں۔

کم از کم کنفیگ:

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

نوٹ: گروپ چیٹس بطورِ ڈیفالٹ بلاک ہوتی ہیں (`channels.msteams.groupPolicy: "allowlist"`)۔ گروپ جوابات کی اجازت دینے کے لیے `channels.msteams.groupAllowFrom` سیٹ کریں (یا `groupPolicy: "open"` استعمال کریں تاکہ کسی بھی ممبر کو اجازت ہو، مینشَن کی شرط کے ساتھ)۔

## اہداف

- Teams DMs، گروپ چیٹس، یا چینلز کے ذریعے OpenClaw سے بات چیت۔
- روٹنگ کو متعین رکھنا: جوابات ہمیشہ اسی چینل پر واپس جائیں جہاں سے آئے ہوں۔
- محفوظ چینل رویہ بطورِ طے شدہ (جب تک کنفیگر نہ کیا جائے، mentions درکار)۔

## کنفیگ لکھائی

بطورِ طے شدہ، Microsoft Teams کو `/config set|unset` کے ذریعے متحرک ہونے والی کنفیگ اپ ڈیٹس لکھنے کی اجازت ہے (درکار: `commands.config: true`)۔

غیرفعال کرنے کے لیے:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## رسائی کا کنٹرول (DMs + گروپس)

**DM رسائی**

- ڈیفالٹ: `channels.msteams.dmPolicy = "pairing"`۔ نامعلوم بھیجنے والوں کو منظوری تک نظرانداز کیا جاتا ہے۔
- `channels.msteams.allowFrom` AAD آبجیکٹ IDs، UPNs، یا ڈسپلے نام قبول کرتا ہے۔ جب کریڈینشلز اجازت دیں تو وزرڈ Microsoft Graph کے ذریعے ناموں کو IDs میں تبدیل کرتا ہے۔

**گروپ رسائی**

- ڈیفالٹ: `channels.msteams.groupPolicy = "allowlist"` (جب تک آپ `groupAllowFrom` شامل نہ کریں، بلاکڈ)۔ جب ڈیفالٹ سیٹ نہ ہو تو اسے اووررائیڈ کرنے کے لیے `channels.defaults.groupPolicy` استعمال کریں۔
- `channels.msteams.groupAllowFrom` کنٹرول کرتا ہے کہ گروپ چیٹس/چینلز میں کون ٹرگر کر سکتا ہے (بیک اپ `channels.msteams.allowFrom`)۔
- کسی بھی رکن کو اجازت دینے کے لیے `groupPolicy: "open"` سیٹ کریں (ابھی بھی بطورِ طے شدہ mention‑gated)۔
- **کوئی چینل اجازت نہ دینے** کے لیے `channels.msteams.groupPolicy: "disabled"` سیٹ کریں۔

مثال:

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

**Teams + چینل اجازت فہرست**

- `channels.msteams.teams` کے تحت ٹیمز اور چینلز کی فہرست دے کر گروپ/چینل جوابات محدود کریں۔
- کلیدیں ٹیم IDs یا نام ہو سکتی ہیں؛ چینل کلیدیں گفتگو IDs یا نام ہو سکتی ہیں۔
- جب `groupPolicy="allowlist"` اور ٹیمز اجازت فہرست موجود ہو تو صرف درج ٹیمز/چینلز قبول کیے جاتے ہیں (mention‑gated)۔
- کنفیگر وزارڈ `Team/Channel` اندراجات قبول کرتا ہے اور انہیں محفوظ کر دیتا ہے۔
- اسٹارٹ اپ پر OpenClaw ٹیم/چینل اور صارف اجازت فہرست کے نام IDs میں حل کرتا ہے (جب Graph اجازتیں ہوں)
  اور میپنگ لاگ کرتا ہے؛ غیر حل شدہ اندراجات جوں کے توں رہتے ہیں۔

مثال:

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

## یہ کیسے کام کرتا ہے

1. Microsoft Teams پلگ اِن انسٹال کریں۔
2. ایک **Azure Bot** بنائیں (App ID + secret + tenant ID)۔
3. ایک **Teams ایپ پیکیج** بنائیں جو بوٹ کا حوالہ دے اور ذیل میں دی گئی RSC اجازتیں شامل کرے۔
4. Teams ایپ کو کسی ٹیم میں اپ لوڈ/انسٹال کریں (یا DMs کے لیے ذاتی اسکوپ)۔
5. `msteams` کو `~/.openclaw/openclaw.json` میں (یا env vars کے ذریعے) کنفیگر کریں اور گیٹ وے شروع کریں۔
6. گیٹ وے بطورِ طے شدہ `/api/messages` پر Bot Framework webhook ٹریفک سنتا ہے۔

## Azure Bot سیٹ اپ (پیشگی تقاضے)

OpenClaw کنفیگر کرنے سے پہلے، آپ کو Azure Bot ریسورس بنانا ہوگا۔

### مرحلہ 1: Azure Bot بنائیں

1. جائیں: [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. **Basics** ٹیب بھریں:

   | فیلڈ               | قدر                                                                              |
   | ------------------ | -------------------------------------------------------------------------------- |
   | **Bot handle**     | آپ کے بوٹ کا نام، مثلاً `openclaw-msteams` (منفرد ہونا چاہیے) |
   | **Subscription**   | اپنی Azure سبسکرپشن منتخب کریں                                                   |
   | **Resource group** | نیا بنائیں یا موجودہ استعمال کریں                                                |
   | **Pricing tier**   | **Free** (ڈیولپمنٹ/ٹیسٹنگ کے لیے)                             |
   | **Type of App**    | **Single Tenant** (سفارش کردہ — نیچے نوٹ دیکھیں)              |
   | **Creation type**  | **Create new Microsoft App ID**                                                  |

> **ڈیپریکیشن نوٹس:** نئے ملٹی ٹیننٹ بوٹس کی تخلیق 2025-07-31 کے بعد ڈیپریکیٹ کر دی گئی ہے۔ نئے بوٹس کے لیے **سنگل ٹیننٹ** استعمال کریں۔

3. **Review + create** → **Create** پر کلک کریں (تقریباً 1–2 منٹ انتظار کریں)

### مرحلہ 2: اسناد حاصل کریں

1. اپنے Azure Bot ریسورس → **Configuration**
2. **Microsoft App ID** کاپی کریں → یہی آپ کا `appId` ہے
3. **Manage Password** پر کلک کریں → App Registration پر جائیں
4. **Certificates & secrets** → **New client secret** → **Value** کاپی کریں → یہی آپ کا `appPassword` ہے
5. **Overview** → **Directory (tenant) ID** کاپی کریں → یہی آپ کا `tenantId` ہے

### مرحلہ 3: میسجنگ اینڈ پوائنٹ کنفیگر کریں

1. Azure Bot → **Configuration**
2. **Messaging endpoint** اپنے webhook URL پر سیٹ کریں:
   - پروڈکشن: `https://your-domain.com/api/messages`
   - لوکل ڈیولپمنٹ: ٹنل استعمال کریں (نیچے [Local Development](#local-development-tunneling) دیکھیں)

### مرحلہ 4: Teams چینل فعال کریں

1. Azure Bot → **Channels**
2. **Microsoft Teams** → Configure → Save
3. Terms of Service قبول کریں

## لوکل ڈیولپمنٹ (ٹنلنگ)

Teams `localhost` تک رسائی حاصل نہیں کر سکتا۔ لوکل ڈیولپمنٹ کے لیے ٹنل استعمال کریں:

**آپشن A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**آپشن B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (متبادل)

مینفیسٹ ZIP دستی طور پر بنانے کے بجائے، آپ [Teams Developer Portal](https://dev.teams.microsoft.com/apps) استعمال کر سکتے ہیں:

1. **+ New app** پر کلک کریں
2. بنیادی معلومات بھریں (نام، وضاحت، ڈیولپر معلومات)
3. **App features** → **Bot** پر جائیں
4. **Enter a bot ID manually** منتخب کریں اور Azure Bot App ID پیسٹ کریں
5. اسکوپس چیک کریں: **Personal**, **Team**, **Group Chat**
6. **Distribute** → **Download app package**
7. Teams میں: **Apps** → **Manage your apps** → **Upload a custom app** → ZIP منتخب کریں

یہ اکثر JSON منیفیسٹ ہاتھ سے ایڈٹ کرنے سے آسان ہوتا ہے۔

## بوٹ کی جانچ

**آپشن A: Azure Web Chat (پہلے webhook کی تصدیق کریں)**

1. Azure Portal → آپ کا Azure Bot ریسورس → **Test in Web Chat**
2. پیغام بھیجیں — جواب نظر آنا چاہیے
3. اس سے تصدیق ہوتی ہے کہ webhook اینڈ پوائنٹ Teams سیٹ اپ سے پہلے کام کر رہا ہے

**آپشن B: Teams (ایپ انسٹال ہونے کے بعد)**

1. Teams ایپ انسٹال کریں (sideload یا org catalog)
2. Teams میں بوٹ تلاش کریں اور DM بھیجیں
3. گیٹ وے لاگز میں آنے والی سرگرمی چیک کریں

## سیٹ اپ (کم از کم متن‑صرف)

1. **Microsoft Teams پلگ اِن انسٹال کریں**
   - npm سے: `openclaw plugins install @openclaw/msteams`
   - لوکل چیک آؤٹ سے: `openclaw plugins install ./extensions/msteams`

2. **بوٹ رجسٹریشن**
   - Azure Bot بنائیں (اوپر دیکھیں) اور نوٹ کریں:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

3. **Teams ایپ منیفیسٹ**
   - `bot` اندراج شامل کریں جس میں `botId = <App ID>` ہو۔
   - اسکوپس: `personal`, `team`, `groupChat`۔
   - `supportsFiles: true` (ذاتی اسکوپ فائل ہینڈلنگ کے لیے درکار)۔
   - RSC اجازتیں شامل کریں (ذیل میں)۔
   - آئیکنز بنائیں: `outline.png` (32x32) اور `color.png` (192x192)۔
   - تینوں فائلیں ایک ساتھ zip کریں: `manifest.json`, `outline.png`, `color.png`۔

4. **OpenClaw کنفیگر کریں**

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

   آپ کنفیگ کیز کے بجائے ماحولیاتی متغیرات بھی استعمال کر سکتے ہیں:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **بوٹ اینڈ پوائنٹ**
   - Azure Bot Messaging Endpoint سیٹ کریں:
     - `https://<host>:3978/api/messages` (یا منتخب کردہ راستہ/پورٹ)۔

6. **گیٹ وے چلائیں**
   - پلگ اِن انسٹال ہونے اور `msteams` کنفیگ موجود ہونے پر Teams چینل خودکار طور پر شروع ہو جاتا ہے۔

## ہسٹری سیاق

- `channels.msteams.historyLimit` کنٹرول کرتا ہے کہ حالیہ چینل/گروپ پیغامات میں سے کتنے پرامپٹ میں شامل ہوں۔
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).
- DM history can be limited with `channels.msteams.dmHistoryLimit` (user turns). Per-user overrides: `channels.msteams.dms["<user_id>"].historyLimit`.

## موجودہ Teams RSC اجازتیں (منیفیسٹ)

These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team/chat where the app is installed.

**چینلز کے لیے (ٹیم اسکوپ):**

- `ChannelMessage.Read.Group` (Application) — بغیر @mention تمام چینل پیغامات وصول کریں
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**گروپ چیٹس کے لیے:**

- `ChatMessage.Read.Chat` (Application) — بغیر @mention تمام گروپ چیٹ پیغامات وصول کریں

## مثال Teams منیفیسٹ (redacted)

Minimal, valid example with the required fields. Replace IDs and URLs.

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

### منیفیسٹ احتیاطیں (لازمی فیلڈز)

- `bots[].botId` **لازم** Azure Bot App ID سے مماثل ہو۔
- `webApplicationInfo.id` **لازم** Azure Bot App ID سے مماثل ہو۔
- `bots[].scopes` میں وہ سطحیں شامل ہوں جو آپ استعمال کرنے کا ارادہ رکھتے ہیں (`personal`, `team`, `groupChat`)۔
- `bots[].supportsFiles: true` ذاتی اسکوپ میں فائل ہینڈلنگ کے لیے درکار ہے۔
- `authorization.permissions.resourceSpecific` میں چینل read/send شامل ہونا چاہیے اگر چینل ٹریفک چاہتے ہیں۔

### موجودہ ایپ کو اپ ڈیٹ کرنا

پہلے سے انسٹال شدہ Teams ایپ کو اپ ڈیٹ کرنے کے لیے (مثلاً RSC اجازتیں شامل کرنا):

1. اپنی `manifest.json` نئی سیٹنگز کے ساتھ اپ ڈیٹ کریں
2. **`version` فیلڈ میں اضافہ کریں** (مثلاً `1.0.0` → `1.1.0`)
3. آئیکنز کے ساتھ منیفیسٹ **دوبارہ zip** کریں (`manifest.json`, `outline.png`, `color.png`)
4. نئی zip اپ لوڈ کریں:
   - **آپشن A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → اپنی ایپ تلاش کریں → Upload new version
   - **آپشن B (Sideload):** Teams → Apps → Manage your apps → Upload a custom app
5. **ٹیم چینلز کے لیے:** نئی اجازتوں کے اطلاق کے لیے ہر ٹیم میں ایپ دوبارہ انسٹال کریں
6. **Teams کو مکمل طور پر بند کر کے دوبارہ کھولیں** (صرف ونڈو بند کرنا کافی نہیں) تاکہ کیشڈ میٹا ڈیٹا صاف ہو

## صلاحیتیں: صرف RSC بمقابلہ Graph

### **صرف Teams RSC** کے ساتھ (ایپ انسٹال، Graph API اجازتیں نہیں)

کام کرتا ہے:

- چینل پیغام **متن** پڑھنا۔
- چینل پیغام **متن** بھیجنا۔
- **ذاتی (DM)** فائل اٹیچمنٹس وصول کرنا۔

کام نہیں کرتا:

- چینل/گروپ **تصاویر یا فائل مواد** (payload میں صرف HTML stub ہوتا ہے)۔
- SharePoint/OneDrive میں محفوظ اٹیچمنٹس ڈاؤن لوڈ کرنا۔
- پیغام ہسٹری پڑھنا (لائیو webhook ایونٹ سے آگے)۔

### **Teams RSC + Microsoft Graph Application اجازتیں** کے ساتھ

اضافہ ہوتا ہے:

- ہوسٹڈ مواد (پیغامات میں پیسٹ کی گئی تصاویر) ڈاؤن لوڈ کرنا۔
- SharePoint/OneDrive میں محفوظ فائل اٹیچمنٹس ڈاؤن لوڈ کرنا۔
- Graph کے ذریعے چینل/چیٹ پیغام ہسٹری پڑھنا۔

### RSC بمقابلہ Graph API

| صلاحیت                | RSC اجازتیں                               | Graph API                                          |
| --------------------- | ----------------------------------------- | -------------------------------------------------- |
| **ریئل ٹائم پیغامات** | ہاں (webhook کے ذریعے) | نہیں (صرف polling)              |
| **تاریخی پیغامات**    | نہیں                                      | ہاں (ہسٹری کوئری کی جا سکتی ہے) |
| **سیٹ اپ پیچیدگی**    | صرف ایپ منیفیسٹ                           | ایڈمن رضامندی + ٹوکن فلو درکار                     |
| **آف لائن کام**       | نہیں (چلنا ضروری)      | ہاں (کسی بھی وقت کوئری)         |

**Bottom line:** RSC is for real-time listening; Graph API is for historical access. For catching up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## Graph فعال میڈیا + ہسٹری (چینلز کے لیے درکار)

اگر آپ **چینلز** میں تصاویر/فائلیں چاہتے ہیں یا **پیغام ہسٹری** حاصل کرنا چاہتے ہیں، تو Microsoft Graph اجازتیں فعال کریں اور ایڈمن رضامندی دیں۔

1. Entra ID (Azure AD) **App Registration** میں Microsoft Graph **Application permissions** شامل کریں:
   - `ChannelMessage.Read.All` (چینل اٹیچمنٹس + ہسٹری)
   - `Chat.Read.All` یا `ChatMessage.Read.All` (گروپ چیٹس)
2. ٹیننٹ کے لیے **Grant admin consent** کریں۔
3. Teams ایپ **منیفیسٹ ورژن** بڑھائیں، دوبارہ اپ لوڈ کریں، اور **Teams میں ایپ دوبارہ انسٹال کریں**۔
4. **Teams کو مکمل طور پر بند کر کے دوبارہ کھولیں** تاکہ کیشڈ میٹا ڈیٹا صاف ہو۔

## معلوم حدود

### Webhook ٹائم آؤٹس

Teams delivers messages via HTTP webhook. If processing takes too long (e.g., slow LLM responses), you may see:

- گیٹ وے ٹائم آؤٹس
- Teams کی طرف سے پیغام دوبارہ بھیجنا (ڈپلیکیٹس)
- جوابات کا گر جانا

OpenClaw تیزی سے جواب واپس کر کے proactive طور پر جوابات بھیجتا ہے، مگر بہت سست ردِعمل پھر بھی مسائل پیدا کر سکتا ہے۔

### فارمیٹنگ

Teams کا markdown Slack یا Discord سے زیادہ محدود ہے:

- بنیادی فارمیٹنگ کام کرتی ہے: **bold**, _italic_, `code`, لنکس
- پیچیدہ markdown (ٹیبلز، نیسٹڈ لسٹس) درست رینڈر نہیں ہو سکتیں
- پولز اور کسی بھی کارڈ بھیجنے کے لیے Adaptive Cards سپورٹڈ ہیں (نیچے دیکھیں)

## کنفیگریشن

اہم سیٹنگز (مشترکہ چینل پیٹرنز کے لیے `/gateway/configuration` دیکھیں):

- `channels.msteams.enabled`: چینل فعال/غیرفعال کریں۔
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: بوٹ اسناد۔
- `channels.msteams.webhook.port` (ڈیفالٹ `3978`)
- `channels.msteams.webhook.path` (ڈیفالٹ `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (ڈیفالٹ: pairing)
- `channels.msteams.allowFrom`: allowlist for DMs (AAD object IDs, UPNs, or display names). The wizard resolves names to IDs during setup when Graph access is available.
- `channels.msteams.textChunkLimit`: آؤٹ باؤنڈ متن چنک سائز۔
- `channels.msteams.chunkMode`: `length` (ڈیفالٹ) یا `newline` تاکہ لمبائی کے حساب سے چنک کرنے سے پہلے خالی لائنوں (پیراگراف حدود) پر تقسیم کیا جائے۔
- `channels.msteams.mediaAllowHosts`: اِن باؤنڈ اٹیچمنٹ ہوسٹس کے لیے اجازت فہرست (ڈیفالٹ Microsoft/Teams ڈومینز)۔
- `channels.msteams.mediaAuthAllowHosts`: میڈیا ریٹرائز پر Authorization ہیڈرز لگانے کے لیے اجازت فہرست (ڈیفالٹ Graph + Bot Framework ہوسٹس)۔
- `channels.msteams.requireMention`: چینلز/گروپس میں @mention درکار (ڈیفالٹ true)۔
- `channels.msteams.replyStyle`: `thread | top-level` (دیکھیں [Reply Style](#reply-style-threads-vs-posts))۔
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.sharePointSiteId`: گروپ چیٹس/چینلز میں فائل اپ لوڈز کے لیے SharePoint سائٹ ID (دیکھیں [گروپ چیٹس میں فائلیں بھیجنا](#sending-files-in-group-chats))۔

## روٹنگ اور سیشنز

- سیشن کیز معیاری ایجنٹ فارمیٹ کی پیروی کرتی ہیں (دیکھیں [/concepts/session](/concepts/session)):
  - براہِ راست پیغامات مرکزی سیشن شیئر کرتے ہیں (`agent:<agentId>:<mainKey>`)۔
  - چینل/گروپ پیغامات گفتگو ID استعمال کرتے ہیں:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## جواب دینے کا انداز: Threads بمقابلہ Posts

Teams نے حال ہی میں ایک ہی بنیادی ڈیٹا ماڈل پر دو چینل UI اسٹائل متعارف کرائے ہیں:

| انداز                                       | وضاحت                                         | سفارش کردہ `replyStyle`              |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| **Posts** (کلاسک)        | پیغامات کارڈز کی صورت میں، نیچے تھریڈڈ جوابات | `thread` (ڈیفالٹ) |
| **Threads** (Slack جیسے) | پیغامات سیدھی لائن میں، Slack کی طرح          | `top-level`                          |

**The problem:** The Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:

- Threads اسٹائل چینل میں `thread` → جوابات عجیب طرح نیسٹ ہو جاتے ہیں
- Posts اسٹائل چینل میں `top-level` → جوابات الگ ٹاپ‑لیول پوسٹس کے طور پر نظر آتے ہیں

**حل:** چینل کے سیٹ اپ کے مطابق فی چینل `replyStyle` کنفیگر کریں:

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

## اٹیچمنٹس اور تصاویر

**موجودہ حدود:**

- **DMs:** تصاویر اور فائل اٹیچمنٹس Teams بوٹ فائل APIs کے ذریعے کام کرتے ہیں۔
- **Channels/groups:** Attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Graph API permissions are required** to download channel attachments.

Without Graph permissions, channel messages with images will be received as text-only (the image content is not accessible to the bot).
By default, OpenClaw only downloads media from Microsoft/Teams hostnames. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).

## گروپ چیٹس میں فائلیں بھیجنا

Bots can send files in DMs using the FileConsentCard flow (built-in). However, **sending files in group chats/channels** requires additional setup:

| سیاق                                         | فائل کیسے بھیجی جاتی ہے                  | درکار سیٹ اپ                             |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| **DMs**                                      | FileConsentCard → صارف قبول → بوٹ اپ لوڈ | بغیر کسی اضافے کے کام کرتا ہے            |
| **گروپ چیٹس/چینلز**                          | SharePoint پر اپ لوڈ → شیئر لنک          | `sharePointSiteId` + Graph اجازتیں درکار |
| **تصاویر (کسی بھی سیاق)** | Base64-encoded inline                    | بغیر کسی اضافے کے کام کرتا ہے            |

### گروپ چیٹس کو SharePoint کیوں درکار ہے

Bots don't have a personal OneDrive drive (the `/me/drive` Graph API endpoint doesn't work for application identities). To send files in group chats/channels, the bot uploads to a **SharePoint site** and creates a sharing link.

### سیٹ اپ

1. Entra ID (Azure AD) → App Registration میں **Graph API اجازتیں** شامل کریں:
   - `Sites.ReadWrite.All` (Application) — SharePoint پر فائلیں اپ لوڈ کرنے کے لیے
   - `Chat.Read.All` (Application) — اختیاری، فی صارف شیئرنگ لنکس فعال کرتا ہے

2. ٹیننٹ کے لیے **Grant admin consent** کریں۔

3. **اپنی SharePoint سائٹ ID حاصل کریں:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw کنفیگر کریں:**

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

### شیئرنگ رویہ

| اجازت                                   | شیئرنگ رویہ                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| صرف `Sites.ReadWrite.All`               | تنظیم بھر میں شیئرنگ لنک (تنظیم کے کسی بھی فرد کے لیے قابلِ رسائی) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | فی صارف شیئرنگ لنک (صرف چیٹ ممبرز کے لیے)                          |

Per-user sharing is more secure as only the chat participants can access the file. If `Chat.Read.All` permission is missing, the bot falls back to organization-wide sharing.

### فال بیک رویہ

| منظرنامہ                                     | نتیجہ                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| گروپ چیٹ + فائل + `sharePointSiteId` کنفیگرڈ | SharePoint پر اپ لوڈ، شیئرنگ لنک بھیجا جاتا ہے                            |
| گروپ چیٹ + فائل + `sharePointSiteId` نہیں    | OneDrive اپ لوڈ کی کوشش (ناکام ہو سکتی ہے)، صرف متن    |
| ذاتی چیٹ + فائل                              | FileConsentCard فلو (SharePoint کے بغیر کام کرتا ہے)   |
| کوئی بھی سیاق + تصویر                        | Base64-encoded inline (SharePoint کے بغیر کام کرتا ہے) |

### فائلوں کے محفوظ ہونے کی جگہ

اپ لوڈ کی گئی فائلیں کنفیگر شدہ SharePoint سائٹ کی ڈیفالٹ ڈاکیومنٹ لائبریری میں `/OpenClawShared/` فولڈر میں محفوظ ہوتی ہیں۔

## پولز (Adaptive Cards)

OpenClaw Teams پولز کو Adaptive Cards کے طور پر بھیجتا ہے (Teams میں نیٹو پول API موجود نہیں)۔

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- ووٹس گیٹ وے کے ذریعے `~/.openclaw/msteams-polls.json` میں ریکارڈ ہوتے ہیں۔
- ووٹس ریکارڈ کرنے کے لیے گیٹ وے کا آن لائن رہنا ضروری ہے۔
- پولز خودکار طور پر نتائج کا خلاصہ پوسٹ نہیں کرتے (ضرورت ہو تو اسٹور فائل دیکھیں)۔

## Adaptive Cards (من مانے)

`message` ٹول یا CLI استعمال کرتے ہوئے کسی بھی Adaptive Card JSON کو Teams صارفین یا گفتگوؤں کو بھیجیں۔

The `card` parameter accepts an Adaptive Card JSON object. When `card` is provided, the message text is optional.

**ایجنٹ ٹول:**

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

See [Adaptive Cards documentation](https://adaptivecards.io/) for card schema and examples. For target format details, see [Target formats](#target-formats) below.

## Target formats

MSTeams اہداف صارفین اور گفتگوؤں میں فرق کرنے کے لیے prefixes استعمال کرتے ہیں:

| ہدف کی قسم                             | فارمیٹ                           | مثال                                                                   |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| صارف (ID کے ذریعے)  | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                            |
| صارف (نام کے ذریعے) | `user:<display-name>`            | `user:John Smith` (Graph API درکار)                 |
| گروپ/چینل                              | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                               |
| گروپ/چینل (raw)     | `<conversation-id>`              | `19:abc123...@thread.tacv2` (اگر `@thread` شامل ہو) |

**CLI مثالیں:**

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

**ایجنٹ ٹول مثالیں:**

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

Note: Without the `user:` prefix, names default to group/team resolution. Always use `user:` when targeting people by display name.

## Proactive میسجنگ

- Proactive پیغامات صرف **اس کے بعد** ممکن ہیں جب صارف نے تعامل کیا ہو، کیونکہ ہم اس وقت گفتگو کے حوالہ جات محفوظ کرتے ہیں۔
- `/gateway/configuration` دیکھیں برائے `dmPolicy` اور اجازت فہرست گیٹنگ۔

## ٹیم اور چینل IDs (عام غلطی)

The `groupId` query parameter in Teams URLs is **NOT** the team ID used for configuration. Extract IDs from the URL path instead:

**ٹیم URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**چینل URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**کنفیگ کے لیے:**

- ٹیم ID = `/team/` کے بعد والا پاتھ سیگمنٹ (URL-decoded، مثلاً `19:Bk4j...@thread.tacv2`)
- چینل ID = `/channel/` کے بعد والا پاتھ سیگمنٹ (URL-decoded)
- `groupId` کوئری پیرامیٹر کو **نظر انداز** کریں

## پرائیویٹ چینلز

پرائیویٹ چینلز میں بوٹس کی سپورٹ محدود ہے:

| خصوصیت                                         | معیاری چینلز | پرائیویٹ چینلز                           |
| ---------------------------------------------- | ------------ | ---------------------------------------- |
| بوٹ انسٹالیشن                                  | ہاں          | محدود                                    |
| ریئل ٹائم پیغامات (webhook) | ہاں          | ممکن ہے کام نہ کرے                       |
| RSC اجازتیں                                    | ہاں          | مختلف رویہ ہو سکتا ہے                    |
| @mentions                         | ہاں          | اگر بوٹ قابلِ رسائی ہو                   |
| Graph API ہسٹری                                | ہاں          | ہاں (اجازتوں کے ساتھ) |

**اگر پرائیویٹ چینلز کام نہ کریں تو حل:**

1. بوٹ تعاملات کے لیے معیاری چینلز استعمال کریں
2. DMs استعمال کریں — صارفین ہمیشہ بوٹ کو براہِ راست پیغام بھیج سکتے ہیں
3. تاریخی رسائی کے لیے Graph API استعمال کریں (درکار: `ChannelMessage.Read.All`)

## خرابیوں کا ازالہ

### عام مسائل

- **Images not showing in channels:** Graph permissions or admin consent missing. Reinstall the Teams app and fully quit/reopen Teams.
- **چینل میں کوئی جواب نہیں:** بطورِ طے شدہ mentions درکار ہیں؛ `channels.msteams.requireMention=false` سیٹ کریں یا فی ٹیم/چینل کنفیگر کریں۔
- **ورژن عدم مطابقت (Teams پرانا منیفیسٹ دکھا رہا ہے):** ایپ ہٹائیں اور دوبارہ شامل کریں، پھر Teams کو مکمل طور پر بند کریں۔
- **401 Unauthorized from webhook:** Expected when testing manually without Azure JWT - means endpoint is reachable but auth failed. Use Azure Web Chat to test properly.

### منیفیسٹ اپ لوڈ کی غلطیاں

- **"Icon file cannot be empty":** The manifest references icon files that are 0 bytes. Create valid PNG icons (32x32 for `outline.png`, 192x192 for `color.png`).
- **"webApplicationInfo.Id already in use":** The app is still installed in another team/chat. Find and uninstall it first, or wait 5-10 minutes for propagation.
- **"Something went wrong" اپ لوڈ پر:** اس کے بجائے [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) کے ذریعے اپ لوڈ کریں، براؤزر DevTools (F12) → Network ٹیب کھولیں، اور اصل ایرر کے لیے response body دیکھیں۔
- **Sideload ناکام:** "Upload a custom app" کے بجائے "Upload an app to your org's app catalog" آزمائیں — یہ اکثر پابندیاں بائی پاس کر دیتا ہے۔

### RSC اجازتیں کام نہیں کر رہیں

1. تصدیق کریں کہ `webApplicationInfo.id` آپ کے بوٹ کے App ID سے بالکل مماثل ہے
2. ایپ دوبارہ اپ لوڈ کریں اور ٹیم/چیٹ میں دوبارہ انسٹال کریں
3. چیک کریں کہ آپ کے org ایڈمن نے RSC اجازتیں بلاک تو نہیں کیں
4. درست اسکوپ کی تصدیق کریں: ٹیمز کے لیے `ChannelMessage.Read.Group`, گروپ چیٹس کے لیے `ChatMessage.Read.Chat`

## مراجع

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) — Azure Bot سیٹ اپ گائیڈ
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) — Teams ایپس بنائیں/منظم کریں
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (چینل/گروپ کے لیے Graph درکار)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
