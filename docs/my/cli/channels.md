---
summary: "`openclaw channels` အတွက် CLI ကိုးကားချက် (အကောင့်များ၊ အခြေအနေ၊ လော့ဂ်အင်/လော့ဂ်အောက်၊ လော့ဂ်များ)"
read_when:
  - ချန်နယ်အကောင့်များ (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage) ကို ထည့်သွင်း/ဖယ်ရှား လုပ်ချင်သောအခါ
  - ချန်နယ် အခြေအနေကို စစ်ဆေးလိုသောအခါ သို့မဟုတ် ချန်နယ် လော့ဂ်များကို tail လုပ်ချင်သောအခါ
title: "channels"
---

# `openclaw channels`

Gateway ပေါ်ရှိ ချတ် ချန်နယ်အကောင့်များနှင့် ၎င်းတို့၏ runtime အခြေအနေကို စီမံခန့်ခွဲပါ။

ဆက်စပ် စာတမ်းများ—

- ချန်နယ် လမ်းညွှန်များ: [Channels](/channels/index)
- Gateway ဖွဲ့စည်းပြင်ဆင်ခြင်း: [Configuration](/gateway/configuration)

## Common commands

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Add / remove accounts

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

အကြံပြုချက်: `openclaw channels add --help` သည် ချန်နယ်တစ်ခုချင်းစီအလိုက် flag များ (token, app token, signal-cli လမ်းကြောင်းများ စသည်) ကို ပြသပါသည်။

## Login / logout (interactive)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Troubleshooting

- ကျယ်ပြန့်စွာ စစ်ဆေးရန် `openclaw status --deep` ကို ပြုလုပ်ပါ။
- လမ်းညွှန်အတိုင်း ပြုပြင်ရန် `openclaw doctor` ကို အသုံးပြုပါ။
- `openclaw channels list` သည် `Claude: HTTP 403 ...` ကို print ထုတ်သည်။ `user:profile` → usage snapshot အတွက် `user:profile` scope လိုအပ်သည်။ `--no-usage` ကို အသုံးပြုပါ၊ သို့မဟုတ် claude.ai session key (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`) ပေးပါ၊ သို့မဟုတ် Claude Code CLI မှတစ်ဆင့် ပြန်လည် authenticate လုပ်ပါ။

## Capabilities probe

provider ၏ capability အညွှန်းများ (ရရှိနိုင်သည့် intents/scopes) နှင့် static feature ထောက်ပံ့မှုကို ရယူပါ—

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

မှတ်ချက်များ—

- `--channel` သည် မဖြစ်မနေ မလိုအပ်ပါ။ ချန်နယ်အားလုံး (extension များပါဝင်) ကို စာရင်းပြုလုပ်ရန် မထည့်ဘဲ ထားနိုင်ပါသည်။
- `--target` သည် `channel:<id>` သို့မဟုတ် raw numeric channel id ကို လက်ခံပြီး Discord တွင်သာ သက်ဆိုင်ပါသည်။
- Probes များသည် provider အလိုက် သီးခြားဖြစ်သည်: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (သိရှိသလောက် annotation လုပ်ထားသည်)။ probes မရှိသော channels များသည် `Probe: unavailable` ဟု report လုပ်မည်။

## Resolve names to IDs

provider directory ကို အသုံးပြုပြီး ချန်နယ်/အသုံးပြုသူ အမည်များကို ID များအဖြစ် ပြောင်းလဲပါ—

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

မှတ်ချက်များ—

- ပစ်မှတ်အမျိုးအစားကို အတင်းအကျပ် သတ်မှတ်ရန် `--kind user|group|auto` ကို အသုံးပြုပါ။
- အမည်တူ အချက်အလက်များ အများအပြားရှိပါက resolution သည် လက်ရှိ အသုံးပြုနေသော match များကို ဦးစားပေးပါသည်။
