---
summary: "Tailscale + CoreDNS ကို အသုံးပြုသည့် ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှုအတွက် `openclaw dns` ၏ CLI ကိုးကားချက်"
read_when:
  - Tailscale + CoreDNS မှတဆင့် ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှု (DNS-SD) ကို အသုံးပြုလိုသည့်အခါ
  - စိတ်ကြိုက် ရှာဖွေတွေ့ရှိမှု ဒိုမိန်း (ဥပမာ: openclaw.internal) အတွက် split DNS ကို တပ်ဆင်နေသည့်အခါ
title: "dns"
x-i18n:
  source_path: cli/dns.md
  source_hash: d2011e41982ffb4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:59Z
---

# `openclaw dns`

ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှုအတွက် DNS အကူအညီများ (Tailscale + CoreDNS)။ လက်ရှိတွင် macOS + Homebrew CoreDNS ကို အဓိကထား၍ အာရုံစိုက်ထားသည်။

ဆက်စပ်ရာများ:

- Gateway ရှာဖွေတွေ့ရှိမှု: [Discovery](/gateway/discovery)
- ကျယ်ပြန့်ဧရိယာ ရှာဖွေတွေ့ရှိမှု ဖွဲ့စည်းပြင်ဆင်ခြင်း: [Configuration](/gateway/configuration)

## တပ်ဆင်ခြင်း

```bash
openclaw dns setup
openclaw dns setup --apply
```
