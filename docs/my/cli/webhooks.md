---
summary: "`openclaw webhooks` အတွက် CLI ကိုးကားချက် (webhook အကူအညီပေးကိရိယာများ + Gmail Pub/Sub)"
read_when:
  - Gmail Pub/Sub ဖြစ်ရပ်များကို OpenClaw သို့ ချိတ်ဆက်လိုသောအခါ
  - webhook အကူအညီပေး အမိန့်များကို အသုံးပြုလိုသောအခါ
title: "ဝဘ်ဟုတ်များ"
---

# `openclaw webhooks`

Webhook အကူအညီပေးကိရိယာများနှင့် ပေါင်းစည်းမှုများ (Gmail Pub/Sub၊ webhook အကူအညီပေးကိရိယာများ)။

ဆက်စပ်သည်များ:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

အသေးစိတ်အတွက် [Gmail Pub/Sub documentation](/automation/gmail-pubsub) ကို ကြည့်ပါ။
