---
summary: "Twitch ချတ် ဘော့၏ ဖွဲ့စည်းပြင်ဆင်မှုနှင့် တပ်ဆင်ခြင်း"
read_when:
  - OpenClaw အတွက် Twitch ချတ် ပေါင်းစည်းမှုကို တပ်ဆင်သည့်အခါ
title: "Twitch"
---

# Twitch (plugin)

Twitch chat support via IRC connection. OpenClaw connects as a Twitch user (bot account) to receive and send messages in channels.

## Plugin လိုအပ်ချက်

Twitch သည် plugin အဖြစ် ဖြန့်ချိထားပြီး core install တွင် မပါဝင်ပါ။

CLI (npm registry) ဖြင့် ထည့်သွင်းရန်—

```bash
openclaw plugins install @openclaw/twitch
```

Local checkout (git repo မှ လည်ပတ်စေသည့်အခါ)—

```bash
openclaw plugins install ./extensions/twitch
```

အသေးစိတ်: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. ဘော့အတွက် သီးသန့် Twitch အကောင့်တစ်ခု ဖန်တီးပါ (သို့မဟုတ် ရှိပြီးသား အကောင့်ကို အသုံးပြုနိုင်သည်)။
2. အထောက်အထားများ ထုတ်ယူပါ: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - **Bot Token** ကို ရွေးချယ်ပါ
   - `chat:read` နှင့် `chat:write` scope များကို ရွေးထားကြောင်း အတည်ပြုပါ
   - **Client ID** နှင့် **Access Token** ကို ကူးယူပါ
3. သင့် Twitch user ID ကို ရှာဖွေပါ: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Token ကို ဖွဲ့စည်းပြင်ဆင်ပါ—
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (default account အတွက်သာ)
   - သို့မဟုတ် config: `channels.twitch.accessToken`
   - နှစ်ခုလုံး သတ်မှတ်ထားပါက config သည် ဦးစားပေးအဖြစ် အသုံးပြုမည် (env fallback သည် default-account အတွက်သာ)။
5. Gateway ကို စတင်ပါ။

**⚠️ Important:** Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot. `requireMention` defaults to `true`.

အနည်းဆုံး config:

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

## What it is

- Gateway ပိုင်ဆိုင်သည့် Twitch ချန်နယ်တစ်ခု။
- သတ်မှတ်ထားသည့် လမ်းကြောင်းပြန်ကြားမှု: ပြန်ကြားချက်များသည် အမြဲ Twitch သို့ ပြန်သွားသည်။
- အကောင့်တစ်ခုစီသည် သီးခြား session key `agent:<agentId>:twitch:<accountName>` သို့ မြေပုံချထားသည်။
- `username` သည် bot ၏ အကောင့် (အတည်ပြုချိတ်ဆက်သူ) ဖြစ်ပြီး `channel` သည် ဝင်ရောက်မည့် ချတ်ခန်းကို ဆိုလိုသည်။

## Setup (detailed)

### Generate credentials

[Twitch Token Generator](https://twitchtokengenerator.com/) ကို အသုံးပြုပါ—

- **Bot Token** ကို ရွေးချယ်ပါ
- `chat:read` နှင့် `chat:write` scope များကို ရွေးထားကြောင်း အတည်ပြုပါ
- **Client ID** နှင့် **Access Token** ကို ကူးယူပါ

No manual app registration needed. Tokens expire after several hours.

### Configure the bot

**Env var (default account အတွက်သာ):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**သို့မဟုတ် config:**

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

Env နှင့် config နှစ်ခုလုံး သတ်မှတ်ထားပါက config သည် ဦးစားပေးအဖြစ် အသုံးပြုမည်။

### Access control (အကြံပြု)

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

**ရရှိနိုင်သော roles:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`။

**Why user IDs?** Usernames can change, allowing impersonation. User IDs are permanent.

သင့် Twitch user ID ကို ရှာဖွေရန်: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (သင့် Twitch username ကို ID သို့ ပြောင်းရန်)

## Token refresh (optional)

[Twitch Token Generator](https://twitchtokengenerator.com/) မှ ထုတ်ယူထားသော token များကို အလိုအလျောက် refresh မလုပ်နိုင်ပါ—သက်တမ်းကုန်ပါက ပြန်လည် ထုတ်ယူပါ။

အလိုအလျောက် token refresh အတွက် [Twitch Developer Console](https://dev.twitch.tv/console) တွင် ကိုယ်ပိုင် Twitch application တစ်ခု ဖန်တီးပြီး config ထဲသို့ ထည့်ပါ—

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

ဘော့သည် သက်တမ်းကုန်မီ token များကို အလိုအလျောက် refresh လုပ်ပြီး refresh ဖြစ်ရပ်များကို log ထဲတွင် မှတ်တမ်းတင်ပါသည်။

## Multi-account support

Use `channels.twitch.accounts` with per-account tokens. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

ဥပမာ (ဘော့အကောင့်တစ်ခုကို ချန်နယ်နှစ်ခုတွင် အသုံးပြုခြင်း)—

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

**မှတ်ချက်:** အကောင့်တစ်ခုစီအတွက် token တစ်ခု လိုအပ်ပါသည် (ချန်နယ်တစ်ခုလျှင် token တစ်ခု)။

## Access control

### Role-based ကန့်သတ်ချက်များ

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

### User ID ဖြင့် Allowlist (အလုံခြုံဆုံး)

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

### Role-based ဝင်ရောက်ခွင့် (အစားထိုး)

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

### @mention လိုအပ်ချက်ကို ပိတ်ရန်

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

## Troubleshooting

ပထမဦးစွာ စမ်းသပ်အတည်ပြု command များကို လည်ပတ်ပါ—

```bash
openclaw doctor
openclaw channels status --probe
```

### ဘော့က မက်ဆေ့ချ်များကို မတုံ့ပြန်ပါ

**Access control ကို စစ်ဆေးပါ:** သင့် user ID သည် `allowFrom` ထဲတွင် ပါဝင်ကြောင်း အတည်ပြုပါ၊ သို့မဟုတ် ယာယီအားဖြင့်
`allowFrom` ကို ဖယ်ရှားပြီး စမ်းသပ်ရန် `allowedRoles: ["all"]` ကို သတ်မှတ်ပါ။

**ဘော့သည် ချန်နယ်ထဲတွင် ရှိကြောင်း စစ်ဆေးပါ:** ဘော့သည် `channel` တွင် သတ်မှတ်ထားသော ချန်နယ်ကို join လုပ်ရပါမည်။

### Token ပြဿနာများ

**"Failed to connect" သို့မဟုတ် authentication အမှားများ:**

- `accessToken` သည် OAuth access token တန်ဖိုးဖြစ်ကြောင်း အတည်ပြုပါ (အများအားဖြင့် `oauth:` prefix ဖြင့် စတင်သည်)
- Token တွင် `chat:read` နှင့် `chat:write` scope များ ပါဝင်ကြောင်း စစ်ဆေးပါ
- Token refresh ကို အသုံးပြုနေပါက `clientSecret` နှင့် `refreshToken` သတ်မှတ်ထားကြောင်း အတည်ပြုပါ

### Token refresh မလုပ်နိုင်ပါ

**Refresh ဖြစ်ရပ်များအတွက် log များကို စစ်ဆေးပါ:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

"token refresh disabled (no refresh token)" ဟု တွေ့ပါက—

- `clientSecret` ကို ပေးထားကြောင်း သေချာပါစေ
- `refreshToken` ကို ပေးထားကြောင်း သေချာပါစေ

## Config

**Account config:**

- `username` - Bot username
- `accessToken` - `chat:read` နှင့် `chat:write` ပါသော OAuth access token
- `clientId` - Twitch Client ID (Token Generator သို့မဟုတ် သင့် app မှ)
- `channel` - Join လုပ်မည့် ချန်နယ် (လိုအပ်သည်)
- `enabled` - ဤအကောင့်ကို ဖွင့်/ပိတ် (မူလ: `true`)
- `clientSecret` - Optional: အလိုအလျောက် token refresh အတွက်
- `refreshToken` - Optional: အလိုအလျောက် token refresh အတွက်
- `expiresIn` - Token သက်တမ်း (စက္ကန့်)
- `obtainmentTimestamp` - Token ရရှိခဲ့သည့် အချိန်တံဆိပ်
- `allowFrom` - User ID allowlist
- `allowedRoles` - Role-based access control (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - @mention လိုအပ်ချက် (မူလ: `true`)

**Provider options:**

- `channels.twitch.enabled` - ချန်နယ် စတင်မှုကို ဖွင့်/ပိတ်
- `channels.twitch.username` - Bot username (လွယ်ကူသော single-account config)
- `channels.twitch.accessToken` - OAuth access token (လွယ်ကူသော single-account config)
- `channels.twitch.clientId` - Twitch Client ID (လွယ်ကူသော single-account config)
- `channels.twitch.channel` - Join လုပ်မည့် ချန်နယ် (လွယ်ကူသော single-account config)
- `channels.twitch.accounts.<accountName>` - Multi-account config (all account fields above)

အပြည့်အစုံ ဥပမာ—

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

## Tool actions

အေးဂျင့်သည် `twitch` ကို action ဖြင့် ခေါ်နိုင်သည်—

- `send` - ချန်နယ်တစ်ခုသို့ မက်ဆေ့ချ်ပို့ရန်

ဥပမာ—

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Safety & ops

- **Token များကို စကားဝှက်ကဲ့သို့ သဘောထားပါ** — Token များကို git တွင် မတင်ပါနှင့်
- **အလိုအလျောက် token refresh ကို အသုံးပြုပါ** — ရေရှည် လည်ပတ်သော ဘော့များအတွက်
- **User ID allowlist များကို အသုံးပြုပါ** — Access control အတွက် username များအစား
- **Log များကို စောင့်ကြည့်ပါ** — Token refresh ဖြစ်ရပ်များနှင့် ချိတ်ဆက်မှု အခြေအနေ
- **Scope များကို အနည်းဆုံးသာ တောင်းပါ** — `chat:read` နှင့် `chat:write` ကိုသာ
- **မဖြေရှင်းနိုင်ပါက**: Session ကို အခြား process မပိုင်ဆိုင်ကြောင်း အတည်ပြုပြီးနောက် Gateway ကို ပြန်လည် စတင်ပါ

## Limits

- မက်ဆေ့ချ်တစ်ခုလျှင် **စာလုံး 500** (စကားလုံး အစွန်းအထင်းများအလိုက် အလိုအလျောက် ခွဲပို့သည်)
- Chunking မလုပ်မီ Markdown ကို ဖယ်ရှားပါသည်
- Rate limiting မရှိပါ (Twitch ၏ built-in rate limits ကို အသုံးပြုသည်)
