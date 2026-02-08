---
summary: "`openclaw memory` (status/index/search) အတွက် CLI ကိုးကားချက်"
read_when:
  - သင်သည် semantic memory ကို အညွှန်းသတ်မှတ်ခြင်း သို့မဟုတ် ရှာဖွေလိုသောအခါ
  - memory ရရှိနိုင်မှု သို့မဟုတ် အညွှန်းသတ်မှတ်ခြင်းကို ဒီဘဂ်လုပ်နေစဉ်
title: "မှတ်ဉာဏ်"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:03Z
---

# `openclaw memory`

semantic memory အညွှန်းသတ်မှတ်ခြင်းနှင့် ရှာဖွေမှုကို စီမံခန့်ခွဲရန်။
လက်ရှိအသုံးပြုနေသော memory plugin မှ ပံ့ပိုးထားသည် (မူလအဖြစ်: `memory-core`; ပိတ်ရန် `plugins.slots.memory = "none"` ကို သတ်မှတ်ပါ)။

ဆက်စပ်အကြောင်းအရာများ—

- Memory အယူအဆ: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## ဥပမာများ

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## ရွေးချယ်စရာများ

အထွေထွေ—

- `--agent <id>`: အေးဂျင့်တစ်ခုတည်းသို့ အကျုံးဝင်စေသည် (မူလ: ဖွဲ့စည်းပြင်ဆင်ထားသော အေးဂျင့်အားလုံး)။
- `--verbose`: probe များနှင့် အညွှန်းသတ်မှတ်ခြင်းအတွင်း အသေးစိတ် လော့ဂ်များ ထုတ်ပေးသည်။

မှတ်ချက်များ—

- `memory status --deep` သည် vector နှင့် embedding ရရှိနိုင်မှုကို စစ်ဆေးသည်။
- `memory status --deep --index` သည် store သည် dirty ဖြစ်နေပါက ပြန်လည် အညွှန်းသတ်မှတ်ခြင်းကို လုပ်ဆောင်သည်။
- `memory index --verbose` သည် အဆင့်လိုက် အသေးစိတ်အချက်အလက်များ (provider, model, sources, batch activity) ကို ထုတ်ပြသည်။
- `memory status` သည် `memorySearch.extraPaths` မှတဆင့် ဖွဲ့စည်းပြင်ဆင်ထားသော အပိုလမ်းကြောင်းများကိုလည်း ထည့်သွင်းပါဝင်စေသည်။
