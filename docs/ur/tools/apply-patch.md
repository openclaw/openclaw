---
summary: "apply_patch ٹول کے ذریعے متعدد فائلوں کے پیچ لاگو کریں"
read_when:
  - آپ کو متعدد فائلوں میں منظم ترامیم درکار ہوں
  - آپ پیچ پر مبنی ترامیم کو دستاویزی شکل دینا یا ڈیبگ کرنا چاہتے ہوں
title: "apply_patch ٹول"
x-i18n:
  source_path: tools/apply-patch.md
  source_hash: 8cec2b4ee3afa910
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:40Z
---

# apply_patch ٹول

منظم پیچ فارمیٹ کے ذریعے فائل میں تبدیلیاں لاگو کریں۔ یہ متعدد فائلوں
یا متعدد ہنک ترامیم کے لیے موزوں ہے جہاں ایک ہی `edit` کال غیر مضبوط ثابت ہو سکتی ہے۔

یہ ٹول ایک واحد `input` اسٹرنگ قبول کرتا ہے جو ایک یا زیادہ فائل آپریشنز کو لپیٹتی ہے:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parameters

- `input` (required): مکمل پیچ مواد، بشمول `*** Begin Patch` اور `*** End Patch`۔

## Notes

- راستے ورک اسپیس روٹ کے نسبت حل کیے جاتے ہیں۔
- فائلوں کا نام تبدیل کرنے کے لیے `*** Update File:` ہنک کے اندر `*** Move to:` استعمال کریں۔
- ضرورت پڑنے پر `*** End of File` صرف EOF پر اندراج کو نشان زد کرتا ہے۔
- تجرباتی ہے اور بطورِ طے شدہ غیرفعال ہے۔ `tools.exec.applyPatch.enabled` کے ذریعے فعال کریں۔
- صرف OpenAI کے لیے (بشمول OpenAI Codex)۔ ماڈل کے ذریعے اختیاری طور پر گیٹ کریں:
  `tools.exec.applyPatch.allowModels`۔
- کنفیگ صرف `tools.exec` کے تحت ہے۔

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
