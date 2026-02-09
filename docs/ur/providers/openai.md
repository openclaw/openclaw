---
summary: "OpenClaw میں OpenAI کو API کلیدوں یا Codex سبسکرپشن کے ذریعے استعمال کریں"
read_when:
  - آپ OpenClaw میں OpenAI ماڈلز استعمال کرنا چاہتے ہیں
  - آپ API کلیدوں کے بجائے Codex سبسکرپشن کی تصدیق چاہتے ہیں
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex سبسکرپشن رسائی کے لیے **ChatGPT sign-in** یا استعمال کی بنیاد پر رسائی کے لیے **API key** sign-in کو سپورٹ کرتا ہے۔ Codex cloud کے لیے ChatGPT sign-in درکار ہے۔

## آپشن A: OpenAI API کلید (OpenAI Platform)

**Best for:** براہِ راست API رسائی اور استعمال کی بنیاد پر بلنگ۔
اپنی API key OpenAI ڈیش بورڈ سے حاصل کریں۔

### CLI سیٹ اپ

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### کنفیگ ٹکڑا

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## آپشن B: OpenAI Code (Codex) سبسکرپشن

**Best for:** API key کے بجائے ChatGPT/Codex سبسکرپشن رسائی استعمال کرنا۔
Codex cloud کو ChatGPT sign-in درکار ہے، جبکہ Codex CLI ChatGPT یا API key sign-in کو سپورٹ کرتا ہے۔

### CLI سیٹ اپ (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### کنفیگ ٹکڑا (Codex سبسکرپشن)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## نوٹس

- ماڈل حوالہ جات ہمیشہ `provider/model` استعمال کرتے ہیں (دیکھیے [/concepts/models](/concepts/models))۔
- تصدیق کی تفصیلات اور دوبارہ استعمال کے قواعد [/concepts/oauth](/concepts/oauth) میں موجود ہیں۔
