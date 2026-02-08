---
summary: "CLI کے لیے `openclaw onboard` کا حوالہ (انٹرایکٹو آن بورڈنگ وزارڈ)"
read_when:
  - آپ گیٹ وے، ورک اسپیس، تصدیق، چینلز اور Skills کے لیے رہنمائی شدہ سیٹ اپ چاہتے ہیں
title: "آن بورڈ"
x-i18n:
  source_path: cli/onboard.md
  source_hash: 69a96accb2d571ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:02Z
---

# `openclaw onboard`

انٹرایکٹو آن بورڈنگ وزارڈ (لوکل یا ریموٹ Gateway سیٹ اپ)۔

## متعلقہ رہنما

- CLI آن بورڈنگ ہب: [Onboarding Wizard (CLI)](/start/wizard)
- CLI آن بورڈنگ حوالہ: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI آٹومیشن: [CLI Automation](/start/wizard-cli-automation)
- macOS آن بورڈنگ: [Onboarding (macOS App)](/start/onboarding)

## مثالیں

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

فلو نوٹس:

- `quickstart`: کم سے کم پرامپٹس، خودکار طور پر گیٹ وے ٹوکن تیار کرتا ہے۔
- `manual`: پورٹ/بائنڈ/تصدیق کے لیے مکمل پرامپٹس ( `advanced` کا عرف)۔
- سب سے تیز پہلی چیٹ: `openclaw dashboard` (کنٹرول UI، کوئی چینل سیٹ اپ نہیں)۔

## عام فالو اپ کمانڈز

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` غیر تعاملی موڈ کی دلالت نہیں کرتا۔ اسکرپٹس کے لیے `--non-interactive` استعمال کریں۔
</Note>
