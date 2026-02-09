---
summary: "OpenClaw တွင် OpenAI ကို API ကီးများ သို့မဟုတ် Codex စာရင်းသွင်းမှုဖြင့် အသုံးပြုရန်"
read_when:
  - OpenClaw တွင် OpenAI မော်ဒယ်များကို အသုံးပြုလိုသောအခါ
  - API ကီးများအစား Codex စာရင်းသွင်းမှု အတည်ပြုခြင်းကို အသုံးပြုလိုသောအခါ
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription
access or **API key** sign-in for usage-based access. Codex cloud requires ChatGPT sign-in.

## ရွေးချယ်မှု A: OpenAI API key (OpenAI Platform)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

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

**Best for:** using ChatGPT/Codex subscription access instead of an API key.
Codex cloud requires ChatGPT sign-in, while the Codex CLI supports ChatGPT or API key sign-in.

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
