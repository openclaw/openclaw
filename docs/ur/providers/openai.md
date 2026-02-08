---
summary: "OpenClaw میں OpenAI کو API کلیدوں یا Codex سبسکرپشن کے ذریعے استعمال کریں"
read_when:
  - آپ OpenClaw میں OpenAI ماڈلز استعمال کرنا چاہتے ہیں
  - آپ API کلیدوں کے بجائے Codex سبسکرپشن کی تصدیق چاہتے ہیں
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:30Z
---

# OpenAI

OpenAI GPT ماڈلز کے لیے ڈویلپر APIs فراہم کرتا ہے۔ Codex **ChatGPT سائن اِن** کے ذریعے سبسکرپشن رسائی یا **API کلید** سائن اِن کے ذریعے استعمال پر مبنی رسائی کی حمایت کرتا ہے۔ Codex کلاؤڈ کے لیے ChatGPT سائن اِن درکار ہے۔

## آپشن A: OpenAI API کلید (OpenAI Platform)

**بہترین برائے:** براہِ راست API رسائی اور استعمال پر مبنی بلنگ۔
اپنی API کلید OpenAI ڈیش بورڈ سے حاصل کریں۔

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

**بہترین برائے:** API کلید کے بجائے ChatGPT/Codex سبسکرپشن رسائی کا استعمال۔
Codex کلاؤڈ کے لیے ChatGPT سائن اِن درکار ہے، جبکہ Codex CLI ChatGPT یا API کلید سائن اِن کی حمایت کرتا ہے۔

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
