---
summary: "နောက်ခံ exec အကောင်အထည်ဖော်ခြင်းနှင့် ပရိုဆက် စီမံခန့်ခွဲမှု"
read_when:
  - နောက်ခံ exec အပြုအမူကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - အချိန်ရှည်လျားစွာ လည်ပတ်နေသော exec လုပ်ငန်းများကို Debugging ပြုလုပ်နေစဉ်
title: "နောက်ခံ Exec နှင့် Process ကိရိယာ"
---

# နောက်ခံ Exec + Process ကိရိယာ

`process` tool သည် ထို background sessions များကို စီမံခန့်ခွဲပါသည်။ အမှန်တကယ် TTY လိုအပ်ပါသလား?

## exec tool

အဓိက ပါရာမီတာများ:

- `command` (လိုအပ်သည်)
- `yieldMs` (မူလတန်ဖိုး 10000): ဤနှောင့်နှေးချိန်ပြီးပါက အလိုအလျောက် နောက်ခံသို့ ပြောင်းသည်
- `background` (bool): ချက်ချင်း နောက်ခံတွင် လည်ပတ်စေသည်
- `timeout` (စက္ကန့်များ၊ မူလတန်ဖိုး 1800): ဤအချိန်ကန့်သတ်ပြီးပါက ပရိုဆက်ကို ပိတ်သတ်မည်
- `elevated` (bool): elevated mode ကို ဖွင့်ထား/ခွင့်ပြုထားပါက ဟို့စ်ပေါ်တွင် လည်ပတ်စေသည်
- `pty: true` ကို သတ်မှတ်ပါ။ `exec`/`process` tools များအပြင်ဘက်တွင် ကြာရှည်အလုပ်လုပ်သော child processes များကို spawn လုပ်ပါက (ဥပမာ CLI respawns သို့မဟုတ် gateway helpers) termination signals များကို forward လုပ်နိုင်ရန်နှင့် exit/error ဖြစ်သည့်အခါ listeners များကို ဖြုတ်ချနိုင်ရန် child-process bridge helper ကို attach လုပ်ပါ။
- `workdir`, `env`

အပြုအမူ:

- Foreground အဖြစ် လည်ပတ်ပါက ထွက်လာသော အထွက်ကို တိုက်ရိုက် ပြန်ပေးသည်။
- နောက်ခံသို့ ပြောင်းသွားပါက (အတိအလင်း သို့မဟုတ် timeout ကြောင့်) ကိရိယာသည် `status: "running"` + `sessionId` နှင့် အတိုချုံး tail ကို ပြန်ပေးသည်။
- ဆက်ရှင်ကို poll လုပ်မည် သို့မဟုတ် clear လုပ်မည် မတိုင်မီ အထွက်ကို မှတ်ဉာဏ်အတွင်း ထိန်းသိမ်းထားသည်။
- `process` ကိရိယာကို ခွင့်မပြုထားပါက `exec` သည် synchronous အဖြစ် လည်ပတ်ပြီး `yieldMs`/`background` ကို လျစ်လျူရှုသည်။

## Child process bridging

ဤအရာသည် systemd ပေါ်တွင် orphaned processes များကို ရှောင်ရှားစေပြီး platform များအကြား shutdown အပြုအမူကို တစ်ပြေးညီ ဖြစ်စေပါသည်။ OpenClaw သည် LAN အတွင်းသာ အသုံးပြုရန် အဆင်ပြေစေရန် Bonjour (mDNS / DNS‑SD) ကို အသုံးပြုပြီး active Gateway (WebSocket endpoint) ကို ရှာဖွေပါသည်။

Environment overrides:

- `PI_BASH_YIELD_MS`: မူလ yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: မှတ်ဉာဏ်အတွင်း အထွက် အကန့်အသတ် (chars)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: stream တစ်ခုချင်းစီအတွက် pending stdout/stderr အကန့်အသတ် (chars)
- `PI_BASH_JOB_TTL_MS`: ပြီးဆုံးပြီးသော ဆက်ရှင်များအတွက် TTL (ms, 1m–3h အတွင်း ကန့်သတ်ထားသည်)

Config (ဦးစားပေး):

- `tools.exec.backgroundMs` (မူလတန်ဖိုး 10000)
- `tools.exec.timeoutSec` (မူလတန်ဖိုး 1800)
- `tools.exec.cleanupMs` (မူလတန်ဖိုး 1800000)
- `tools.exec.notifyOnExit` (မူလတန်ဖိုး true): နောက်ခံထားသော exec တစ်ခု exit ဖြစ်သည့်အခါ system event ကို queue ထဲသို့ ထည့်ပြီး request heartbeat ကို တောင်းဆိုသည်။

## process tool

လုပ်ဆောင်ချက်များ:

- `list`: လည်ပတ်နေသော + ပြီးဆုံးပြီးသော ဆက်ရှင်များ
- `poll`: ဆက်ရှင်တစ်ခုအတွက် ထွက်လာသော အသစ်သော အထွက်ကို drain လုပ်သည် (exit status ကိုလည်း အစီရင်ခံသည်)
- `log`: စုပေါင်းထားသော အထွက်ကို ဖတ်ရှုသည် (`offset` + `limit` ကို ပံ့ပိုးသည်)
- `write`: stdin ပို့သည် (`data`, ရွေးချယ်စရာ `eof`)
- `kill`: နောက်ခံ ဆက်ရှင်တစ်ခုကို အဆုံးသတ်သည်
- `clear`: ပြီးဆုံးပြီးသော ဆက်ရှင်တစ်ခုကို မှတ်ဉာဏ်မှ ဖယ်ရှားသည်
- `remove`: လည်ပတ်နေပါက kill လုပ်ပြီး၊ မဟုတ်ပါက ပြီးဆုံးပြီးသားဖြစ်လျှင် clear လုပ်သည်

မှတ်ချက်များ:

- နောက်ခံထားသော ဆက်ရှင်များသာ စာရင်းပြုလုပ်ထားပြီး မှတ်ဉာဏ်အတွင်း သိမ်းဆည်းထားသည်။
- ပရိုဆက် ပြန်လည်စတင်သည့်အခါ ဆက်ရှင်များ ပျောက်ဆုံးသွားသည် (disk persistence မရှိပါ)။
- `process poll/log` ကို လည်ပတ်ပြီး ကိရိယာ၏ ရလဒ်ကို မှတ်တမ်းတင်ထားသောအခါမှသာ ဆက်ရှင် log များကို chat history ထဲသို့ သိမ်းဆည်းထားသည်။
- `process` သည် agent တစ်ခုချင်းစီအလိုက် သတ်မှတ်ထားပြီး၊ ထို agent မှ စတင်ခဲ့သော ဆက်ရှင်များကိုသာ မြင်နိုင်သည်။
- `process list` တွင် လျင်မြန်စွာ စစ်ဆေးနိုင်ရန် အတွက် ဆင်းသက်လာသော `name` (command verb + target) ပါဝင်သည်။
- `process log` သည် လိုင်းအခြေပြု `offset`/`limit` ကို အသုံးပြုသည် (`offset` ကို ချန်ထားပါက နောက်ဆုံး N လိုင်းများကို ရယူသည်)။

## ဥပမာများ

အချိန်ရှည် လုပ်ငန်းတစ်ခုကို လည်ပတ်ပြီး နောက်မှ poll လုပ်ခြင်း:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

ချက်ချင်း နောက်ခံတွင် စတင်ခြင်း:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdin ပို့ခြင်း:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
