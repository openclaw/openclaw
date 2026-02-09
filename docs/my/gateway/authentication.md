---
summary: "မော်ဒယ် အထောက်အထားစိစစ်ခြင်း − OAuth၊ API ကီးများ နှင့် setup-token"
read_when:
  - မော်ဒယ် အထောက်အထားစိစစ်ခြင်း သို့မဟုတ် OAuth သက်တမ်းကုန်ဆုံးမှုကို ပြဿနာရှာဖွေနေစဉ်
  - အထောက်အထားစိစစ်ခြင်း သို့မဟုတ် အထောက်အထားသိမ်းဆည်းမှုကို စာတမ်းရေးသားနေစဉ်
title: "Authentication"
---

# Authentication

OpenClaw သည် model providers များအတွက် OAuth နှင့် API keys ကို ထောက်ပံ့ပါသည်။ Claude subscription access အတွက် `claude setup-token` ဖြင့် ဖန်တီးထားသော long‑lived token ကို အသုံးပြုပါ။ Anthropic အတွက် အကြံပြုထားသော လမ်းကြောင်းမှာ **API key** ဖြစ်ပါသည်။

OAuth လုပ်ငန်းစဉ်အပြည့်အစုံနှင့် သိမ်းဆည်းမှု အပြင်အဆင်အတွက် [/concepts/oauth](/concepts/oauth) ကို ကြည့်ပါ။

## အကြံပြုထားသော Anthropic တပ်ဆင်မှု (API ကီး)

Anthropic ကို တိုက်ရိုက်အသုံးပြုနေပါက API ကီးကို အသုံးပြုပါ။

1. Anthropic Console တွင် API ကီးတစ်ခု ဖန်တီးပါ။
2. ၎င်းကို **Gateway ဟို့စ်** ( `openclaw gateway` ကို လည်ပတ်နေသော စက် ) ပေါ်တွင် ထားပါ။

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Gateway ကို systemd/launchd အောက်တွင် လည်ပတ်နေပါက daemon က ဖတ်နိုင်စေရန် `~/.openclaw/.env` ထဲသို့ ကီးကို ထည့်ထားခြင်းကို ဦးစားပေးပါ။

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

ထို့နောက် daemon ကို ပြန်လည်စတင်ပါ (သို့မဟုတ် Gateway လုပ်ငန်းစဉ်ကို ပြန်လည်စတင်ပါ) နှင့် ထပ်မံစစ်ဆေးပါ။

```bash
openclaw models status
openclaw doctor
```

env vars ကို ကိုယ်တိုင် မစီမံလိုပါက onboarding wizard သည် daemon အသုံးပြုရန် API ကီးများကို သိမ်းဆည်းပေးနိုင်ပါသည် — `openclaw onboard`။

env inheritance ဆိုင်ရာ အသေးစိတ်အတွက် [Help](/help) ကို ကြည့်ပါ (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd)။

## Anthropic: setup-token (subscription auth)

Claude subscription ကို အသုံးပြုနေပါက setup-token flow ကိုလည်း ထောက်ပံ့ထားပါသည်။ **gateway host** ပေါ်တွင် အလုပ်လုပ်စေပါ: မည်သည့် profile သည် သက်တမ်းကုန်ဆုံးနေသည်ကို အတည်ပြုရန် `openclaw models status` ကို chạy ပါ။

```bash
claude setup-token
```

ထို့နောက် OpenClaw ထဲသို့ ကူးထည့်ပါ။

```bash
openclaw models auth setup-token --provider anthropic
```

token ကို အခြားစက်တစ်လုံးပေါ်တွင် ဖန်တီးခဲ့ပါက ကိုယ်တိုင် ကူးထည့်ပါ။

```bash
openclaw models auth paste-token --provider anthropic
```

အောက်ပါကဲ့သို့ Anthropic အမှားကို တွေ့ပါက—

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…Anthropic API ကီးကို အစားထိုးအသုံးပြုပါ။

Manual token ထည့်သွင်းခြင်း (မည်သည့် provider မဆို; `auth-profiles.json` ကို ရေးသွင်းပြီး config ကို အပ်ဒိတ်လုပ်သည်):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Automation အတွက် သင့်လျော်သော စစ်ဆေးမှု (သက်တမ်းကုန်ဆုံး/မရှိပါက exit `1`, သက်တမ်းကုန်ဆုံးတော့မည်ဆိုပါက `2`):

```bash
openclaw models status --check
```

ရွေးချယ်နိုင်သော ops scripts (systemd/Termux) များကို ဤနေရာတွင် စာတမ်းတင်ထားပါသည်။
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` သည် interactive TTY ကို လိုအပ်ပါသည်။

## မော်ဒယ် အထောက်အထားစိစစ်မှု အခြေအနေကို စစ်ဆေးခြင်း

```bash
openclaw models status
openclaw doctor
```

## အသုံးပြုမည့် အထောက်အထားကို ထိန်းချုပ်ခြင်း

### ဆက်ရှင်အလိုက် (ချတ် အမိန့်)

လက်ရှိ ဆက်ရှင်အတွက် ပံ့ပိုးသူ အထောက်အထားတစ်ခုကို သတ်မှတ်ပေးရန် `/model <alias-or-id>@<profileId>` ကို အသုံးပြုပါ (ဥပမာ profile id များ − `anthropic:default`, `anthropic:work`)။

အကျဉ်းချုပ် ရွေးချယ်ကိရိယာအတွက် `/model` (သို့မဟုတ် `/model list`) ကို အသုံးပြုပါ။ အပြည့်အစုံ မြင်ကွင်းအတွက် `/model status` ကို အသုံးပြုပါ (ကိုယ်စားလှယ်များ + နောက်ထပ် auth profile၊ ထည့်သွင်းထားပါက provider endpoint အသေးစိတ်များ ပါဝင်သည်)။

### အေးဂျင့်အလိုက် (CLI override)

အေးဂျင့်တစ်ခုအတွက် အထောက်အထား profile အစီအစဉ်ကို override လုပ်ရန် သတ်မှတ်ပါ (အဲဒီအေးဂျင့်၏ `auth-profiles.json` တွင် သိမ်းဆည်းသည်)။

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

သတ်မှတ်ထားသော အေးဂျင့်တစ်ခုကို ရွေးရန် `--agent <id>` ကို အသုံးပြုပါ။ မထည့်ပါက ပြင်ဆင်ထားသော မူလ အေးဂျင့်ကို အသုံးပြုပါမည်။

## ပြဿနာဖြေရှင်းခြင်း

### “No credentials found”

Anthropic token profile မရှိပါက **Gateway ဟို့စ်** ပေါ်တွင် `claude setup-token` ကို လည်ပတ်ပါ၊ ထို့နောက် ထပ်မံစစ်ဆေးပါ။

```bash
openclaw models status
```

### Token သက်တမ်းကုန်ဆုံးနေ/ကုန်ဆုံးပြီး

Profile မတွေ့ပါက `claude setup-token` ကို ပြန်လည် chạy ပြီး token ကို ထပ်မံ paste လုပ်ပါ။ OpenClaw သည် `exec` tool ကို အသုံးပြု၍ shell commands များကို chạy လုပ်ပြီး ကြာရှည်အလုပ်လုပ်သော tasks များကို memory ထဲတွင် ထိန်းသိမ်းထားပါသည်။

## လိုအပ်ချက်များ

- Claude Max သို့မဟုတ် Pro စာရင်းသွင်းမှု (`claude setup-token` အတွက်)
- Claude Code CLI ကို ထည့်သွင်းထားရမည် (`claude` အမိန့် ရရှိနိုင်ရမည်)
