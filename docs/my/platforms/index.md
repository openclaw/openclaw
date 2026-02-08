---
summary: "ပလက်ဖောင်း ပံ့ပိုးမှု အကျဉ်းချုပ် (Gateway + အတူတကွ အသုံးပြုသော အက်ပ်များ)"
read_when:
  - OS ပံ့ပိုးမှု သို့မဟုတ် ထည့်သွင်းတပ်ဆင်ရာ လမ်းကြောင်းများကို ရှာဖွေနေသောအခါ
  - Gateway ကို မည်သည့်နေရာတွင် လည်ပတ်စေမည်ကို ဆုံးဖြတ်နေသောအခါ
title: "ပလက်ဖောင်းများ"
x-i18n:
  source_path: platforms/index.md
  source_hash: 959479995f9ecca3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:36Z
---

# ပလက်ဖောင်းများ

OpenClaw core ကို TypeScript ဖြင့် ရေးသားထားသည်။ **Node ကို အကြံပြုထားသော runtime အဖြစ် အသုံးပြုပါသည်**။
Gateway အတွက် Bun ကို မထောက်ခံပါ (WhatsApp/Telegram ပြဿနာများ ရှိပါသည်)။

macOS (menu bar app) နှင့် မိုဘိုင်း နိုဒ်များ (iOS/Android) အတွက် companion apps များ ရှိပြီးသားဖြစ်သည်။ Windows နှင့်
Linux အတွက် companion apps များကို စီမံကိန်းအဖြစ် စီစဉ်ထားပြီးသားဖြစ်သော်လည်း Gateway ကို ယနေ့တွင် ပြည့်စုံစွာ ပံ့ပိုးထားပါသည်။
Windows အတွက် native companion apps များကိုလည်း စီစဉ်ထားပြီး Gateway ကို WSL2 မှတဆင့် အသုံးပြုရန် အကြံပြုပါသည်။

## သင့် OS ကို ရွေးချယ်ပါ

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS နှင့် ဟို့စ်တင်ခြင်း

- VPS hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/install/exe-dev)

## အများအားဖြင့် အသုံးဝင်သော လင့်ခ်များ

- ထည့်သွင်းတပ်ဆင် လမ်းညွှန်: [Getting Started](/start/getting-started)
- Gateway လည်ပတ်လမ်းညွှန်: [Gateway](/gateway)
- Gateway ဖွဲ့စည်းပြင်ဆင်ခြင်း: [Configuration](/gateway/configuration)
- ဝန်ဆောင်မှု အခြေအနေ: `openclaw gateway status`

## Gateway ဝန်ဆောင်မှု ထည့်သွင်းခြင်း (CLI)

အောက်ပါတို့ထဲမှ တစ်ခုကို အသုံးပြုနိုင်ပါသည် (အားလုံးကို ပံ့ပိုးထားပါသည်) —

- Wizard (အကြံပြု): `openclaw onboard --install-daemon`
- တိုက်ရိုက်: `openclaw gateway install`
- ဖွဲ့စည်းပြင်ဆင် လုပ်ငန်းစဉ်: `openclaw configure` → **Gateway service** ကို ရွေးချယ်ပါ
- ပြုပြင်/ပြောင်းရွှေ့: `openclaw doctor` (ဝန်ဆောင်မှုကို ထည့်သွင်းရန် သို့မဟုတ် ပြုပြင်ရန် အကြံပြုပါသည်)

ဝန်ဆောင်မှု၏ ပစ်မှတ်သည် OS အပေါ် မူတည်ပါသည် —

- macOS: LaunchAgent (`bot.molt.gateway` သို့မဟုတ် `bot.molt.<profile>`; အဟောင်း `com.openclaw.*`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
