---
summary: "Network ဟပ်: Gateway မျက်နှာပြင်များ၊ pairing၊ discovery နှင့် လုံခြုံရေး"
read_when:
  - Network ဖွဲ့စည်းပုံနှင့် လုံခြုံရေး အနှစ်ချုပ်ကို လိုအပ်သောအခါ
  - local နှင့် tailnet ဝင်ရောက်မှု သို့မဟုတ် pairing ကို ပြဿနာရှာဖွေနေသောအခါ
  - Network ဆိုင်ရာ စာတမ်းများ၏ စံပြစာရင်းကို လိုချင်သောအခါ
title: "Network"
---

# Network ဟပ်

ဤဟပ်သည် OpenClaw သည် localhost၊ LAN နှင့် tailnet အနှံ့ စက်ပစ္စည်းများကို မည်သို့ ချိတ်ဆက်၊ pairing ပြုလုပ်ပြီး လုံခြုံရေးကို မည်သို့ အကောင်အထည်ဖော်ထားသည်ကို ရှင်းပြသော အဓိက စာတမ်းများသို့ ချိတ်ဆက်ပေးသည်။

## အခြေခံ မော်ဒယ်

- [Gateway architecture](/concepts/architecture)
- [Gateway protocol](/gateway/protocol)
- [Gateway runbook](/gateway)
- [Web surfaces + bind modes](/web)

## Pairing + အထောက်အထား

- [Pairing overview (DM + nodes)](/channels/pairing)
- [Gateway-owned node pairing](/gateway/pairing)
- [Devices CLI (pairing + token rotation)](/cli/devices)
- [Pairing CLI (DM approvals)](/cli/pairing)

Local ယုံကြည်မှု:

- Local ချိတ်ဆက်မှုများ (loopback သို့မဟုတ် Gateway ဟို့စ်၏ ကိုယ်ပိုင် tailnet လိပ်စာ) ကို တူညီသော ဟို့စ်အတွင်း UX ကို ချောမွေ့စေရန် pairing အတွက် အလိုအလျောက် အတည်ပြုနိုင်သည်။
- Local မဟုတ်သော tailnet/LAN ကလိုင်းယင့်များအတွက်တော့ pairing အတည်ပြုချက်ကို ထင်ရှားစွာ လိုအပ်နေဆဲ ဖြစ်သည်။

## Discovery + ပို့ဆောင်ရေးအလွှာများ

- [Discovery & transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Remote access (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + ပို့ဆောင်ရေးအလွှာများ

- [Nodes overview](/nodes)
- [Bridge protocol (legacy nodes)](/gateway/bridge-protocol)
- [Node runbook: iOS](/platforms/ios)
- [Node runbook: Android](/platforms/android)

## လုံခြုံရေး

- [Security overview](/gateway/security)
- [Gateway config reference](/gateway/configuration)
- [Troubleshooting](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
