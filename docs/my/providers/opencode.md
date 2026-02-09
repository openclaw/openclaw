---
summary: "OpenClaw နှင့်အတူ OpenCode Zen (ရွေးချယ်စိစစ်ထားသော မော်ဒယ်များ) ကို အသုံးပြုပါ"
read_when:
  - မော်ဒယ်အသုံးပြုခွင့်အတွက် OpenCode Zen ကို လိုအပ်ပါက
  - ကုဒ်ရေးသားမှုအတွက် သင့်လျော်သော မော်ဒယ်များ၏ ရွေးချယ်စိစစ်ထားသော စာရင်းကို လိုအပ်ပါက
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.
It is an optional, hosted model access path that uses an API key and the `opencode` provider.
Zen is currently in beta.

## CLI setup

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notes

- `OPENCODE_ZEN_API_KEY` ကိုလည်း ပံ့ပိုးထားပါသည်။
- Zen သို့ ဝင်ရောက်အကောင့်ဖွင့်ပြီး billing အချက်အလက်များ ထည့်သွင်းကာ သင်၏ API key ကို ကူးယူပါ။
- OpenCode Zen သည် တောင်းဆိုမှုတစ်ခုချင်းစီအလိုက် အခကြေးငွေကောက်ခံပါသည်။ အသေးစိတ်အချက်အလက်များအတွက် OpenCode dashboard ကို စစ်ဆေးပါ။
