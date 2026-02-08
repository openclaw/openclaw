---
summary: "OpenClaw တွင် OpenAI ကို API ကီးများ သို့မဟုတ် Codex စာရင်းသွင်းမှုဖြင့် အသုံးပြုရန်"
read_when:
  - OpenClaw တွင် OpenAI မော်ဒယ်များကို အသုံးပြုလိုသောအခါ
  - API ကီးများအစား Codex စာရင်းသွင်းမှု အတည်ပြုခြင်းကို အသုံးပြုလိုသောအခါ
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:49Z
---

# OpenAI

OpenAI သည် GPT မော်ဒယ်များအတွက် ဖန်တီးသူများအသုံးပြုနိုင်သော API များကို ပံ့ပိုးပေးသည်။ Codex သည် စာရင်းသွင်းမှုအခြေပြု အသုံးပြုခွင့်အတွက် **ChatGPT sign-in** ကို ပံ့ပိုးပြီး၊ အသုံးပြုမှုအလိုက် ငွေပေးချေရန် **API key** ဖြင့်လည်း ဝင်ရောက်နိုင်သည်။ Codex cloud သည် ChatGPT sign-in ကို လိုအပ်သည်။

## ရွေးချယ်မှု A: OpenAI API key (OpenAI Platform)

**အသင့်တော်ဆုံး:** တိုက်ရိုက် API အသုံးပြုခွင့်နှင့် အသုံးပြုမှုအလိုက် ငွေပေးချေမှု။
OpenAI dashboard မှ သင့် API key ကို ရယူပါ။

### CLI setup

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Config snippet

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## ရွေးချယ်မှု B: OpenAI Code (Codex) စာရင်းသွင်းမှု

**အသင့်တော်ဆုံး:** API key မသုံးဘဲ ChatGPT/Codex စာရင်းသွင်းမှု အသုံးပြုခွင့်ကို အသုံးပြုလိုသောအခါ။
Codex cloud သည် ChatGPT sign-in ကို လိုအပ်ပြီး၊ Codex CLI သည် ChatGPT သို့မဟုတ် API key ဖြင့် ဝင်ရောက်နိုင်သည်။

### CLI setup (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Config snippet (Codex စာရင်းသွင်းမှု)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## မှတ်ချက်များ

- မော်ဒယ်ကိုးကားချက်များသည် အမြဲတမ်း `provider/model` ကို အသုံးပြုသည် ([/concepts/models](/concepts/models) ကို ကြည့်ပါ)။
- အတည်ပြုခြင်း အသေးစိတ်များနှင့် ပြန်လည်အသုံးပြုမှု စည်းမျဉ်းများကို [/concepts/oauth](/concepts/oauth) တွင် ဖော်ပြထားသည်။
