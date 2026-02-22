---
summary: "Tailscale + CoreDNS ကို အသုံးပြုသည့် ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှုအတွက် `openclaw dns` ၏ CLI ကိုးကားချက်"
read_when:
  - Tailscale + CoreDNS မှတဆင့် ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှု (DNS-SD) ကို အသုံးပြုလိုသည့်အခါ
  - You’re setting up split DNS for a custom discovery domain (example: openclaw.internal)
title: "dns"
---

# `openclaw dns`

wide-area discovery အတွက် DNS helpers များ (Tailscale + CoreDNS)။ လက်ရှိတွင် macOS + Homebrew CoreDNS ကို အဓိကထားထားသည်။

ဆက်စပ်ရာများ:

- Gateway ရှာဖွေတွေ့ရှိမှု: [Discovery](/gateway/discovery)
- ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှု ဖွဲ့စည်းပြင်ဆင်ခြင်း: [Configuration](/gateway/configuration)

## တပ်ဆင်ခြင်း

```bash
openclaw dns setup
openclaw dns setup --apply
```
