---
summary: "macOS တွင် Gateway ၏ လည်ပတ်မှုအဆင့်များ (launchd)"
read_when:
  - mac app ကို Gateway lifecycle နှင့် ပေါင်းစည်းနေစဉ်
title: "Gateway Lifecycle"
---

# macOS တွင် Gateway lifecycle

31. macOS app သည် ပုံမှန်အားဖြင့် **launchd ဖြင့် Gateway ကို စီမံခန့်ခွဲ** ပြီး Gateway ကို child process အဖြစ် မဖန်တီးပါ။ 32. ၎င်းသည် အရင်ဆုံး သတ်မှတ်ထားသော port ပေါ်တွင် လည်ပတ်နေသော Gateway ရှိမရှိ ချိတ်ဆက်ရန် ကြိုးစားပြီး မရနိုင်ပါက external `openclaw` CLI (embedded runtime မပါ) ဖြင့် launchd service ကို ဖွင့်ပေးပါသည်။ This gives you
    reliable auto‑start at login and restart on crashes.

34. Child‑process mode (Gateway ကို app မှ တိုက်ရိုက် spawn လုပ်ခြင်း) ကို ယနေ့အထိ **မအသုံးပြုပါ**။
35. UI နှင့် ပိုမို တင်းကျပ်စွာ ချိတ်ဆက်လိုပါက Gateway ကို terminal ထဲတွင် ကိုယ်တိုင် လည်ပတ်ပါ။

## မူလအပြုအမူ (launchd)

- 36. app သည် per‑user LaunchAgent ကို `bot.molt.gateway` အဖြစ် ထည့်သွင်းပေးပါသည်37.  (`--profile`/`OPENCLAW_PROFILE` ကို အသုံးပြုပါက `bot.molt.<profile>`; legacy `com.openclaw.*` ကို ပံ့ပိုးထားပါသည်)။
- Local mode ကို ဖွင့်ထားသောအခါ LaunchAgent ကို load လုပ်ထားကြောင်း အတည်ပြုပြီး
  လိုအပ်ပါက Gateway ကို စတင်ပါသည်။
- လော့ဂ်များကို launchd gateway log path တွင် ရေးသားပါသည် (Debug Settings တွင် မြင်နိုင်ပါသည်)။

အသုံးများသော အမိန့်များ—

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

38. named profile ဖြင့် လည်ပတ်သောအခါ label ကို `bot.molt.<profile>` ဖြင့် အစားထိုးပါ။39.

## လက်မှတ်မထိုးထားသော dev builds

40. `scripts/restart-mac.sh --no-sign` ကို signing key မရှိသည့် အချိန် အမြန် local build များအတွက် အသုံးပြုပါသည်။ 41. unsigned relay binary ကို launchd မှ မညွှန်ပြစေရန် ၎င်းသည် -

- `~/.openclaw/disable-launchagent` ကို ရေးသားပါသည်။

42. `scripts/restart-mac.sh` ကို signed ဖြင့် လည်ပတ်ပါက marker ရှိနေသည့်အခါ ဤ override ကို ဖယ်ရှားပေးပါသည်။ 43. လက်ဖြင့် ပြန်လည် reset လုပ်ရန် -

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only mode

44. macOS app ကို **launchd ကို ဘယ်တော့မှ မထည့်သွင်း သို့မဟုတ် မစီမံစေရန်** `--attach-only` (သို့မဟုတ် `--no-launchd`) ဖြင့် ဖွင့်ပါ။ 45. ၎င်းသည် `~/.openclaw/disable-launchagent` ကို သတ်မှတ်ပြီး app သည် လည်ပတ်နေပြီးသား Gateway သို့သာ ချိတ်ဆက်ပါမည်။ 46. Debug Settings တွင် အလားတူ အပြုအမူကို ပြောင်းလဲနိုင်ပါသည်။

## Remote mode

47. Remote mode သည် local Gateway ကို ဘယ်တော့မှ မစတင်ပါ။ 48. app သည် remote host သို့ SSH tunnel ကို အသုံးပြုပြီး ထို tunnel မှတဆင့် ချိတ်ဆက်ပါသည်။

## launchd ကို ဦးစားပေးသည့် အကြောင်းရင်းများ

- Login အချိန်တွင် အလိုအလျောက် စတင်ခြင်း။
- Built‑in restart/KeepAlive အပြုအမူများ။
- ခန့်မှန်းနိုင်သော လော့ဂ်များနှင့် ကြီးကြပ်စောင့်ကြည့်မှု။

အကယ်၍ တကယ့် child‑process mode ကို နောက်တစ်ကြိမ် လိုအပ်လာပါက သီးခြား၊ ထင်ရှားသော dev‑only mode အဖြစ် မှတ်တမ်းတင်ဖော်ပြသင့်ပါသည်။
