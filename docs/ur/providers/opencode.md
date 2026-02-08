---
summary: "OpenClaw کے ساتھ OpenCode Zen (منتخب ماڈلز) استعمال کریں"
read_when:
  - آپ ماڈل تک رسائی کے لیے OpenCode Zen چاہتے ہیں
  - آپ کو کوڈنگ کے لیے موزوں ماڈلز کی ایک منتخب فہرست درکار ہے
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:29Z
---

# OpenCode Zen

OpenCode Zen، OpenCode ٹیم کی جانب سے کوڈنگ ایجنٹس کے لیے تجویز کردہ **ماڈلز کی منتخب فہرست** ہے۔
یہ ایک اختیاری، ہوسٹڈ ماڈل رسائی کا راستہ ہے جو API کلید اور `opencode` فراہم کنندہ استعمال کرتا ہے۔
Zen اس وقت بیٹا میں ہے۔

## CLI سیٹ اپ

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## کنفیگ ٹکڑا

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## نوٹس

- `OPENCODE_ZEN_API_KEY` بھی سپورٹ کیا جاتا ہے۔
- آپ Zen میں سائن اِن کرتے ہیں، بلنگ کی تفصیلات شامل کرتے ہیں، اور اپنی API کلید کاپی کرتے ہیں۔
- OpenCode Zen فی درخواست بل کرتا ہے؛ تفصیلات کے لیے OpenCode ڈیش بورڈ دیکھیں۔
