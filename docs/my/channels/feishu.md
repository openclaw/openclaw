---
summary: "Feishu bot အကြောင်းအရာအကျဉ်းချုပ်၊ အင်္ဂါရပ်များနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း"
read_when:
  - Feishu/Lark bot ကို ချိတ်ဆက်လိုသောအခါ
  - Feishu ချန်နယ်ကို ဖွဲ့စည်းပြင်ဆင်နေသောအခါ
title: Feishu
---

# Feishu bot

Feishu (Lark) is a team chat platform used by companies for messaging and collaboration. This plugin connects OpenClaw to a Feishu/Lark bot using the platform’s WebSocket event subscription so messages can be received without exposing a public webhook URL.

---

## Plugin လိုအပ်ချက်

Feishu plugin ကို ထည့်သွင်းပါ—

```bash
openclaw plugins install @openclaw/feishu
```

Local checkout (git repo မှ အလုပ်လုပ်နေသောအခါ)—

```bash
openclaw plugins install ./extensions/feishu
```

---

## Quickstart

Feishu ချန်နယ်ကို ထည့်သွင်းရန် နည်းလမ်း နှစ်မျိုး ရှိပါသည်—

### နည်းလမ်း ၁: onboarding wizard (အကြံပြု)

OpenClaw ကို အသစ်ထည့်သွင်းပြီးသားဖြစ်ပါက wizard ကို လည်ပတ်ပါ—

```bash
openclaw onboard
```

Wizard သည် အောက်ပါအဆင့်များကို လမ်းညွှန်ပေးပါသည်—

1. Feishu app တစ်ခု ဖန်တီးပြီး အထောက်အထားများကို စုဆောင်းခြင်း
2. OpenClaw တွင် app အထောက်အထားများကို ဖွဲ့စည်းပြင်ဆင်ခြင်း
3. Gateway ကို စတင်ခြင်း

✅ **ဖွဲ့စည်းပြင်ဆင်ပြီးနောက်**, Gateway အခြေအနေကို စစ်ဆေးပါ—

- `openclaw gateway status`
- `openclaw logs --follow`

### နည်းလမ်း ၂: CLI setup

အစပိုင်း ထည့်သွင်းမှုကို ပြီးစီးပြီးသားဖြစ်ပါက CLI မှတစ်ဆင့် ချန်နယ်ကို ထည့်ပါ—

```bash
openclaw channels add
```

**Feishu** ကို ရွေးချယ်ပြီး App ID နှင့် App Secret ကို ထည့်သွင်းပါ။

✅ **ဖွဲ့စည်းပြင်ဆင်ပြီးနောက်**, Gateway ကို စီမံခန့်ခွဲပါ—

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## အဆင့် ၁: Feishu app တစ်ခု ဖန်တီးခြင်း

### 1. Open Feishu Open Platform

[Feishu Open Platform](https://open.feishu.cn/app) သို့ ဝင်ရောက်ပြီး လက်မှတ်ထိုးဝင်ပါ။

Lark (global) tenant များအတွက် [https://open.larksuite.com/app](https://open.larksuite.com/app) ကို အသုံးပြုရမည်ဖြစ်ပြီး Feishu config တွင် `domain: "lark"` ကို သတ်မှတ်ပါ။

### 2. Create an app

1. **Create enterprise app** ကို နှိပ်ပါ
2. App အမည်နှင့် ဖော်ပြချက်ကို ဖြည့်ပါ
3. App icon ကို ရွေးချယ်ပါ

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Copy credentials

**Credentials & Basic Info** မှ အောက်ပါအချက်များကို ကူးယူပါ—

- **App ID** (ဖော်မတ်: `cli_xxx`)
- **App Secret**

❗ **အရေးကြီး:** App Secret ကို လျှို့ဝှက်ထားပါ။

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Configure permissions

**Permissions** တွင် **Batch import** ကို နှိပ်ပြီး အောက်ပါကို ကူးထည့်ပါ—

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

### 5. Bot စွမ်းရည်ကို ဖွင့်ပါ

**App Capability** > **Bot** အောက်တွင်—

1. Bot စွမ်းရည်ကို ဖွင့်ပါ
2. Bot အမည်ကို သတ်မှတ်ပါ

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Configure event subscription

⚠️ **အရေးကြီး:** Event subscription ကို မသတ်မှတ်မီ အောက်ပါအချက်များကို သေချာစွာ စစ်ဆေးပါ—

1. Feishu အတွက် `openclaw channels add` ကို ပြီးစီးပြီးသားဖြစ်ရမည်
2. Gateway သည် လည်ပတ်နေပြီးသားဖြစ်ရမည် (`openclaw gateway status`)

**Event Subscription** တွင်—

1. **Use long connection to receive events** (WebSocket) ကို ရွေးချယ်ပါ
2. Event ကို ထည့်ပါ— `im.message.receive_v1`

⚠️ Gateway မလည်ပတ်နေပါက long-connection setup ကို သိမ်းဆည်း၍ မရနိုင်ပါ။

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Publish the app

1. **Version Management & Release** တွင် version တစ်ခု ဖန်တီးပါ
2. စစ်ဆေးအတည်ပြုရန် တင်သွင်းပြီး ထုတ်ဝေပါ
3. Admin အတည်ပြုချက်ကို စောင့်ပါ (enterprise app များသည် များသောအားဖြင့် အလိုအလျောက် အတည်ပြုပါသည်)

---

## အဆင့် ၂: OpenClaw ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

### Wizard ဖြင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း (အကြံပြု)

```bash
openclaw channels add
```

**Feishu** ကို ရွေးချယ်ပြီး App ID နှင့် App Secret ကို ကူးထည့်ပါ။

### Config ဖိုင်မှတစ်ဆင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း

`~/.openclaw/openclaw.json` ကို ပြင်ဆင်ပါ—

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

### Environment variables ဖြင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (global) domain

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

## အဆင့် ၃: စတင်ခြင်း + စမ်းသပ်ခြင်း

### 1. Start the gateway

```bash
openclaw gateway
```

### 2. Send a test message

Feishu တွင် သင့် bot ကို ရှာဖွေပြီး မက်ဆေ့ချ်တစ်စောင် ပို့ပါ။

### 3. Approve pairing

By default, the bot replies with a pairing code. Approve it:

```bash
openclaw pairing approve feishu <CODE>
```

အတည်ပြုပြီးနောက် ပုံမှန်အတိုင်း ချတ်လုပ်နိုင်ပါသည်။

---

## အကျဉ်းချုပ်

- **Feishu bot ချန်နယ်**: Gateway မှ စီမံခန့်ခွဲသော Feishu bot
- **Deterministic routing**: ပြန်ကြားချက်များသည် အမြဲ Feishu သို့ ပြန်သွားပါသည်
- **Session isolation**: DM များသည် အဓိက ဆက်ရှင်ကို မျှဝေပြီး အုပ်စုများသည် သီးခြားဖြစ်သည်
- **WebSocket ချိတ်ဆက်မှု**: Feishu SDK မှတစ်ဆင့် long connection ကို အသုံးပြု၍ အများပြည်သူ URL မလိုအပ်ပါ

---

## Access control

### Direct messages

- **ပုံမှန်**: `dmPolicy: "pairing"` (မသိသူများသည် pairing code ကို ရရှိပါသည်)

- **Pairing အတည်ပြုခြင်း**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Allowlist mode**: ခွင့်ပြုထားသော Open ID များဖြင့် `channels.feishu.allowFrom` ကို သတ်မှတ်ပါ

### Group chats

**1. Group policy** (`channels.feishu.groupPolicy`):

- `"open"` = အုပ်စုအတွင်းရှိ လူတိုင်းကို ခွင့်ပြုပါ (ပုံမှန်)
- `"allowlist"` = `groupAllowFrom` ကိုသာ ခွင့်ပြုပါ
- `"disabled"` = အုပ်စုမက်ဆေ့ချ်များကို ပိတ်ပါ

**2. Mention requirement** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @mention လိုအပ်သည် (ပုံမှန်)
- `false` = mention မလိုအပ်ဘဲ ပြန်ကြားပါ

---

## Group ဖွဲ့စည်းမှု ဥပမာများ

### အုပ်စုအားလုံးကို ခွင့်ပြု၊ @mention လိုအပ် (ပုံမှန်)

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

### အုပ်စုအားလုံးကို ခွင့်ပြု၊ @mention မလိုအပ်

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

### အုပ်စုများတွင် အသုံးပြုသူ သတ်မှတ်ချက်ဖြင့်သာ ခွင့်ပြု

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

## Group/User ID များ ရယူခြင်း

### Group ID များ (chat_id)

Group ID များသည် `oc_xxx` ကဲ့သို့ ဖြစ်ပါသည်။

**နည်းလမ်း ၁ (အကြံပြု)**

1. Gateway ကို စတင်ပြီး အုပ်စုတွင် bot ကို @mention လုပ်ပါ
2. `openclaw logs --follow` ကို လည်ပတ်ပြီး `chat_id` ကို ရှာပါ

**နည်းလမ်း ၂**

Feishu API debugger ကို အသုံးပြုပြီး အုပ်စုချတ်များကို စာရင်းပြုစုပါ။

### User ID များ (open_id)

User ID များသည် `ou_xxx` ကဲ့သို့ ဖြစ်ပါသည်။

**နည်းလမ်း ၁ (အကြံပြု)**

1. Gateway ကို စတင်ပြီး bot သို့ DM ပို့ပါ
2. `openclaw logs --follow` ကို လည်ပတ်ပြီး `open_id` ကို ရှာပါ

**နည်းလမ်း ၂**

Pairing request များထဲမှ အသုံးပြုသူ Open ID များကို စစ်ဆေးပါ—

```bash
openclaw pairing list feishu
```

---

## အသုံးများသော အမိန့်များ

| Command   | ဖော်ပြချက်                  |
| --------- | --------------------------- |
| `/status` | Bot အခြေအနေကို ပြပါ         |
| `/reset`  | ဆက်ရှင်ကို ပြန်လည်သတ်မှတ်ပါ |
| `/model`  | မော်ဒယ်ကို ပြ/ပြောင်းပါ     |

> မှတ်ချက်: Feishu တွင် native command menu မပံ့ပိုးသေးသဖြင့် အမိန့်များကို စာသားအဖြစ် ပို့ရပါသည်။

## Gateway စီမံခန့်ခွဲမှု အမိန့်များ

| Command                    | ဖော်ပြချက်                              |
| -------------------------- | --------------------------------------- |
| `openclaw gateway status`  | Gateway အခြေအနေကို ပြပါ                 |
| `openclaw gateway install` | Gateway ဝန်ဆောင်မှုကို ထည့်သွင်း/စတင်ပါ |
| `openclaw gateway stop`    | Gateway ဝန်ဆောင်မှုကို ရပ်တန့်ပါ        |
| `openclaw gateway restart` | Gateway ဝန်ဆောင်မှုကို ပြန်လည်စတင်ပါ    |
| `openclaw logs --follow`   | Gateway log များကို ဆက်တိုက်ကြည့်ပါ     |

---

## Troubleshooting

### Group chats တွင် bot မပြန်ကြားပါက

1. Bot ကို အုပ်စုထဲသို့ ထည့်ပြီးသားဖြစ်ကြောင်း သေချာစစ်ပါ
2. Bot ကို @mention လုပ်ထားကြောင်း သေချာစစ်ပါ (ပုံမှန် အပြုအမူ)
3. `groupPolicy` ကို `"disabled"` အဖြစ် မသတ်မှတ်ထားကြောင်း စစ်ပါ
4. Log များကို စစ်ပါ— `openclaw logs --follow`

### Bot မက်ဆေ့ချ် မလက်ခံပါက

1. App ကို ထုတ်ဝေပြီး အတည်ပြုပြီးသားဖြစ်ကြောင်း စစ်ပါ
2. Event subscription တွင် `im.message.receive_v1` ပါဝင်ကြောင်း စစ်ပါ
3. **Long connection** ကို ဖွင့်ထားကြောင်း စစ်ပါ
4. App ခွင့်ပြုချက်များ ပြည့်စုံကြောင်း စစ်ပါ
5. Gateway လည်ပတ်နေကြောင်း စစ်ပါ— `openclaw gateway status`
6. Log များကို စစ်ပါ— `openclaw logs --follow`

### App Secret ပေါက်ကြားသွားပါက

1. Feishu Open Platform တွင် App Secret ကို ပြန်လည်သတ်မှတ်ပါ
2. သင့် config တွင် App Secret အသစ်ကို အပ်ဒိတ်လုပ်ပါ
3. Gateway ကို ပြန်လည်စတင်ပါ

### မက်ဆေ့ချ် ပို့မရခြင်း

1. App တွင် `im:message:send_as_bot` ခွင့်ပြုချက် ရှိကြောင်း စစ်ပါ
2. App ကို ထုတ်ဝေပြီးသားဖြစ်ကြောင်း စစ်ပါ
3. အသေးစိတ် အမှားများအတွက် log များကို စစ်ပါ

---

## Advanced configuration

### အကောင့်အများအပြား

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

### မက်ဆေ့ချ် ကန့်သတ်ချက်များ

- `textChunkLimit`: အပြင်ပို့ စာသားအပိုင်း အရွယ်အစား (ပုံမှန်: စာလုံး 2000)
- `mediaMaxMb`: မီဒီယာ upload/download ကန့်သတ်ချက် (ပုံမှန်: 30MB)

### Streaming

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

ပြန်ကြားချက် အပြည့်အစုံကို စောင့်ပြီးမှ ပို့ရန် `streaming: false` ကို သတ်မှတ်ပါ။

### Multi-agent routing

Feishu DM များ သို့မဟုတ် အုပ်စုများကို အေးဂျင့် အမျိုးမျိုးသို့ လမ်းကြောင်းပြောင်းရန် `bindings` ကို အသုံးပြုပါ။

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
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_yyy" },
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

Routing အကွက်များ—

- `match.channel`: `"feishu"`
- `match.peer.kind`: "direct" သို့မဟုတ် "group"
- `match.peer.id`: အသုံးပြုသူ Open ID (`ou_xxx`) သို့မဟုတ် Group ID (`oc_xxx`)

ရှာဖွေရန် အကြံပြုချက်များအတွက် [Get group/user IDs](#get-groupuser-ids) ကို ကြည့်ပါ။

---

## Configuration reference

ဖွဲ့စည်းပြင်ဆင်မှု အပြည့်အစုံ— [Gateway configuration](/gateway/configuration)

အဓိက ရွေးချယ်စရာများ—

| Setting                                           | ဖော်ပြချက်                                    | ပုံမှန်   |
| ------------------------------------------------- | --------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | ချန်နယ်ကို ဖွင့်/ပိတ်                         | `true`    |
| `channels.feishu.domain`                          | API domain (`feishu` သို့မဟုတ် `lark`)        | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                        | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                    | -         |
| `channels.feishu.accounts.<id>.domain`            | အကောင့်တစ်ခုချင်းစီအလိုက် API domain override | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM မူဝါဒ                                      | `pairing` |
| `channels.feishu.allowFrom`                       | DM allowlist (open_id စာရင်း)                 | -         |
| `channels.feishu.groupPolicy`                     | Group မူဝါဒ                                   | `open`    |
| `channels.feishu.groupAllowFrom`                  | Group allowlist                               | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @mention လိုအပ်ချက်                           | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Group ကို ဖွင့်                               | `true`    |
| `channels.feishu.textChunkLimit`                  | မက်ဆေ့ချ် အပိုင်း အရွယ်အစား                   | `2000`    |
| `channels.feishu.mediaMaxMb`                      | မီဒီယာ အရွယ်အစား ကန့်သတ်ချက်                  | `30`      |
| `channels.feishu.streaming`                       | Streaming card output ကို ဖွင့်               | `true`    |
| `channels.feishu.blockStreaming`                  | Block streaming ကို ဖွင့်                     | `true`    |

---

## dmPolicy reference

| Value         | အပြုအမူ                                                               |
| ------------- | --------------------------------------------------------------------- |
| `"pairing"`   | **ပုံမှန်။** မသိသူများသည် pairing code ကို ရရှိပြီး အတည်ပြုရမည်       |
| `"allowlist"` | `allowFrom` ထဲရှိ အသုံးပြုသူများသာ ချတ်လုပ်နိုင်သည်                   |
| `"open"`      | အသုံးပြုသူအားလုံးကို ခွင့်ပြုသည် (`"*"` ကို allowFrom တွင် လိုအပ်သည်) |
| `"disabled"`  | DM များကို ပိတ်ပါ                                                     |

---

## ပံ့ပိုးထားသော မက်ဆေ့ချ် အမျိုးအစားများ

### လက်ခံနိုင်သည်

- ✅ စာသား
- ✅ Rich text (post)
- ✅ ပုံများ
- ✅ ဖိုင်များ
- ✅ အသံ
- ✅ ဗီဒီယို
- ✅ Stickers

### ပို့နိုင်သည်

- ✅ စာသား
- ✅ ပုံများ
- ✅ ဖိုင်များ
- ✅ အသံ
- ⚠️ Rich text (တစ်စိတ်တစ်ပိုင်း ပံ့ပိုး)
