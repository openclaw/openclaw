---
summary: "`openclaw models` အတွက် CLI ကိုးကားလမ်းညွှန် (status/list/set/scan, aliases, fallbacks, auth)"
read_when:
  - မူလ သတ်မှတ်ထားသော မော်ဒယ်များကို ပြောင်းလဲလိုပါက သို့မဟုတ် provider auth အခြေအနေကို ကြည့်လိုပါက
  - ရရှိနိုင်သော မော်ဒယ်များ/ပံ့ပိုးသူများကို စကန်လုပ်၍ auth ပရိုဖိုင်များကို အမှားရှာဖွေလိုပါက
title: "မော်ဒယ်များ"
---

# `openclaw models`

မော်ဒယ်များကို ရှာဖွေတွေ့ရှိခြင်း၊ စကန်လုပ်ခြင်းနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း (မူလ မော်ဒယ်၊ fallbacks၊ auth ပရိုဖိုင်များ)။

ဆက်စပ်အကြောင်းအရာများ—

- Providers + models: [Models](/providers/models)
- Provider auth တပ်ဆင်ခြင်း: [Getting started](/start/getting-started)

## Common commands

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` သည် ဖြေရှင်းပြီးသော default/fallback များနှင့် auth အကျဉ်းချုပ်ကို ပြသပါသည်။
Provider အသုံးပြုမှု snapshot များ ရရှိနိုင်သောအခါ OAuth/token status အပိုင်းတွင် provider usage headers များ ပါဝင်ပါသည်။
Configure လုပ်ထားသော provider profile တစ်ခုချင်းစီအတွက် live auth probe များကို လည်ပတ်ရန် `--probe` ကို ထည့်ပါ။
Probes များသည် အမှန်တကယ် request များဖြစ်ပြီး (token များကို သုံးစွဲနိုင်သလို rate limit များကိုလည်း ဖြစ်ပေါ်စေနိုင်ပါသည်)။
Configure လုပ်ထားသော agent တစ်ခု၏ model/auth အခြေအနေကို စစ်ဆေးရန် `--agent <id>` ကို အသုံးပြုပါ။ မထည့်ထားပါက command သည် `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` ကို သတ်မှတ်ထားလျှင် အသုံးပြုပြီး မရှိပါက configure လုပ်ထားသော default agent ကို အသုံးပြုပါသည်။

မှတ်ချက်များ—

- `models set <model-or-alias>` သည် `provider/model` သို့မဟုတ် alias တစ်ခုကို လက်ခံသည်။
- Model ref များကို **ပထမဆုံး** `/` အပေါ် အခြေခံ၍ ခွဲခြားဖတ်ရှုပါသည်။ Model ID တွင် `/` ပါဝင်ပါက (OpenRouter-style) provider prefix ကို ထည့်ပါ (ဥပမာ: `openrouter/moonshotai/kimi-k2`)။
- Provider ကို ချန်လှပ်ထားပါက OpenClaw သည် ထည့်သွင်းထားသည့် အချက်အလက်ကို alias သို့မဟုတ် **မူလ provider** အတွက် မော်ဒယ်အဖြစ် သတ်မှတ်သည် (မော်ဒယ် ID တွင် `/` မပါဝင်သည့်အခါသာ အလုပ်လုပ်သည်)။

### `models status`

ရွေးချယ်စရာများ—

- `--json`
- `--plain`
- `--check` (ထွက်ခွာကုဒ် 1=သက်တမ်းကုန်/မရှိ၊ 2=မကြာမီ သက်တမ်းကုန်)
- `--probe` (ဖွဲ့စည်းထားသော auth ပရိုဖိုင်များကို live probe လုပ်ခြင်း)
- `--probe-provider <name>` (provider တစ်ခုကို probe လုပ်ခြင်း)
- `--probe-profile <id>` (ထပ်ခါထပ်ခါ သို့မဟုတ် ကော်မာဖြင့် ခွဲထားသော ပရိုဖိုင် ID များ)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (ဖွဲ့စည်းထားသော agent ID; `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` ကို အစားထိုး)

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Auth profiles

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` သည် provider plugin ၏ auth flow (OAuth/API key) ကို လည်ပတ်စေပါသည်။ ဘယ် provider များကို install လုပ်ထားသည်ကို ကြည့်ရန် `openclaw plugins list` ကို အသုံးပြုပါ။

မှတ်ချက်များ—

- `setup-token` သည် setup-token တန်ဖိုးကို မေးမြန်းသည် (မည်သည့် စက်တွင်မဆို `claude setup-token` ဖြင့် ထုတ်လုပ်နိုင်သည်)။
- `paste-token` သည် အခြားနေရာမှ ထုတ်လုပ်ထားသော သို့မဟုတ် automation မှ ရလာသော token စာကြောင်းကို လက်ခံသည်။
