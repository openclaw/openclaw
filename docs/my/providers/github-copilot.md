---
summary: "စက်ပစ္စည်း flow ကို အသုံးပြုပြီး OpenClaw မှ GitHub Copilot သို့ လော့ဂ်အင် ဝင်ရန်"
read_when:
  - GitHub Copilot ကို မော်ဒယ် ပံ့ပိုးသူအဖြစ် အသုံးပြုလိုသောအခါ
  - `openclaw models auth login-github-copilot` flow ကို လိုအပ်သောအခါ
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:46Z
---

# GitHub Copilot

## GitHub Copilot ဆိုတာဘာလဲ။

GitHub Copilot သည် GitHub ၏ AI ကုဒ်ရေးသားမှု အကူအညီပေးသူ ဖြစ်သည်။ သင့် GitHub အကောင့်နှင့် သင့်အစီအစဉ်အပေါ် မူတည်၍ Copilot မော်ဒယ်များကို အသုံးပြုခွင့် ပေးသည်။ OpenClaw သည် Copilot ကို မော်ဒယ် ပံ့ပိုးသူအဖြစ် နည်းလမ်းနှစ်မျိုးဖြင့် အသုံးပြုနိုင်သည်။

## OpenClaw တွင် Copilot ကို အသုံးပြုနိုင်သော နည်းလမ်း နှစ်မျိုး

### 1) Built-in GitHub Copilot provider (`github-copilot`)

GitHub token ကို ရယူရန် native device-login flow ကို အသုံးပြုပြီး၊ ထို့နောက် OpenClaw လည်ပတ်နေစဉ် Copilot API tokens အဖြစ် ပြန်လည်လဲလှယ်သည်။ VS Code မလိုအပ်သောကြောင့် ၎င်းသည် **မူလသတ်မှတ်ထားသော** နှင့် အလွယ်ကူဆုံး လမ်းကြောင်း ဖြစ်သည်။

### 2) Copilot Proxy plugin (`copilot-proxy`)

**Copilot Proxy** VS Code extension ကို local bridge အဖြစ် အသုံးပြုပါ။ OpenClaw သည် proxy ၏ `/v1` endpoint သို့ ဆက်သွယ်ပြီး သင် ထိုနေရာတွင် ဖွဲ့စည်းထားသော မော်ဒယ်စာရင်းကို အသုံးပြုသည်။ VS Code တွင် Copilot Proxy ကို ရှိပြီးသား လည်ပတ်နေပါက သို့မဟုတ် ထိုမှတစ်ဆင့် လမ်းကြောင်းပြောင်းရန် လိုအပ်ပါက ဤနည်းလမ်းကို ရွေးချယ်ပါ။ plugin ကို ဖွင့်ထားရပြီး VS Code extension ကို ဆက်လက် လည်ပတ်နေအောင် ထားရပါမည်။

GitHub Copilot ကို မော်ဒယ် ပံ့ပိုးသူအဖြစ် အသုံးပြုပါ (`github-copilot`)။ လော့ဂ်အင် အမိန့်သည် GitHub device flow ကို လည်ပတ်စေပြီး auth profile တစ်ခုကို သိမ်းဆည်းကာ ထို profile ကို အသုံးပြုရန် သင့် config ကို အပ်ဒိတ် ပြုလုပ်သည်။

## CLI setup

```bash
openclaw models auth login-github-copilot
```

URL တစ်ခုသို့ သွားရောက်ပြီး တစ်ကြိမ်သာ အသုံးပြုနိုင်သော ကုဒ်ကို ထည့်သွင်းရန် သင့်အား အချက်ပေးပါလိမ့်မည်။ ပြီးဆုံးသည့်အထိ terminal ကို ဖွင့်ထားပါ။

### Optional flags

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## မူလ မော်ဒယ် တစ်ခု သတ်မှတ်ရန်

```bash
openclaw models set github-copilot/gpt-4o
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## မှတ်ချက်များ

- Interactive TTY လိုအပ်ပါသည်; terminal ထဲတွင် တိုက်ရိုက် လည်ပတ်ပါ။
- Copilot မော်ဒယ် ရရှိနိုင်မှုသည် သင့်အစီအစဉ်အပေါ် မူတည်ပါသည်; မော်ဒယ်တစ်ခုကို ပယ်ချပါက အခြား ID တစ်ခုကို စမ်းကြည့်ပါ (ဥပမာ `github-copilot/gpt-4.1`)။
- လော့ဂ်အင် လုပ်ငန်းစဉ်သည် auth profile store ထဲတွင် GitHub token ကို သိမ်းဆည်းပြီး OpenClaw လည်ပတ်စဉ် Copilot API token အဖြစ် ပြန်လည်လဲလှယ်ပါသည်။
