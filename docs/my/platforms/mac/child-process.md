---
summary: "macOS တွင် Gateway ၏ လည်ပတ်မှုအဆင့်များ (launchd)"
read_when:
  - mac app ကို Gateway lifecycle နှင့် ပေါင်းစည်းနေစဉ်
title: "Gateway Lifecycle"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:41Z
---

# macOS တွင် Gateway lifecycle

macOS အက်ပ်သည် မူလအတိုင်း **launchd ကို အသုံးပြုပြီး Gateway ကို စီမံခန့်ခွဲသည်**၊ Gateway ကို child process အဖြစ် မဖန်တီးပါ။ ပထမဦးစွာ သတ်မှတ်ထားသော ပေါ့တ်တွင် လည်ပတ်နေပြီးသား Gateway တစ်ခုကို ချိတ်ဆက်ရန် ကြိုးစားပါသည်။ ချိတ်ဆက်နိုင်သော Gateway မရှိပါက external `openclaw` CLI ကို အသုံးပြုပြီး launchd service ကို ဖွင့်လှစ်ပါသည် (embedded runtime မပါဝင်ပါ)။ ၎င်းကြောင့် login အချိန်တွင် အလိုအလျောက် စတင်ခြင်းနှင့် crash ဖြစ်ပါက ပြန်လည်စတင်ခြင်းကို ယုံကြည်စိတ်ချရစေပါသည်။

Child‑process mode (Gateway ကို အက်ပ်မှ တိုက်ရိုက် spawn လုပ်ခြင်း) ကို ယနေ့အထိ **မအသုံးပြုသေးပါ**။ UI နှင့် ပိုမိုနီးကပ်စွာ ချိတ်ဆက်ရန် လိုအပ်ပါက Gateway ကို terminal မှ လက်ဖြင့် chạy လုပ်ပါ။

## မူလအပြုအမူ (launchd)

- အက်ပ်သည် per‑user LaunchAgent တစ်ခုကို `bot.molt.gateway` ဟူသော label ဖြင့် ထည့်သွင်းပါသည်
  (`--profile`/`OPENCLAW_PROFILE` ကို အသုံးပြုသည့်အခါ `bot.molt.<profile>` ဖြစ်ပြီး; legacy `com.openclaw.*` ကိုလည်း ထောက်ပံ့ပါသည်)။
- Local mode ကို ဖွင့်ထားသောအခါ LaunchAgent ကို load လုပ်ထားကြောင်း အတည်ပြုပြီး
  လိုအပ်ပါက Gateway ကို စတင်ပါသည်။
- လော့ဂ်များကို launchd gateway log path တွင် ရေးသားပါသည် (Debug Settings တွင် မြင်နိုင်ပါသည်)။

အသုံးများသော အမိန့်များ—

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

named profile ကို chạy လုပ်နေပါက label ကို `bot.molt.<profile>` ဖြင့် အစားထိုးပါ။

## လက်မှတ်မထိုးထားသော dev builds

`scripts/restart-mac.sh --no-sign` သည် signing keys မရှိသေးသည့် အခြေအနေတွင် မြန်ဆန်သော local builds အတွက် ဖြစ်ပါသည်။ launchd သည် လက်မှတ်မထိုးထားသော relay binary ကို မညွှန်စေရန်—

- `~/.openclaw/disable-launchagent` ကို ရေးသားပါသည်။

`scripts/restart-mac.sh` ကို signed အနေဖြင့် chạy လုပ်ပါက marker ရှိနေပါက ဤ override ကို ဖယ်ရှားပါသည်။ လက်ဖြင့် reset လုပ်ရန်—

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only mode

macOS အက်ပ်သည် **launchd ကို မတပ်ဆင်ဘဲ မစီမံခန့်ခွဲရန်** အတင်းအကျပ် ပြုလုပ်လိုပါက
`--attach-only` (သို့မဟုတ် `--no-launchd`) ဖြင့် စတင်ပါ။ ၎င်းသည် `~/.openclaw/disable-launchagent` ကို သတ်မှတ်ပြီး
အက်ပ်သည် လည်ပတ်နေပြီးသား Gateway တစ်ခုကိုသာ ချိတ်ဆက်ပါမည်။ Debug Settings တွင်လည်း အလားတူ အပြုအမူကို ပြောင်းလဲနိုင်ပါသည်။

## Remote mode

Remote mode တွင် local Gateway ကို မစတင်ပါ။ အက်ပ်သည် remote ဟို့စ်သို့ SSH တန်နယ်ကို အသုံးပြုပြီး ထိုတန်နယ်မှတဆင့် ချိတ်ဆက်ပါသည်။

## launchd ကို ဦးစားပေးသည့် အကြောင်းရင်းများ

- Login အချိန်တွင် အလိုအလျောက် စတင်ခြင်း။
- Built‑in restart/KeepAlive အပြုအမူများ။
- ခန့်မှန်းနိုင်သော လော့ဂ်များနှင့် ကြီးကြပ်စောင့်ကြည့်မှု။

အကယ်၍ တကယ့် child‑process mode ကို နောက်တစ်ကြိမ် လိုအပ်လာပါက သီးခြား၊ ထင်ရှားသော dev‑only mode အဖြစ် မှတ်တမ်းတင်ဖော်ပြသင့်ပါသည်။
