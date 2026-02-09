---
summary: "`openclaw directory` အတွက် CLI ကိုးကားချက် (ကိုယ်တိုင်၊ peers၊ အုပ်စုများ)"
read_when:
  - ချန်နယ်တစ်ခုအတွက် ဆက်သွယ်ရန်/အုပ်စု/ကိုယ်တိုင်၏ ID များကို ရှာဖွေရန်လိုအပ်သည့်အခါ
  - ချန်နယ် directory adapter တစ်ခုကို ဖွံ့ဖြိုးတည်ဆောက်နေသည့်အခါ
title: "directory"
---

# `openclaw directory`

ထောက်ပံ့ပေးထားသော ချန်နယ်များအတွက် Directory ရှာဖွေမှုများ (ဆက်သွယ်ရန်/peers၊ အုပ်စုများ၊ နှင့် “me”).

## Common flags

- `--channel <name>`: ချန်နယ် id/alias (ချန်နယ်များစွာကို ပြင်ဆင်ထားသောအခါ လိုအပ်သည်; တစ်ခုတည်းသာ ပြင်ဆင်ထားပါက အလိုအလျောက်)
- `--account <id>`: အကောင့် id (မူလတန်ဖိုး: ချန်နယ်၏ မူလအကောင့်)
- `--json`: JSON အဖြစ် ထုတ်ပေးသည်

## Notes

- `directory` သည် အခြား အမိန့်များထဲသို့ ကူးထည့်နိုင်သော ID များကို ရှာဖွေရန် ကူညီရန် ရည်ရွယ်ထားသည် (အထူးသဖြင့် `openclaw message send --target ...`).
- ချန်နယ်အများအပြားတွင် ရလဒ်များသည် တိုက်ရိုက် provider directory မဟုတ်ဘဲ config အပေါ်အခြေခံထားသော (allowlists / ပြင်ဆင်ထားသော အုပ်စုများ) ဖြစ်သည်။
- မူလ ထုတ်ပေးပုံစံမှာ `id` (နှင့် တခါတရံ `name`) ကို tab ဖြင့် ခွဲထားခြင်းဖြစ်ပြီး; scripting အတွက် `--json` ကို အသုံးပြုပါ။

## `message send` နှင့် ရလဒ်များကို အသုံးပြုခြင်း

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID ဖော်မတ်များ (ချန်နယ်အလိုက်)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)
- Telegram: `@username` သို့မဟုတ် ကိန်းဂဏန်း chat id; အုပ်စုများမှာ ကိန်းဂဏန်း id များဖြစ်သည်
- Slack: `user:U…` နှင့် `channel:C…`
- Discord: `user:<id>` နှင့် `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, သို့မဟုတ် `#alias:server`
- Microsoft Teams (plugin): `user:<id>` နှင့် `conversation:<id>`
- Zalo (plugin): အသုံးပြုသူ id (Bot API)
- Zalo Personal / `zalouser` (plugin): `zca` မှ thread id (DM/group) (`me`, `friend list`, `group list`)

## ကိုယ်တိုင် (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (ဆက်သွယ်ရန်/အသုံးပြုသူများ)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## အုပ်စုများ

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
