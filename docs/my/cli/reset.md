---
summary: "`openclaw reset` အတွက် CLI ကိုးကားချက် (local state/config ကို ပြန်လည်သတ်မှတ်ခြင်း)"
read_when:
  - CLI ကို ဆက်လက်ထည့်သွင်းထားစေပြီး local state ကို ဖျက်ရှင်းလိုသောအခါ
  - ဖယ်ရှားမည့်အရာများကို dry-run ဖြင့် ကြိုတင်ကြည့်လိုသောအခါ
title: "ပြန်လည်သတ်မှတ်ခြင်း"
x-i18n:
  source_path: cli/reset.md
  source_hash: 08afed5830f892e0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:02Z
---

# `openclaw reset`

Local config/state ကို ပြန်လည်သတ်မှတ်ပါ (CLI ကို ထည့်သွင်းထားနေစေသည်)။

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config+creds+sessions --yes --non-interactive
```
