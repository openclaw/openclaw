---
summary: "ပလက်ဖောင်း ပံ့ပိုးမှု အကျဉ်းချုပ် (Gateway + အတူတကွ အသုံးပြုသော အက်ပ်များ)"
read_when:
  - OS ပံ့ပိုးမှု သို့မဟုတ် ထည့်သွင်းတပ်ဆင်ရာ လမ်းကြောင်းများကို ရှာဖွေနေသောအခါ
  - Gateway ကို မည်သည့်နေရာတွင် လည်ပတ်စေမည်ကို ဆုံးဖြတ်နေသောအခါ
title: "ပလက်ဖောင်းများ"
---

# ပလက်ဖောင်းများ

43. OpenClaw core ကို TypeScript ဖြင့် ရေးသားထားပါသည်။ 44. **Node ကို အကြံပြုထားသော runtime အဖြစ် အသုံးပြုရန် အကြံပြုပါသည်**။
44. Gateway အတွက် Bun ကို မအကြံပြုပါ (WhatsApp/Telegram bugs များကြောင့်)။

46. Companion apps များကို macOS (menu bar app) နှင့် mobile nodes (iOS/Android) အတွက် ရရှိနိုင်ပါသည်။ Windows and
    Linux companion apps are planned, but the Gateway is fully supported today.
47. Windows အတွက် native companion apps များကိုလည်း စီစဉ်ထားပြီး Gateway ကို WSL2 မှတဆင့် အသုံးပြုရန် အကြံပြုပါသည်။

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

- 49. macOS: LaunchAgent (`bot.molt.gateway` သို့မဟုတ် `bot.molt.<profile>`50. `; legacy `com.openclaw.\*\`)
- Linux/WSL2: systemd user service (`openclaw-gateway[-<profile>].service`)
