---
summary: "Microsoft Teams ဘော့တ် ပံ့ပိုးမှုအခြေအနေ၊ စွမ်းဆောင်ရည်များနှင့် ဖွဲ့စည်းပြင်ဆင်မှု"
read_when:
  - MS Teams ချန်နယ် အင်္ဂါရပ်များအပေါ် အလုပ်လုပ်နေစဉ်
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "ဒီနေရာထဲ ဝင်လာသူတိုင်း မျှော်လင့်ချက်အားလုံးကို စွန့်လွှတ်ပါ။"

Updated: 2026-01-21

Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](#sending-files-in-group-chats)). Polls are sent via Adaptive Cards.

## Plugin လိုအပ်သည်

Microsoft Teams သည် plugin အဖြစ် ပို့ဆောင်ပေးထားပြီး core install တွင် မပါဝင်ပါ။

**Breaking change (2026.1.15):** MS Teams moved out of core. If you use it, you must install the plugin.

အကြောင်းပြချက်: core install ကို ပိုမို ပေါ့ပါးစေပြီး MS Teams အပေါ် မူတည်သော dependency များကို သီးခြားအလိုက် အပ်ဒိတ်လုပ်နိုင်ရန် ဖြစ်သည်။

CLI (npm registry) ဖြင့် ထည့်သွင်းရန်:

```bash
openclaw plugins install @openclaw/msteams
```

Local checkout (git repo မှ လည်ပတ်နေစဉ်):

```bash
openclaw plugins install ./extensions/msteams
```

configure/onboarding အတွင်း Teams ကို ရွေးချယ်ပြီး git checkout ကို တွေ့ရှိပါက,
OpenClaw သည် local install လမ်းကြောင်းကို အလိုအလျောက် အကြံပြုပါလိမ့်မည်။

အသေးစိတ်: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Microsoft Teams plugin ကို ထည့်သွင်းပါ။
2. **Azure Bot** တစ်ခုကို ဖန်တီးပါ (App ID + client secret + tenant ID)။
3. ထို credential များဖြင့် OpenClaw ကို ဖွဲ့စည်းပြင်ဆင်ပါ။
4. `/api/messages` (မူလ port 3978) ကို public URL သို့မဟုတ် tunnel ဖြင့် ဖော်ထုတ်ပါ။
5. Teams app package ကို ထည့်သွင်းပြီး gateway ကို စတင်ပါ။

Minimal config:

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

## Goals

- Teams DM များ၊ group chats များ သို့မဟုတ် channels များမှတဆင့် OpenClaw နှင့် စကားပြောနိုင်ရန်။
- routing ကို သေချာတိကျစေရန်: reply များသည် ဝင်လာသည့် ချန်နယ်သို့သာ ပြန်ပို့ရန်။
- လုံခြုံသော ချန်နယ် အပြုအမူကို မူလအဖြစ် သတ်မှတ်ရန် (configure မလုပ်ပါက mention လိုအပ်သည်)။

## Config writes

မူလအနေဖြင့် Microsoft Teams သည် `/config set|unset` ဖြင့် ဖြစ်ပေါ်လာသော config update များကို ရေးသားခွင့်ရှိပါသည် (`commands.config: true` လိုအပ်သည်)။

ပိတ်ရန်:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Access control (DMs + groups)

**DM access**

- မူလ: `channels.msteams.dmPolicy = "pairing"`။ Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` accepts AAD object IDs, UPNs, or display names. The wizard resolves names to IDs via Microsoft Graph when credentials allow.

**Group access**

- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Use `channels.defaults.groupPolicy` to override the default when unset.
- `channels.msteams.groupAllowFrom` သည် group chats/channels တွင် trigger လုပ်နိုင်သော ပို့သူများကို ထိန်းချုပ်ပါသည် (`channels.msteams.allowFrom` သို့ fallback လုပ်သည်)။
- အဖွဲ့ဝင်အားလုံးကို ခွင့်ပြုရန် `groupPolicy: "open"` ကို သတ်မှတ်ပါ (မူလအားဖြင့် mention-gated ဖြစ်နေဆဲ)။
- **မည်သည့် channel မဆို မခွင့်ပြုရန်** `channels.msteams.groupPolicy: "disabled"` ကို သတ်မှတ်ပါ။

ဥပမာ:

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

**Teams + channel allowlist**

- `channels.msteams.teams` အောက်တွင် teams နှင့် channels များကို စာရင်းပြုလုပ်၍ group/channel reply များကို scope လုပ်နိုင်သည်။
- key များသည် team ID သို့မဟုတ် name ဖြစ်နိုင်ပြီး; channel key များသည် conversation ID သို့မဟုတ် name ဖြစ်နိုင်သည်။
- `groupPolicy="allowlist"` နှင့် teams allowlist တစ်ခုရှိပါက၊ စာရင်းထဲရှိ teams/channels များကိုသာ လက်ခံပါသည် (mention-gated)။
- configure wizard သည် `Team/Channel` entry များကို လက်ခံပြီး သိမ်းဆည်းပေးပါသည်။
- စတင်ချိန်တွင် OpenClaw သည် team/channel နှင့် user allowlist name များကို ID များသို့ ဖြေရှင်းပြီး (Graph ခွင့်ပြုပါက)
  mapping ကို log ထုတ်ပြပြီး၊ မဖြေရှင်းနိုင်သည့် entry များကို ရိုက်ထည့်ထားသည့်အတိုင်း ထားရှိပါသည်။

ဥပမာ:

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

## How it works

1. Microsoft Teams plugin ကို ထည့်သွင်းပါ။
2. **Azure Bot** တစ်ခုကို ဖန်တီးပါ (App ID + secret + tenant ID)။
3. အောက်ပါ RSC ခွင့်ပြုချက်များ ပါဝင်သည့် **Teams app package** ကို တည်ဆောက်ပါ။
4. Teams app ကို team တစ်ခုထဲ (သို့မဟုတ် DM များအတွက် personal scope) သို့ upload/install လုပ်ပါ။
5. `~/.openclaw/openclaw.json` (သို့မဟုတ် env vars) တွင် `msteams` ကို ဖွဲ့စည်းပြင်ဆင်ပြီး gateway ကို စတင်ပါ။
6. gateway သည် မူလအားဖြင့် `/api/messages` တွင် Bot Framework webhook traffic ကို နားထောင်ပါသည်။

## Azure Bot Setup (Prerequisites)

OpenClaw ကို ဖွဲ့စည်းမပြင်ဆင်မီ Azure Bot resource တစ်ခုကို ဖန်တီးရပါမည်။

### Step 1: Azure Bot ဖန်တီးပါ

1. [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot) သို့ သွားပါ။
2. **Basics** tab ကို ဖြည့်ပါ:

   | Field              | Value                                                                           |
   | ------------------ | ------------------------------------------------------------------------------- |
   | **Bot handle**     | သင့် bot အမည်၊ ဥပမာ `openclaw-msteams` (ထူးခြားရမည်)         |
   | **Subscription**   | သင့် Azure subscription ကို ရွေးပါ                                              |
   | **Resource group** | အသစ်ဖန်တီးရန် သို့မဟုတ် ရှိပြီးသားကို အသုံးပြုပါ                                |
   | **Pricing tier**   | dev/testing အတွက် **Free**                                                      |
   | **Type of App**    | **Single Tenant** (အကြံပြုသည် - အောက်ပါ မှတ်ချက်ကို ကြည့်ပါ) |
   | **Creation type**  | **Create new Microsoft App ID**                                                 |

> **Deprecation notice:** Creation of new multi-tenant bots was deprecated after 2025-07-31. Use **Single Tenant** for new bots.

3. **Review + create** → **Create** ကို နှိပ်ပါ (၁–၂ မိနစ်ခန့် စောင့်ပါ)

### Step 2: Credential များ ရယူပါ

1. Azure Bot resource → **Configuration** သို့ သွားပါ။
2. **Microsoft App ID** ကို ကူးယူပါ → ၎င်းသည် သင့် `appId` ဖြစ်သည်။
3. **Manage Password** ကို နှိပ်ပါ → App Registration သို့ သွားပါ။
4. **Certificates & secrets** အောက်တွင် → **New client secret** → **Value** ကို ကူးယူပါ → ၎င်းသည် သင့် `appPassword` ဖြစ်သည်။
5. **Overview** သို့ သွားပြီး **Directory (tenant) ID** ကို ကူးယူပါ → ၎င်းသည် သင့် `tenantId` ဖြစ်သည်။

### Step 3: Messaging Endpoint ကို ဖွဲ့စည်းပါ

1. Azure Bot → **Configuration**
2. **Messaging endpoint** ကို သင့် webhook URL သို့ သတ်မှတ်ပါ:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: tunnel ကို အသုံးပြုပါ (အောက်ပါ [Local Development](#local-development-tunneling) ကို ကြည့်ပါ)

### Step 4: Teams Channel ကို ဖွင့်ပါ

1. Azure Bot → **Channels**
2. **Microsoft Teams** ကို နှိပ်ပါ → Configure → Save
3. Terms of Service ကို လက်ခံပါ

## Local Development (Tunneling)

Teams can't reach `localhost`. Use a tunnel for local development:

**Option A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Option B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Alternative)

manifest ZIP ကို လက်ဖြင့် မဖန်တီးဘဲ [Teams Developer Portal](https://dev.teams.microsoft.com/apps) ကို အသုံးပြုနိုင်ပါသည်:

1. **+ New app** ကို နှိပ်ပါ
2. အခြေခံ အချက်အလက်များ (အမည်၊ ဖော်ပြချက်၊ developer info) ကို ဖြည့်ပါ
3. **App features** → **Bot** သို့ သွားပါ
4. **Enter a bot ID manually** ကို ရွေးပြီး Azure Bot App ID ကို ကူးထည့်ပါ
5. scope များကို ရွေးပါ: **Personal**, **Team**, **Group Chat**
6. **Distribute** → **Download app package** ကို နှိပ်ပါ
7. Teams တွင်: **Apps** → **Manage your apps** → **Upload a custom app** → ZIP ကို ရွေးပါ

JSON manifest ကို လက်ဖြင့် ပြင်ဆင်ခြင်းထက် ပိုမို လွယ်ကူလေ့ရှိပါသည်။

## Testing the Bot

**Option A: Azure Web Chat (webhook ကို အရင် စစ်ဆေးပါ)**

1. Azure Portal → သင့် Azure Bot resource → **Test in Web Chat**
2. မက်ဆေ့ခ်ျတစ်ခု ပို့ပါ - reply ကို မြင်ရပါမည်
3. Teams setup မလုပ်မီ webhook endpoint အလုပ်လုပ်ကြောင်း အတည်ပြုပေးပါသည်

**Option B: Teams (app ထည့်ပြီးနောက်)**

1. Teams app ကို ထည့်သွင်းပါ (sideload သို့မဟုတ် org catalog)
2. Teams တွင် bot ကို ရှာပြီး DM တစ်ခုပို့ပါ
3. gateway logs တွင် incoming activity ကို စစ်ဆေးပါ

## Setup (minimal text-only)

1. **Microsoft Teams plugin ကို ထည့်သွင်းပါ**
   - npm မှ: `openclaw plugins install @openclaw/msteams`
   - local checkout မှ: `openclaw plugins install ./extensions/msteams`

2. **Bot registration**
   - Azure Bot ကို ဖန်တီးပါ (အထက်ပါအတိုင်း) နှင့် အောက်ပါအချက်များကို မှတ်သားပါ:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

3. **Teams app manifest**
   - `botId = <App ID>` ပါဝင်သည့် `bot` entry ကို ထည့်ပါ။
   - Scopes: `personal`, `team`, `groupChat`။
   - `supportsFiles: true` (personal scope တွင် ဖိုင်ကိုင်တွယ်ရန် လိုအပ်သည်)။
   - RSC permissions များကို ထည့်ပါ (အောက်တွင်)။
   - icon များ ဖန်တီးပါ: `outline.png` (32x32) နှင့် `color.png` (192x192)။
   - ဖိုင်သုံးခုလုံးကို zip တစ်ခုအဖြစ် စုပေါင်းပါ: `manifest.json`, `outline.png`, `color.png`။

4. **OpenClaw ကို ဖွဲ့စည်းပါ**

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

   config key များအစား environment variables ကိုလည်း အသုံးပြုနိုင်ပါသည်:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot endpoint**
   - Azure Bot Messaging Endpoint ကို အောက်ပါအတိုင်း သတ်မှတ်ပါ:
     - `https://<host>:3978/api/messages` (သို့မဟုတ် သင်ရွေးချယ်သည့် path/port)။

6. **gateway ကို လည်ပတ်ပါ**
   - plugin ကို ထည့်ပြီး `msteams` config ရှိပြီး credential များ ပါဝင်ပါက Teams channel သည် အလိုအလျောက် စတင်ပါသည်။

## History context

- `channels.msteams.historyLimit` သည် မကြာသေးမီ ချန်နယ်/အုပ်စု မက်ဆေ့ခ်ျ မည်မျှကို prompt ထဲသို့ ထည့်သွင်းမည်ကို ထိန်းချုပ်ပါသည်။
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).
- DM history can be limited with `channels.msteams.dmHistoryLimit` (user turns). Per-user overrides: `channels.msteams.dms["<user_id>"].historyLimit`.

## Current Teams RSC Permissions (Manifest)

These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team/chat where the app is installed.

**Channels (team scope) အတွက်:**

- `ChannelMessage.Read.Group` (Application) - @mention မလိုဘဲ channel မက်ဆေ့ခ်ျအားလုံးကို လက်ခံ
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Group chats အတွက်:**

- `ChatMessage.Read.Chat` (Application) - @mention မလိုဘဲ group chat မက်ဆေ့ခ်ျအားလုံးကို လက်ခံ

## Example Teams Manifest (redacted)

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

### Manifest caveats (လိုအပ်သော field များ)

- `bots[].botId` သည် Azure Bot App ID နှင့် **တိတိကျကျ ကိုက်ညီရမည်**။
- `webApplicationInfo.id` သည် Azure Bot App ID နှင့် **တိတိကျကျ ကိုက်ညီရမည်**။
- `bots[].scopes` တွင် သင်အသုံးပြုမည့် surface များ (`personal`, `team`, `groupChat`) ကို ထည့်ရမည်။
- `bots[].supportsFiles: true` သည် personal scope တွင် ဖိုင်ကိုင်တွယ်ရန် လိုအပ်သည်။
- channel traffic ကို လိုချင်ပါက `authorization.permissions.resourceSpecific` တွင် channel read/send ပါဝင်ရမည်။

### ရှိပြီးသား app ကို အပ်ဒိတ်လုပ်ခြင်း

Teams app တစ်ခုကို အပ်ဒိတ်လုပ်ရန် (ဥပမာ RSC permissions ထည့်ရန်):

1. setting အသစ်များဖြင့် သင့် `manifest.json` ကို အပ်ဒိတ်လုပ်ပါ
2. **`version` field ကို တိုးမြှင့်ပါ** (ဥပမာ `1.0.0` → `1.1.0`)
3. icon များနှင့်အတူ manifest ကို **ပြန်လည် zip** လုပ်ပါ (`manifest.json`, `outline.png`, `color.png`)
4. zip အသစ်ကို upload လုပ်ပါ:
   - **Option A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → app ကို ရှာ → Upload new version
   - **Option B (Sideload):** Teams → Apps → Manage your apps → Upload a custom app
5. **Team channels အတွက်:** permission အသစ်များ သက်ရောက်ရန် team တစ်ခုချင်းစီတွင် app ကို ပြန်ထည့်ပါ
6. cached app metadata ကို ဖယ်ရှားရန် **Teams ကို အပြည့်အဝ ပိတ်ပြီး ပြန်ဖွင့်ပါ** (window ပိတ်ခြင်းမဟုတ်)

## Capabilities: RSC only vs Graph

### **Teams RSC only** ဖြင့် (app ထည့်ထားပြီး Graph API ခွင့်ပြုချက် မရှိ)

အလုပ်လုပ်သည်များ:

- channel မက်ဆေ့ခ်ျ **စာသား** ကို ဖတ်နိုင်သည်။
- channel မက်ဆေ့ခ်ျ **စာသား** ကို ပို့နိုင်သည်။
- **personal (DM)** ဖိုင် attachment များကို လက်ခံနိုင်သည်။

အလုပ်မလုပ်သည်များ:

- Channel/group **ပုံ သို့မဟုတ် ဖိုင် အကြောင်းအရာ** (payload တွင် HTML stub သာ ပါဝင်သည်)
- SharePoint/OneDrive တွင် သိမ်းထားသော attachment များကို ဒေါင်းလုပ်လုပ်ခြင်း
- မက်ဆေ့ခ်ျ history ကို ဖတ်ခြင်း (live webhook event ထက်ကျော်လွန်၍)

### **Teams RSC + Microsoft Graph Application permissions** ဖြင့်

ထပ်တိုးနိုင်သည်များ:

- message ထဲသို့ paste လုပ်ထားသော ပုံများကို ဒေါင်းလုပ်လုပ်ခြင်း
- SharePoint/OneDrive တွင် သိမ်းထားသော ဖိုင် attachment များကို ဒေါင်းလုပ်လုပ်ခြင်း
- Graph မှတဆင့် channel/chat message history ကို ဖတ်ခြင်း

### RSC နှင့် Graph API နှိုင်းယှဉ်မှု

| Capability              | RSC Permissions                        | Graph API                                        |
| ----------------------- | -------------------------------------- | ------------------------------------------------ |
| **Real-time messages**  | Yes (webhook ဖြင့်) | No (polling သာ)               |
| **Historical messages** | No                                     | Yes (history query လုပ်နိုင်) |
| **Setup complexity**    | App manifest သာ                        | Admin consent + token flow လိုအပ်                |
| **Works offline**       | No (လည်ပတ်နေရမည်)   | Yes (မည်သည့်အချိန်မဆို query) |

**Bottom line:** RSC is for real-time listening; Graph API is for historical access. For catching up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## Graph-enabled media + history (channels အတွက် လိုအပ်)

**channels** တွင် ပုံ/ဖိုင်များ လိုအပ်ပါက သို့မဟုတ် **message history** ကို ယူလိုပါက Microsoft Graph permissions ကို ဖွင့်ပြီး admin consent ပေးရပါမည်။

1. Entra ID (Azure AD) **App Registration** တွင် Microsoft Graph **Application permissions** ကို ထည့်ပါ:
   - `ChannelMessage.Read.All` (channel attachment + history)
   - `Chat.Read.All` သို့မဟုတ် `ChatMessage.Read.All` (group chats)
2. tenant အတွက် **admin consent ပေးပါ**။
3. Teams app **manifest version** ကို တိုးမြှင့်ပြီး ပြန် upload လုပ်ကာ **Teams တွင် app ကို ပြန်ထည့်ပါ**။
4. cached app metadata ကို ဖယ်ရှားရန် **Teams ကို အပြည့်အဝ ပိတ်ပြီး ပြန်ဖွင့်ပါ**။

## Known Limitations

### Webhook timeouts

Teams delivers messages via HTTP webhook. If processing takes too long (e.g., slow LLM responses), you may see:

- Gateway timeout များ
- Teams မှ မက်ဆေ့ခ်ျကို ပြန်လည်ကြိုးစားပို့ခြင်း (duplicate ဖြစ်နိုင်)
- Reply များ ပျောက်ဆုံးခြင်း

OpenClaw သည် လျင်မြန်စွာ ပြန်ဖြေပြီး proactive reply ပို့ခြင်းဖြင့် ကိုင်တွယ်ထားသော်လည်း အလွန်နှေးကွေးသော response များတွင် ပြဿနာ ရှိနိုင်ပါသည်။

### Formatting

Teams markdown သည် Slack သို့မဟုတ် Discord ထက် ကန့်သတ်ထားပါသည်:

- အခြေခံ formatting များ အလုပ်လုပ်သည်: **bold**, _italic_, `code`, links
- အရှုပ်ထွေးသော markdown (ဇယားများ၊ nested lists) များကို မှန်ကန်စွာ မပြနိုင်ပါ
- Poll များနှင့် card ပို့ခြင်းအတွက် Adaptive Cards ကို ပံ့ပိုးထားပါသည် (အောက်တွင်)

## Configuration

Key setting များ (`/gateway/configuration` တွင် shared channel pattern များကို ကြည့်ပါ):

- `channels.msteams.enabled`: ချန်နယ်ကို ဖွင့်/ပိတ်။
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: bot credential များ။
- `channels.msteams.webhook.port` (မူလ `3978`)
- `channels.msteams.webhook.path` (မူလ `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (မူလ: pairing)
- `channels.msteams.allowFrom`: allowlist for DMs (AAD object IDs, UPNs, or display names). The wizard resolves names to IDs during setup when Graph access is available.
- `channels.msteams.textChunkLimit`: outbound text chunk အရွယ်အစား။
- `channels.msteams.chunkMode`: `length` (မူလ) သို့မဟုတ် `newline` ကို အသုံးပြု၍ အလျားအလိုက် ခွဲမပြုမီ blank line များဖြင့် ခွဲပါ။
- `channels.msteams.mediaAllowHosts`: inbound attachment host များအတွက် allowlist (မူလ Microsoft/Teams domain များ)။
- `channels.msteams.mediaAuthAllowHosts`: media retry များတွင် Authorization header တွဲပို့ရန် allowlist (မူလ Graph + Bot Framework host များ)။
- `channels.msteams.requireMention`: channels/groups တွင် @mention လိုအပ်စေခြင်း (မူလ true)။
- `channels.msteams.replyStyle`: `thread | top-level` ( [Reply Style](#reply-style-threads-vs-posts) ကိုကြည့်ပါ)။
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: ချန်နယ်တစ်ခုချင်းစီအလိုက် override ပြုလုပ်နိုင်သည်။
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: ချန်နယ်တစ်ခုချင်းစီအလိုက် override ပြုလုပ်နိုင်သည်။
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: ချန်နယ်တစ်ခုချင်းစီအလိုက် tool policy override များ (`allow`/`deny`/`alsoAllow`)။
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: ချန်နယ်တစ်ခုချင်းစီအလိုက် ပို့သူတစ်ဦးချင်းစီအတွက် tool policy override များ (`"*"` wildcard ကိုထောက်ပံ့သည်)။
- `channels.msteams.sharePointSiteId`: group chats/channels တွင် ဖိုင် upload အတွက် SharePoint site ID ( [Sending files in group chats](#sending-files-in-group-chats) ကိုကြည့်ပါ )။

## Routing & Sessions

- Session key များသည် စံ agent format ကို လိုက်နာပါသည် ( [/concepts/session](/concepts/session) ကိုကြည့်ပါ ):
  - Direct messages များသည် main session (`agent:<agentId>:<mainKey>`) ကို မျှဝေပါသည်။
  - Channel/group messages များသည် conversation id ကို အသုံးပြုပါသည်:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Reply Style: Threads vs Posts

Teams သည် underlying data model တူညီသော်လည်း channel UI style နှစ်မျိုးကို မကြာသေးမီက မိတ်ဆက်ခဲ့ပါသည်:

| Style                                       | ဖော်ပြချက်                                                     | အကြံပြုထားသော `replyStyle`        |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------------- |
| **Posts** (classic)      | မက်ဆေ့ခ်ျများကို card အဖြစ် ပြပြီး အောက်တွင် reply thread များ | `thread` (မူလ) |
| **Threads** (Slack-like) | Slack ကဲ့သို့ မက်ဆေ့ခ်ျများ တန်းတန်းစီစီ စီးဆင်းပြသ            | `top-level`                       |

**ပြဿနာ:** Teams API သည် ချန်နယ်တစ်ခုက ဘယ် UI style ကို သုံးထားသည်ကို မဖော်ပြပေးပါ။ `replyStyle` ကို မမှန်ကန်စွာ အသုံးပြုပါက:

- Threads-style channel တွင် `thread` → reply များ ထူးဆန်းစွာ nested ဖြစ်
- Posts-style channel တွင် `top-level` → reply များသည် thread အစား top-level post အဖြစ် ထွက်လာ

**ဖြေရှင်းချက်:** channel တည်ဆောက်ပုံအလိုက် `replyStyle` ကို per-channel သတ်မှတ်ပါ:

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

## Attachments & Images

**လက်ရှိ ကန့်သတ်ချက်များ:**

- **DMs:** Teams bot file API များဖြင့် ပုံနှင့် ဖိုင် attachment များ အလုပ်လုပ်သည်။
- **Channels/groups:** Attachment များကို M365 storage (SharePoint/OneDrive) တွင် သိမ်းဆည်းထားသည်။ Webhook payload တွင် HTML stub သာ ပါဝင်ပြီး အမှန်တကယ် file bytes မပါဝင်ပါ။ ချန်နယ် attachment များကို download လုပ်ရန် **Graph API permission များ လိုအပ်သည်**။

Graph permission မရှိပါက၊ ပုံပါဝင်သော ချန်နယ် message များကို text-only အဖြစ်သာ လက်ခံရရှိမည် (bot သည် image content ကို မရယူနိုင်ပါ)။
ပုံမှန်အားဖြင့် OpenClaw သည် Microsoft/Teams hostname များမှသာ media ကို download လုပ်ပါသည်။ `channels.msteams.mediaAllowHosts` ဖြင့် override ပြုလုပ်နိုင်သည် (`["*"]` ကို အသုံးပြုပါက မည်သည့် host မဆို ခွင့်ပြုသည်)။
Authorization header များကို `channels.msteams.mediaAuthAllowHosts` တွင် ပါဝင်သော host များအတွက်သာ ပူးတွဲပေးသည် (မူလတန်ဖိုးမှာ Graph + Bot Framework host များ)။ ဤစာရင်းကို တင်းကျပ်စွာ ထိန်းထားပါ (multi-tenant suffix များကို ရှောင်ကြဉ်ပါ)။

## Sending files in group chats

Bot များသည် DM များတွင် FileConsentCard flow (built-in) ကို အသုံးပြုပြီး ဖိုင်များ ပို့နိုင်သည်။ သို့သော် **group chat/channel များတွင် ဖိုင်ပို့ရန်** အပို setup လိုအပ်ပါသည်:

| Context                                              | ဖိုင်ပို့ပုံ                                    | လိုအပ်သော setup                               |
| ---------------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| **DMs**                                              | FileConsentCard → အသုံးပြုသူ လက်ခံ → bot upload | မည်သည့် setup မလိုအပ်                         |
| **Group chats/channels**                             | SharePoint သို့ upload → share link ပို့        | `sharePointSiteId` + Graph permissions လိုအပ် |
| **Images (မည်သည့် context မဆို)** | Base64-encoded inline                           | မည်သည့် setup မလိုအပ်                         |

### Group chats အတွက် SharePoint လိုအပ်ရသည့် အကြောင်းရင်း

Bot များတွင် ကိုယ်ပိုင် OneDrive drive မရှိပါ (`/me/drive` Graph API endpoint သည် application identity များအတွက် အလုပ်မလုပ်ပါ)။ Group chat/channel များတွင် ဖိုင်ပို့ရန်အတွက် bot သည် **SharePoint site** သို့ upload လုပ်ပြီး sharing link တစ်ခု ဖန်တီးပါသည်။

### Setup

1. Entra ID (Azure AD) → App Registration တွင် **Graph API permissions** ကို ထည့်ပါ:
   - `Sites.ReadWrite.All` (Application) - SharePoint သို့ ဖိုင် upload
   - `Chat.Read.All` (Application) - optional, per-user sharing link ဖွင့်ရန်

2. tenant အတွက် **admin consent ပေးပါ**။

3. **SharePoint site ID ကို ရယူပါ:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **OpenClaw ကို ဖွဲ့စည်းပါ:**

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

### Sharing behavior

| Permission                              | Sharing behavior                                                        |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `Sites.ReadWrite.All` only              | အဖွဲ့အစည်းတစ်ခုလုံး အသုံးပြုနိုင်သော sharing link                       |
| `Sites.ReadWrite.All` + `Chat.Read.All` | per-user sharing link (chat အဖွဲ့ဝင်များသာ ဝင်နိုင်) |

User တစ်ဦးချင်းစီအလိုက် sharing ပြုလုပ်ခြင်းသည် ပိုမိုလုံခြုံပြီး chat ပါဝင်သူများသာ ဖိုင်ကို ဝင်ရောက်ကြည့်ရှုနိုင်ပါသည်။ `Chat.Read.All` permission မရှိပါက bot သည် organization အနှံ့ sharing သို့ fallback လုပ်ပါသည်။

### Fallback behavior

| Scenario                                          | Result                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| Group chat + file + `sharePointSiteId` configured | SharePoint သို့ upload လုပ်ပြီး sharing link ပို့                           |
| Group chat + file + no `sharePointSiteId`         | OneDrive upload ကြိုးစား (မအောင်မြင်နိုင်), စာသားသာ ပို့ |
| Personal chat + file                              | FileConsentCard flow (SharePoint မလို)                   |
| Any context + image                               | Base64-encoded inline (SharePoint မလို)                  |

### Files သိမ်းဆည်းရာနေရာ

upload လုပ်ထားသော ဖိုင်များကို သတ်မှတ်ထားသော SharePoint site ၏ default document library အတွင်းရှိ `/OpenClawShared/` folder ထဲတွင် သိမ်းဆည်းပါသည်။

## Polls (Adaptive Cards)

OpenClaw သည် Teams poll များကို Adaptive Cards အဖြစ် ပို့ပါသည် (Teams တွင် native poll API မရှိပါ)။

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- မဲရလဒ်များကို gateway သည် `~/.openclaw/msteams-polls.json` ထဲတွင် မှတ်တမ်းတင်ပါသည်။
- မဲရလဒ်များ မှတ်တမ်းတင်ရန် gateway သည် အွန်လိုင်းဖြစ်နေရပါမည်။
- poll ရလဒ် အကျဉ်းချုပ်ကို အလိုအလျောက် မတင်ပေးသေးပါ (လိုအပ်ပါက store ဖိုင်ကို စစ်ဆေးပါ)။

## Adaptive Cards (အထွေထွေ)

`message` tool သို့မဟုတ် CLI ကို အသုံးပြု၍ Teams အသုံးပြုသူများ သို့မဟုတ် conversation များသို့ Adaptive Card JSON မည်သည့်အရာမဆို ပို့နိုင်ပါသည်။

`card` parameter သည် Adaptive Card JSON object ကို လက်ခံပါသည်။ `card` ကို ပေးထားပါက message text သည် မဖြစ်မနေ မလိုအပ်ပါ။

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

Card schema နှင့် ဥပမာများအတွက် [Adaptive Cards documentation](https://adaptivecards.io/) ကို ကြည့်ရှုပါ။ Target format အသေးစိတ်အချက်အလက်များအတွက် အောက်ပါ [Target formats](#target-formats) ကို ကြည့်ရှုပါ။

## Target formats

MSTeams target များသည် user နှင့် conversation ကို ခွဲခြားရန် prefix များကို အသုံးပြုပါသည်:

| Target type                            | Format                           | Example                                                             |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| User (ID ဖြင့်)     | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                         |
| User (name ဖြင့်)   | `user:<display-name>`            | `user:John Smith` (Graph API လိုအပ်)             |
| Group/channel                          | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                            |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (`@thread` ပါရှိပါက) |

**CLI ဥပမာများ:**

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

**Agent tool ဥပမာများ:**

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

မှတ်ချက်: `user:` prefix မပါပါက အမည်များကို group/team resolution အဖြစ် default သတ်မှတ်ပါသည်။ Display name ဖြင့် လူများကို target လုပ်သောအခါ `user:` ကို အမြဲအသုံးပြုပါ။

## Proactive messaging

- Proactive message များသည် အသုံးပြုသူက အပြန်အလှန် ပြုလုပ်ပြီးနောက်မှသာ ဖြစ်နိုင်ပါသည်၊ အကြောင်းမှာ conversation reference များကို ထိုအချိန်တွင်သာ သိမ်းဆည်းထားသောကြောင့် ဖြစ်သည်။
- `/gateway/configuration` တွင် `dmPolicy` နှင့် allowlist gating ကို ကြည့်ပါ။

## Team နှင့် Channel ID များ (အများအားဖြင့် လွဲမှားတတ်သော အချက်)

Teams URL များရှိ `groupId` query parameter သည် configuration အတွက် အသုံးပြုသော team ID **မဟုတ်ပါ**။ URL path မှ ID များကို ထုတ်ယူပါ:

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

**Config အတွက်:**

- Team ID = `/team/` ပြီးနောက် path segment (URL-decoded, ဥပမာ `19:Bk4j...@thread.tacv2`)
- Channel ID = `/channel/` ပြီးနောက် path segment (URL-decoded)
- `groupId` query parameter ကို **လျစ်လျူရှုပါ**

## Private Channels

Private channel များတွင် bot ပံ့ပိုးမှုမှာ ကန့်သတ်ချက်များ ရှိပါသည်:

| Feature                                         | Standard Channels | Private Channels                           |
| ----------------------------------------------- | ----------------- | ------------------------------------------ |
| Bot installation                                | Yes               | ကန့်သတ်                                    |
| Real-time messages (webhook) | Yes               | အလုပ်မလုပ်နိုင်ပါ                          |
| RSC permissions                                 | Yes               | ကွဲပြားစွာ အလုပ်လုပ်နိုင်                  |
| @mentions                          | Yes               | bot ဝင်ရောက်နိုင်ပါက                       |
| Graph API history                               | Yes               | Yes (permission ရှိပါက) |

**Private channel များ မအလုပ်လုပ်ပါက အစားထိုးနည်းလမ်းများ:**

1. bot အပြန်အလှန်အတွက် standard channel များကို အသုံးပြုပါ
2. DMs ကို အသုံးပြုပါ — အသုံးပြုသူများသည် bot ကို တိုက်ရိုက် မက်ဆေ့ခ်ျပို့နိုင်ပါသည်
3. history access အတွက် Graph API ကို အသုံးပြုပါ (`ChannelMessage.Read.All` လိုအပ်)

## Troubleshooting

### အများဆုံး တွေ့ရသော ပြဿနာများ

- **ချန်နယ်များတွင် ပုံမပေါ်ခြင်း:** Graph permission သို့မဟုတ် admin consent မရှိခြင်းကြောင့် ဖြစ်နိုင်သည်။ Teams app ကို ပြန်လည် install လုပ်ပြီး Teams ကို လုံးဝပိတ်ကာ ပြန်ဖွင့်ပါ။
- **Channel တွင် reply မရှိခြင်း:** မူလအားဖြင့် mention လိုအပ်ပါသည်; `channels.msteams.requireMention=false` ကို သတ်မှတ်ပါ သို့မဟုတ် team/channel အလိုက် configure လုပ်ပါ။
- **Version မကိုက်ညီခြင်း (Teams တွင် manifest အဟောင်း ပြနေဆဲ):** app ကို ဖယ်ရှားပြီး ပြန်ထည့်ပါ၊ Teams ကို အပြည့်အဝ ပိတ်ပါ။
- **Webhook မှ 401 Unauthorized:** Azure JWT မပါဘဲ manual စမ်းသပ်သည့်အခါ မျှော်လင့်ထားသည့် အခြေအနေဖြစ်သည် — endpoint ကို ရောက်နိုင်ကြောင်း ပြသသော်လည်း auth မအောင်မြင်ပါ။ မှန်ကန်စွာ စမ်းသပ်ရန် Azure Web Chat ကို အသုံးပြုပါ။

### Manifest upload error များ

- **"Icon file cannot be empty":** Manifest တွင် ကိုးကားထားသော icon ဖိုင်များ၏ အရွယ်အစားသည် 0 bytes ဖြစ်နေသည်။ အကျုံးဝင်သော PNG icon များကို ဖန်တီးပါ (`outline.png` အတွက် 32x32၊ `color.png` အတွက် 192x192)။
- **"webApplicationInfo.Id already in use":** App သည် အခြား team/chat တစ်ခုတွင် ထည့်သွင်းထားဆဲ ဖြစ်ပါသည်။ အရင်ဆုံး ရှာဖွေ၍ uninstall လုပ်ပါ၊ သို့မဟုတ် propagation အတွက် 5-10 မိနစ်ခန့် စောင့်ပါ။
- **Upload တွင် "Something went wrong":** [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) မှတဆင့် upload လုပ်ပြီး browser DevTools (F12) → Network tab တွင် response body ကို စစ်ဆေးပါ။
- **Sideload မအောင်မြင်ခြင်း:** "Upload a custom app" အစား "Upload an app to your org's app catalog" ကို စမ်းကြည့်ပါ — sideload ကန့်သတ်ချက်များကို ရှောင်ရှားနိုင်တတ်ပါသည်။

### RSC permissions မအလုပ်လုပ်ခြင်း

1. `webApplicationInfo.id` သည် bot App ID နှင့် တိတိကျကျ ကိုက်ညီကြောင်း စစ်ဆေးပါ
2. app ကို ပြန် upload လုပ်ပြီး team/chat တွင် ပြန်ထည့်ပါ
3. သင့် org admin မှ RSC permissions ကို ပိတ်ထားခြင်း မရှိကြောင်း စစ်ဆေးပါ
4. scope မှန်ကန်ကြောင်း အတည်ပြုပါ: team များအတွက် `ChannelMessage.Read.Group`, group chats အတွက် `ChatMessage.Read.Chat`

## References

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot setup လမ်းညွှန်
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - Teams app များ ဖန်တီး/စီမံခန့်ခွဲ
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (channel/group အတွက် Graph လိုအပ်)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
