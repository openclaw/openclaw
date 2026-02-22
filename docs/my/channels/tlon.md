---
summary: "Tlon/Urbit အထောက်အပံ့ အခြေအနေ၊ လုပ်ဆောင်နိုင်မှုများနှင့် ဖွဲ့စည်းပြင်ဆင်မှု"
read_when:
  - Tlon/Urbit ချန်နယ် အင်္ဂါရပ်များကို လုပ်ဆောင်နေချိန်
title: "Tlon"
---

# Tlon (plugin)

Tlon is a decentralized messenger built on Urbit. OpenClaw connects to your Urbit ship and can
respond to DMs and group chat messages. Group replies require an @ mention by default and can
be further restricted via allowlists.

Status: supported via plugin. DMs, group mentions, thread replies, and text-only media fallback
(URL appended to caption). Reactions, polls, and native media uploads are not supported.

## Plugin required

Tlon ကို plugin အဖြစ် ပေးပို့ထားပြီး core install တွင် မပါဝင်ပါ။

CLI (npm registry) ဖြင့် ထည့်သွင်းရန်:

```bash
openclaw plugins install @openclaw/tlon
```

Local checkout (git repo မှ လည်ပတ်နေသည့်အခါ):

```bash
openclaw plugins install ./extensions/tlon
```

အသေးစိတ်: [Plugins](/tools/plugin)

## Setup

1. Tlon plugin ကို ထည့်သွင်းပါ။
2. သင့် ship URL နှင့် login code ကို စုဆောင်းပါ။
3. `channels.tlon` ကို ဖွဲ့စည်းပြင်ဆင်ပါ။
4. Gateway（ဂိတ်ဝေး） ကို ပြန်လည်စတင်ပါ။
5. ဘော့ကို DM ပို့ပါ သို့မဟုတ် အုပ်စု ချန်နယ်တွင် mention လုပ်ပါ။

အနည်းဆုံး ဖွဲ့စည်းပြင်ဆင်မှု (အကောင့်တစ်ခုတည်း):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Group channels

Auto-discovery is enabled by default. You can also pin channels manually:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Auto-discovery ကို ပိတ်ရန်:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Access control

DM allowlist (ဗလာ = အားလုံး ခွင့်ပြု):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

အုပ်စု ခွင့်ပြုချက် (ပုံမှန်အားဖြင့် ကန့်သတ်ထားသည်):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Delivery targets (CLI/cron)

`openclaw message send` သို့မဟုတ် cron delivery နှင့်အတူ အသုံးပြုပါ:

- DM: `~sampel-palnet` သို့မဟုတ် `dm/~sampel-palnet`
- Group: `chat/~host-ship/channel` သို့မဟုတ် `group:~host-ship/channel`

## Notes

- အုပ်စုတွင် တုံ့ပြန်ရန် mention (ဥပမာ `~your-bot-ship`) လိုအပ်သည်။
- Thread တုံ့ပြန်ချက်များ: ဝင်လာသော မက်ဆေ့ချ်သည် thread အတွင်းဖြစ်ပါက OpenClaw သည် thread အတွင်း၌ပင် တုံ့ပြန်သည်။
- မီဒီယာ: `sendMedia` သည် စာသား + URL သို့ fallback လုပ်သည် (native upload မရှိပါ)။
