---
summary: "OpenClaw အက်ပ်၊ Gateway နိုဒ် ပို့ဆောင်ရေးနှင့် PeekabooBridge အတွက် macOS IPC အင်ဂျင်နီယာဖွဲ့စည်းပုံ"
read_when:
  - IPC စာချုပ်များ သို့မဟုတ် မီနူးဘား အက်ပ် IPC ကို ပြင်ဆင်နေချိန်
title: "macOS IPC"
---

# OpenClaw macOS IPC အင်ဂျင်နီယာဖွဲ့စည်းပုံ

**Current model:** local Unix socket တစ်ခုဖြင့် **node host service** နှင့် **macOS app** ကို exec approvals + `system.run` အတွက် ချိတ်ဆက်ထားသည်။ Discovery/connect စစ်ဆေးရန် `openclaw-mac` debug CLI တစ်ခု ရှိသည်; agent actions များသည် Gateway WebSocket နှင့် `node.invoke` မှတစ်ဆင့် ဆက်လက် လုပ်ဆောင်သည်။ UI automation သည် PeekabooBridge ကို အသုံးပြုသည်။

## ရည်မှန်းချက်များ

- TCC နှင့် ဆိုင်သော အလုပ်များအားလုံး (notifications, screen recording, mic, speech, AppleScript) ကို ပိုင်ဆိုင်သည့် GUI အက်ပ် instance တစ်ခုတည်း။
- အလိုအလျောက်လုပ်ဆောင်မှုအတွက် မျက်နှာပြင်သေးငယ်မှု: Gateway + node အမိန့်များ၊ နှင့် UI automation အတွက် PeekabooBridge။
- ခန့်မှန်းနိုင်သော ခွင့်ပြုချက်များ: launchd မှ စတင်ဖွင့်လှစ်ထားပြီး အမြဲတမ်း တူညီသော signed bundle ID ကို အသုံးပြုသောကြောင့် TCC ခွင့်ပြုချက်များ တည်မြဲနေစေသည်။

## အလုပ်လုပ်ပုံ

### Gateway + node ပို့ဆောင်ရေး

- အက်ပ်သည် Gateway ကို (local mode) ဖြင့် လည်ပတ်စေပြီး နိုဒ်တစ်ခုအဖြစ် ၎င်းသို့ ချိတ်ဆက်သည်။
- Agent အရေးယူမှုများကို `node.invoke` (ဥပမာ `system.run`, `system.notify`, `canvas.*`) မှတစ်ဆင့် ဆောင်ရွက်သည်။

### Node service + app IPC

- headless node host service တစ်ခုသည် Gateway WebSocket သို့ ချိတ်ဆက်ထားသည်။
- `system.run` တောင်းဆိုချက်များကို local Unix socket မှတစ်ဆင့် macOS app သို့ လွှဲပြောင်းပို့သည်။
- အက်ပ်သည် UI context အတွင်း exec ကို ဆောင်ရွက်ပြီး လိုအပ်ပါက မေးမြန်းကာ output ကို ပြန်လည်ပေးပို့သည်။

Diagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI automation)

- UI automation သည် `bridge.sock` ဟု အမည်ပေးထားသော သီးခြား UNIX socket နှင့် PeekabooBridge JSON protocol ကို အသုံးပြုသည်။
- Host preference အစီအစဉ် (client-side): Peekaboo.app → Claude.app → OpenClaw.app → local execution။
- လုံခြုံရေး: bridge ဟို့စ်များအတွက် ခွင့်ပြုထားသော TeamID လိုအပ်သည်။ DEBUG-only same-UID escape hatch ကို `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo စံနည်းလမ်း) ဖြင့် ကာကွယ်ထားသည်။
- အသေးစိတ်အတွက် [PeekabooBridge usage](/platforms/mac/peekaboo) ကို ကြည့်ပါ။

## လုပ်ငန်းလည်ပတ်မှု စီးဆင်းပုံများ

- Restart/rebuild: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - ရှိပြီးသား instance များကို သတ်ပစ်သည်
  - Swift build + package
  - LaunchAgent ကို ရေးသား/bootstraps/kickstarts လုပ်သည်
- Single instance: တူညီသော bundle ID ဖြင့် အခြား instance တစ်ခု လည်ပတ်နေပါက အက်ပ်သည် အစောပိုင်းတွင် ထွက်ခွာသည်။

## Hardening မှတ်စုများ

- Privileged surfaces အားလုံးအတွက် TeamID ကိုက်ညီမှုကို လိုအပ်အောင် ပြုလုပ်ခြင်းကို ဦးစားပေးပါ။
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) သည် local development အတွက် same-UID ခေါ်ယူသူများကို ခွင့်ပြုနိုင်သည်။
- ဆက်သွယ်မှုအားလုံးသည် local-only ဖြစ်ပြီး network socket များကို မဖော်ပြပါ။
- TCC မေးမြန်းချက်များသည် GUI အက်ပ် bundle မှသာ စတင်လာသည်။ signed bundle ID ကို rebuild များကြားတွင် တည်ငြိမ်အောင် ထိန်းထားပါ။
- IPC hardening: socket mode `0600`, token, peer-UID စစ်ဆေးမှုများ, HMAC challenge/response, short TTL။
