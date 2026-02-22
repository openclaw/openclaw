---
summary: "`openclaw reset` အတွက် CLI ကိုးကားချက် (local state/config ကို ပြန်လည်သတ်မှတ်ခြင်း)"
read_when:
  - CLI ကို ဆက်လက်ထည့်သွင်းထားစေပြီး local state ကို ဖျက်ရှင်းလိုသောအခါ
  - ဖယ်ရှားမည့်အရာများကို dry-run ဖြင့် ကြိုတင်ကြည့်လိုသောအခါ
title: "ပြန်လည်သတ်မှတ်ခြင်း"
---

# `openclaw reset`

Local config/state ကို ပြန်လည်သတ်မှတ်ပါ (CLI ကို ထည့်သွင်းထားနေစေသည်)။

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
