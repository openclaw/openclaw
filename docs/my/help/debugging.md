---
summary: "Debugging ကိရိယာများ — watch mode၊ raw model stream များနှင့် reasoning leakage ကို ခြေရာခံခြင်း"
read_when:
  - reasoning leakage ကို စစ်ဆေးရန် raw model output ကို ကြည့်ရှုလိုအပ်သောအခါ
  - အပြောင်းအလဲလုပ်နေစဉ် Gateway（ဂိတ်ဝေး）ကို watch mode ဖြင့် လည်ပတ်စေလိုသောအခါ
  - ပြန်လည်လုပ်ဆောင်နိုင်သော debugging workflow တစ်ခု လိုအပ်သောအခါ
title: "Debugging"
---

# Debugging

ဤစာမျက်နှာသည် streaming output အတွက် debugging အထောက်အကူများကို ဖော်ပြထားပြီး၊ provider တစ်ခုက reasoning ကို ပုံမှန်စာသားအတွင်း ရောနှောပေးသောအခါတွင် အထူးအသုံးဝင်သည်။

## Runtime debug overrides

chat ထဲတွင် `/debug` ကို အသုံးပြု၍ **runtime-only** config override များ (memory ထဲသာ၊ disk မရေး) ကို သတ်မှတ်ပါ။
`/debug` သည် default အနေဖြင့် ပိတ်ထားပြီး `commands.debug: true` ဖြင့် ဖွင့်နိုင်ပါသည်။
`openclaw.json` ကို မတည်းဖြတ်ဘဲ ရှားပါးသော setting များကို ပြောင်းလဲရန် လိုအပ်သည့်အခါ အသုံးဝင်ပါသည်။

ဥပမာများ—

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` သည် override အားလုံးကို ရှင်းလင်းပြီး disk ပေါ်ရှိ config သို့ ပြန်သွားစေသည်။

## Gateway watch mode

အမြန် iteration အတွက် file watcher အောက်တွင် gateway ကို လည်ပတ်စေပါ—

```bash
pnpm gateway:watch --force
```

ဤသည်သည် အောက်ပါအတိုင်း map ဖြစ်သည်—

```bash
tsx watch src/entry.ts gateway --force
```

`gateway:watch` နောက်တွင် gateway CLI flags မည်သည့်အရာမဆို ထည့်ပါက restart တစ်ကြိမ်စီတွင် pass-through လုပ်ပေးမည်ဖြစ်သည်။

## Dev profile + dev gateway (--dev)

state ကို သီးခြားထားရန်နှင့် debugging အတွက် လုံခြုံပြီး ခဏတာ အသုံးပြုနိုင်သော setup တစ်ခုကို စတင်ရန် dev profile ကို အသုံးပြုပါ။ **နှစ်ခု** ရှိသော `--dev` flags များ ရှိပါသည်:

- **Global `--dev` (profile):** state ကို `~/.openclaw-dev` အောက်တွင် ခွဲခြားထားပြီး
  gateway port ကို မူလအားဖြင့် `19001` သို့ သတ်မှတ်သည် (ဆက်စပ် port များသည် အတူတကွ ရွှေ့ပြောင်းမည်)။
- **`gateway --dev`: Gateway ကို မရှိသေးပါက default config + workspace ကို အလိုအလျောက် ဖန်တီးစေပြီး
  BOOTSTRAP.md ကို ကျော်လွှားသည်**။

အကြံပြု workflow (dev profile + dev bootstrap)—

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

global install မရှိသေးပါက CLI ကို `pnpm openclaw ...` မှတစ်ဆင့် လည်ပတ်ပါ။

ဤအရာများကို လုပ်ဆောင်သည်—

1. **Profile isolation** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas များလည်း အလိုက်အညီ ပြောင်းရွှေ့သည်)

2. **Dev bootstrap** (`gateway --dev`)
   - မရှိပါက အနည်းဆုံး config ကို ရေးသားပေးသည် (`gateway.mode=local`, bind loopback)။
   - `agent.workspace` ကို dev workspace သို့ သတ်မှတ်သည်။
   - `agent.skipBootstrap=true` ကို သတ်မှတ်သည် (BOOTSTRAP.md မရှိ)။
   - Workspace ဖိုင်များ မရှိပါက seed လုပ်ပေးသည်—
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`။
   - Default identity: **C3‑PO** (protocol droid)။
   - dev mode တွင် channel providers များကို ကျော်လွှားသည် (`OPENCLAW_SKIP_CHANNELS=1`)။

Reset flow (အစမှ ပြန်စတင်)—

```bash
pnpm gateway:dev:reset
```

မှတ်ချက်: `--dev` သည် **global** profile flag ဖြစ်ပြီး runner အချို့က စုပ်ယူသွားနိုင်ပါသည်။
အပြည့်အစုံ ဖော်ပြရန် လိုအပ်ပါက env var ပုံစံကို အသုံးပြုပါ:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` သည် config၊ credentials၊ sessions နှင့် dev workspace ကို ဖျက်ရှင်းပြီး
(`trash` ကို အသုံးပြု၍ `rm` မဟုတ်) နောက်တစ်ကြိမ် default dev setup ကို ပြန်လည် ဖန်တီးပေးသည်။

အကြံပြုချက်—dev မဟုတ်သော gateway တစ်ခုက ရှိပြီးသား လည်ပတ်နေပါက (launchd/systemd) အရင်ဆုံး ရပ်တန့်ပါ—

```bash
openclaw gateway stop
```

## Raw stream logging (OpenClaw)

OpenClaw သည် filtering/formatting မပြုလုပ်မီ **raw assistant stream** ကို log လုပ်နိုင်ပါသည်။
reasoning သည် plain text deltas အဖြစ် ရောက်လာသလား (သို့မဟုတ် သီးခြား thinking blocks အဖြစ်လား) ကို ကြည့်ရန် အကောင်းဆုံး နည်းလမ်းဖြစ်ပါသည်။

CLI မှတစ်ဆင့် ဖွင့်ရန်—

```bash
pnpm gateway:watch --force --raw-stream
```

Optional path override—

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

တူညီသော env vars—

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default ဖိုင်—

`~/.openclaw/logs/raw-stream.jsonl`

## Raw chunk logging (pi-mono)

blocks အဖြစ် parse မလုပ်မီ **raw OpenAI-compat chunks** ကို ဖမ်းယူရန်
pi-mono သည် သီးခြား logger တစ်ခုကို ပေးထားသည်—

```bash
PI_RAW_STREAM=1
```

Optional path—

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default ဖိုင်—

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> မှတ်ချက်—ဤ log သည် pi-mono ၏
> `openai-completions` provider ကို အသုံးပြုနေသော process များမှသာ ထုတ်ပေးသည်။

## Safety notes

- Raw stream logs များတွင် prompt အပြည့်အစုံ၊ tool output နှင့် user ဒေတာများ ပါဝင်နိုင်သည်။
- Log များကို local တွင်သာ ထားရှိပြီး debugging ပြီးပါက ဖျက်ပါ။
- Log များကို မျှဝေပါက secrets နှင့် PII များကို အရင် scrub လုပ်ပါ။
