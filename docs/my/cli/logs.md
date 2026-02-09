---
summary: "RPC မှတစ်ဆင့် Gateway（ဂိတ်ဝေး） လော့ဂ်များကို tail လုပ်ရန် `openclaw logs` အတွက် CLI ကိုးကားချက်"
read_when:
  - SSH မသုံးဘဲ အဝေးမှ Gateway（ဂိတ်ဝေး） လော့ဂ်များကို tail လုပ်ရန်လိုအပ်သည့်အချိန်
  - ကိရိယာများအတွက် JSON လော့ဂ်လိုင်းများကို လိုအပ်သည့်အချိန်
title: "လော့ဂ်များ"
---

# `openclaw logs`

RPC မှတစ်ဆင့် Gateway（ဂိတ်ဝေး） ဖိုင်လော့ဂ်များကို tail လုပ်ပါ (remote mode တွင် အလုပ်လုပ်ပါသည်)။

ဆက်စပ်အကြောင်းအရာများ:

- လော့ဂ်ခြင်း အနှစ်ချုပ်: [လော့ဂ်ခြင်း](/logging)

## ဥပမာများ

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
