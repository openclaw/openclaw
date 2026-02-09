---
summary: "Terminal UI (TUI): မည်သည့်စက်မှမဆို Gateway သို့ ချိတ်ဆက်ရန်"
read_when:
  - TUI ကို စတင်အသုံးပြုရန် လမ်းညွှန်ကို လိုအပ်သောအခါ
  - TUI ၏ အင်္ဂါရပ်များ၊ အမိန့်များနှင့် အတိုကောက်ခလုတ်များကို အပြည့်အစုံ သိလိုသောအခါ
title: "TUI"
---

# TUI (Terminal UI)

## Quick start

1. Gateway ကို စတင်ပါ။

```bash
openclaw gateway
```

2. TUI ကို ဖွင့်ပါ။

```bash
openclaw tui
```

3. မက်ဆေ့ချ်တစ်ခု ရိုက်ထည့်ပြီး Enter ကို နှိပ်ပါ။

Remote Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

သင်၏ Gateway သည် password auth ကို အသုံးပြုပါက `--password` ကို အသုံးပြုပါ။

## What you see

- Header: ချိတ်ဆက်မှု URL၊ လက်ရှိ agent၊ လက်ရှိ session။
- Chat log: အသုံးပြုသူ မက်ဆေ့ချ်များ၊ assistant အဖြေများ၊ system အသိပေးချက်များ၊ tool ကတ်များ။
- Status line: ချိတ်ဆက်/လုပ်ဆောင်မှု အခြေအနေ (connecting, running, streaming, idle, error)။
- Footer: ချိတ်ဆက်မှု အခြေအနေ + agent + session + model + think/verbose/reasoning + token အရေအတွက်များ + deliver။
- Input: autocomplete ပါသော စာသားတည်းဖြတ်ခန်း။

## Mental model: agents + sessions

- 33. Agents များသည် unique slug များဖြစ်ပါသည် (ဥပမာ `main`, `research`)။ 34. Gateway သည် စာရင်းကို ဖော်ပြပေးပါသည်။
- Sessions များသည် လက်ရှိ agent နှင့် ဆိုင်သည်။
- Session keys များကို `agent:<agentId>:<sessionKey>` အဖြစ် သိမ်းဆည်းထားသည်။
  - သင် `/session main` ကို ရိုက်ထည့်ပါက TUI သည် `agent:<currentAgent>:main` သို့ ချဲ့ထွင်ပြသသည်။
  - သင် `/session agent:other:main` ကို ရိုက်ထည့်ပါက ထို agent session သို့ တိုက်ရိုက် ပြောင်းလဲသည်။
- Session scope:
  - `per-sender` (မူလသတ်မှတ်ချက်): agent တစ်ခုစီတွင် session များ အများအပြား ရှိနိုင်သည်။
  - `global`: TUI သည် အမြဲ `global` session ကို အသုံးပြုသည် (picker သည် ဗလာဖြစ်နိုင်သည်)။
- လက်ရှိ agent + session ကို footer တွင် အမြဲ မြင်နိုင်သည်။

## Sending + delivery

- မက်ဆေ့ချ်များကို Gateway သို့ ပို့သည်၊ provider များသို့ deliver လုပ်ခြင်းသည် မူလအားဖြင့် ပိတ်ထားသည်။
- Delivery ကို ဖွင့်ရန်:
  - `/deliver on`
  - သို့မဟုတ် Settings panel
  - သို့မဟုတ် `openclaw tui --deliver` ဖြင့် စတင်ပါ

## Pickers + overlays

- Model picker: ရရှိနိုင်သော model များကို ပြပြီး session override ကို သတ်မှတ်ရန်။
- Agent picker: မတူသော agent ကို ရွေးချယ်ရန်။
- Session picker: လက်ရှိ agent အတွက် session များကိုသာ ပြသသည်။
- Settings: deliver၊ tool output ချဲ့ထွင်ပြသမှု၊ thinking မြင်နိုင်မှုကို toggle လုပ်ရန်။

## Keyboard shortcuts

- Enter: မက်ဆေ့ချ် ပို့ရန်
- Esc: လက်ရှိ run ကို ရပ်တန့်ရန်
- Ctrl+C: input ကို ရှင်းလင်းရန် (နှစ်ကြိမ် နှိပ်ပါက ထွက်မည်)
- Ctrl+D: ထွက်ရန်
- Ctrl+L: model picker
- Ctrl+G: agent picker
- Ctrl+P: session picker
- Ctrl+O: tool output ချဲ့ထွင်ပြသမှု toggle
- Ctrl+T: thinking မြင်နိုင်မှု toggle (history ကို ပြန်လည် load လုပ်သည်)

## Slash commands

Core:

- `/help`
- `/status`
- `/agent <id>` (သို့မဟုတ် `/agents`)
- `/session <key>` (သို့မဟုတ် `/sessions`)
- `/model <provider/model>` (သို့မဟုတ် `/models`)

Session controls:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Session lifecycle:

- `/new` သို့မဟုတ် `/reset` (session ကို reset လုပ်ရန်)
- `/abort` (လက်ရှိ run ကို ရပ်တန့်ရန်)
- `/settings`
- `/exit`

35. အခြား Gateway slash commands များ (ဥပမာ `/context`) ကို Gateway သို့ forward လုပ်ပြီး system output အဖြစ် ပြသပါသည်။ 36. [Slash commands](/tools/slash-commands) ကို ကြည့်ပါ။

## Local shell commands

- TUI ဟို့စ်ပေါ်တွင် local shell command ကို လုပ်ဆောင်ရန် လိုင်းတစ်ကြောင်း၏ အစတွင် `!` ကို ထည့်ပါ။
- Session တစ်ခုလျှင် တစ်ကြိမ်သာ TUI သည် local execution ခွင့်ပြုရန် မေးမြန်းသည်၊ ငြင်းပယ်ပါက ထို session အတွက် `!` ကို ပိတ်ထားမည်။
- Commands များကို TUI working directory အတွင်းရှိ fresh, non-interactive shell တွင် လုပ်ဆောင်သည် (အမြဲတမ်း `cd`/env မရှိပါ)။
- တစ်ခုတည်းသော `!` ကို ပုံမှန် မက်ဆေ့ချ်အဖြစ် ပို့မည်ဖြစ်ပြီး၊ ရှေ့တွင် space ထည့်ခြင်းဖြင့် local exec ကို မဖြစ်စေပါ။

## Tool output

- Tool calls များကို args + results ပါသော ကတ်များအဖြစ် ပြသသည်။
- Ctrl+O ဖြင့် collapse/expand မြင်ကွင်းများအကြား toggle လုပ်နိုင်သည်။
- Tools များ လုပ်ဆောင်နေစဉ် partial updates များကို ကတ်တစ်ခုတည်းအတွင်း stream လုပ်ပြသသည်။

## History + streaming

- ချိတ်ဆက်ချိန်တွင် TUI သည် နောက်ဆုံး history ကို load လုပ်သည် (မူလ 200 မက်ဆေ့ချ်)။
- Streaming အဖြေများသည် အပြီးသတ်မချင်း တစ်နေရာတည်းတွင် update လုပ်ပြသသည်။
- ထို့အပြင် richer tool cards အတွက် agent tool events များကိုလည်း နားထောင်သည်။

## Connection details

- TUI သည် Gateway နှင့် `mode: "tui"` အဖြစ် မှတ်ပုံတင်ချိတ်ဆက်သည်။
- ပြန်လည်ချိတ်ဆက်မှုများတွင် system message ကို ပြသပြီး event gaps များကို log ထဲတွင် ဖော်ပြသည်။

## Options

- `--url <url>`: Gateway WebSocket URL (config သို့မဟုတ် `ws://127.0.0.1:<port>` ကို မူလအသုံးပြုသည်)
- `--token <token>`: Gateway token (လိုအပ်ပါက)
- `--password <password>`: Gateway password (လိုအပ်ပါက)
- `--session <key>`: Session key (မူလ: `main`၊ scope သည် global ဖြစ်ပါက `global`)
- `--deliver`: Assistant အဖြေများကို provider သို့ deliver လုပ်ရန် (မူလအားဖြင့် ပိတ်ထားသည်)
- `--thinking <level>`: ပို့ဆောင်မှုများအတွက် thinking level ကို override လုပ်ရန်
- `--timeout-ms <ms>`: Agent timeout (ms ဖြင့်) (မူလ `agents.defaults.timeoutSeconds`)

37. မှတ်ချက်: `--url` ကို set လုပ်ပါက TUI သည် config သို့မဟုတ် environment credentials သို့ ပြန်မလှည့်ပါ။
38. `--token` သို့မဟုတ် `--password` ကို ထင်ရှားစွာ ပေးပါ။ 39. ထင်ရှားသော credentials မပါရှိပါက error ဖြစ်ပါသည်။

## Troubleshooting

မက်ဆေ့ချ် ပို့ပြီးနောက် output မပေါ်ပါက:

- Gateway သည် ချိတ်ဆက်ပြီး idle/busy ဖြစ်နေကြောင်း အတည်ပြုရန် TUI အတွင်း `/status` ကို run လုပ်ပါ။
- Gateway logs များကို စစ်ဆေးပါ: `openclaw logs --follow`။
- Agent သည် run လုပ်နိုင်ကြောင်း အတည်ပြုပါ: `openclaw status` နှင့် `openclaw models status`။
- Chat channel တစ်ခုတွင် မက်ဆေ့ချ်များကို မျှော်လင့်ထားပါက delivery ကို ဖွင့်ပါ (`/deliver on` သို့မဟုတ် `--deliver`)။
- `--history-limit <n>`: load လုပ်မည့် history entry အရေအတွက် (မူလ 200)

## Connection troubleshooting

- `disconnected`: Gateway လည်ပတ်နေကြောင်းနှင့် သင်၏ `--url/--token/--password` မှန်ကန်ကြောင်း သေချာစေပါ။
- Picker တွင် agent မရှိပါက: `openclaw agents list` နှင့် routing config ကို စစ်ဆေးပါ။
- Session picker ဗလာဖြစ်နေပါက: global scope တွင် ရှိနေနိုင်သည် သို့မဟုတ် session မရှိသေးနိုင်ပါ။
