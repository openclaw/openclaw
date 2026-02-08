---
summary: "استخدم OpenCode Zen (نماذج مُنسّقة) مع OpenClaw"
read_when:
  - "تريد OpenCode Zen للوصول إلى النماذج"
  - "تريد قائمة مُنسّقة من النماذج الملائمة للبرمجة"
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:30Z
---

# OpenCode Zen

OpenCode Zen هي **قائمة مُنسّقة من النماذج** يوصي بها فريق OpenCode لوكلاء البرمجة.
وهي مسار اختياري ومُستضاف للوصول إلى النماذج يستخدم مفتاح API وموفّر `opencode`.
Zen حاليًا في مرحلة بيتا.

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

- `OPENCODE_ZEN_API_KEY` مدعوم أيضًا.
- تقوم بتسجيل الدخول إلى Zen، وإضافة تفاصيل الفوترة، ثم نسخ مفتاح API الخاص بك.
- تعتمد فوترة OpenCode Zen على كل طلب؛ تحقّق من لوحة تحكّم OpenCode للتفاصيل.
