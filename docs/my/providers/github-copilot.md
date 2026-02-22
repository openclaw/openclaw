---
summary: "စက်ပစ္စည်း flow ကို အသုံးပြုပြီး OpenClaw မှ GitHub Copilot သို့ လော့ဂ်အင် ဝင်ရန်"
read_when:
  - GitHub Copilot ကို မော်ဒယ် ပံ့ပိုးသူအဖြစ် အသုံးပြုလိုသောအခါ
  - "`openclaw models auth login-github-copilot` flow ကို လိုအပ်သောအခါ"
title: "GitHub Copilot"
---

# GitHub Copilot

## GitHub Copilot ဆိုတာဘာလဲ။

GitHub Copilot သည် GitHub ၏ AI coding assistant ဖြစ်သည်။ ၎င်းသည် သင်၏ GitHub account နှင့် plan အတွက် Copilot models များကို အသုံးပြုခွင့်ပေးပါသည်။ OpenClaw သည် Copilot ကို model provider အဖြစ် နည်းလမ်းနှစ်မျိုးဖြင့် အသုံးပြုနိုင်ပါသည်။

## OpenClaw တွင် Copilot ကို အသုံးပြုနိုင်သော နည်းလမ်း နှစ်မျိုး

### 1. Built-in GitHub Copilot provider (`github-copilot`)

Native device-login flow ကို အသုံးပြုပြီး GitHub token ကို ရယူကာ OpenClaw chạy လုပ်သောအခါ Copilot API tokens များနှင့် exchange လုပ်ပါသည်။ ၎င်းသည် VS Code မလိုအပ်သောကြောင့် **default** နှင့် အလွယ်ဆုံး လမ်းကြောင်းဖြစ်သည်။

### 2. Copilot Proxy plugin (`copilot-proxy`)

Local bridge အဖြစ် **Copilot Proxy** VS Code extension ကို အသုံးပြုပါ။ OpenClaw သည် proxy ၏ `/v1` endpoint နှင့် ဆက်သွယ်ပြီး သင် configure လုပ်ထားသော model list ကို အသုံးပြုပါသည်။ VS Code တွင် Copilot Proxy ကို အသုံးပြုနေပြီးသား သို့မဟုတ် ၎င်းမှတဆင့် route လုပ်ရန် လိုအပ်ပါက ဤနည်းလမ်းကို ရွေးချယ်ပါ။
Plugin ကို enable လုပ်ပြီး VS Code extension ကို ဆက်လက် chạy ထားရပါမည်။

GitHub Copilot ကို model provider (`github-copilot`) အဖြစ် အသုံးပြုပါ။ Login command သည် GitHub device flow ကို chạy လုပ်ပြီး auth profile ကို သိမ်းဆည်းကာ သင်၏ config ကို ထို profile ကို အသုံးပြုအောင် update လုပ်ပါသည်။

## CLI setup

```bash
openclaw models auth login-github-copilot
```

URL တစ်ခုသို့ သွားရောက်ပြီး one-time code ကို ထည့်သွင်းရန် prompt ပေါ်လာပါမည်။ ပြီးဆုံးသည်အထိ terminal ကို ဖွင့်ထားပါ။

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
