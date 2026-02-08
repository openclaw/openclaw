---
summary: "Gateway（ဂိတ်ဝေး）၏ ကျန်းမာရေးအခြေအနေကို RPC မှတဆင့် စစ်ဆေးရန် `openclaw health` အတွက် CLI ကိုးကားချက်"
read_when:
  - Gateway（ဂိတ်ဝေး） လည်ပတ်နေမှု၏ ကျန်းမာရေးကို အမြန်စစ်ဆေးလိုသည့်အခါ
title: "health"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:01Z
---

# `openclaw health`

လည်ပတ်နေသော Gateway（ဂိတ်ဝေး） မှ ကျန်းမာရေးအချက်အလက်ကို ရယူပါ။

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

မှတ်ချက်များ:

- `--verbose` သည် live probes များကို လည်ပတ်စေပြီး အကောင့်များကို အများအပြား ဖွဲ့စည်းထားပါက အကောင့်တစ်ခုချင်းစီအလိုက် အချိန်တိုင်းတာချက်များကို ပြသပေးသည်။
- အေးဂျင့်များကို အများအပြား ဖွဲ့စည်းထားပါက အထွက်ရလဒ်တွင် အေးဂျင့်တစ်ခုချင်းစီအလိုက် session store များကို ပါဝင်ပြသထားသည်။
