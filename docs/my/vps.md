---
summary: "OpenClaw အတွက် VPS ဟို့စ်တင်ခြင်း ဟပ် (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Cloud ပေါ်တွင် Gateway ကို လည်ပတ်စေလိုသောအခါ
  - VPS/ဟို့စ်တင်ခြင်း လမ်းညွှန်များကို အမြန်တစ်ချက်နဲ့ မြင်ကွင်းဖော်လိုသောအခါ
title: "VPS ဟို့စ်တင်ခြင်း"
---

# VPS ဟို့စ်တင်ခြင်း

ဤဟပ်သည် ပံ့ပိုးထားသော VPS/ဟို့စ်တင်ခြင်း လမ်းညွှန်များသို့ လင့်ခ်များကို စုစည်းပေးပြီး cloud
တပ်ဆင်မှုများ မည်သို့ အလုပ်လုပ်သည်ကို အထွေထွေအဆင့်တွင် ရှင်းလင်းဖော်ပြထားသည်။

## ပံ့ပိုးသူကို ရွေးချယ်ပါ

- **Railway** (တစ်ချက်နှိပ် + ဘရောက်ဇာဖြင့် တပ်ဆင်ခြင်း): [Railway](/install/railway)
- **Northflank** (တစ်ချက်နှိပ် + ဘရောက်ဇာဖြင့် တပ်ဆင်ခြင်း): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — လစဉ် $0 (Always Free, ARM; စွမ်းရည်/စာရင်းသွင်းမှု တစ်ခါတစ်ရံ အဆင်မပြေတတ်)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: ကောင်းစွာ အလုပ်လုပ်ပါသည်။ Video guide:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Cloud တပ်ဆင်မှုများ မည်သို့ အလုပ်လုပ်သနည်း

- **Gateway သည် VPS ပေါ်တွင် လည်ပတ်**ပြီး state + workspace ကို ကိုင်တွယ်ပိုင်ဆိုင်ထားသည်။
- သင်၏ လက်တော့/ဖုန်းမှ **Control UI** သို့မဟုတ် **Tailscale/SSH** ဖြင့် ချိတ်ဆက်အသုံးပြုနိုင်သည်။
- VPS ကို source of truth အဖြစ် ထားပြီး state + workspace ကို **အရန်ကူး (backup)** လုပ်ထားပါ။
- Secure default: Gateway ကို loopback ပေါ်တွင်သာ ထားပြီး SSH tunnel သို့မဟုတ် Tailscale Serve ဖြင့် access လုပ်ပါ။
  `lan`/`tailnet` သို့ bind လုပ်ပါက `gateway.auth.token` သို့မဟုတ် `gateway.auth.password` ကို မဖြစ်မနေ သတ်မှတ်ပါ။

အဝေးမှ ဝင်ရောက်ခြင်း: [Gateway remote](/gateway/remote)  
ပလက်ဖောင်းများ ဟပ်: [Platforms](/platforms)

## VPS နှင့် nodes ကို အသုံးပြုခြင်း

Gateway ကို cloud တွင်ထားပြီး local devices (Mac/iOS/Android/headless) များတွင် **nodes** ကို pair လုပ်ထားနိုင်ပါသည်။ Nodes များသည် Gateway ကို cloud တွင်ထားစဉ် local screen/camera/canvas နှင့် `system.run` စွမ်းဆောင်ရည်များကို ပံ့ပိုးပေးပါသည်။

စာရွက်စာတမ်းများ: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
