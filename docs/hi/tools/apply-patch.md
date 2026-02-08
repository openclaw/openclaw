---
summary: "apply_patch टूल के साथ बहु-फ़ाइल पैच लागू करें"
read_when:
  - आपको कई फ़ाइलों में संरचित संपादन की आवश्यकता है
  - आप पैच-आधारित संपादनों का दस्तावेज़ीकरण या डिबग करना चाहते हैं
title: "apply_patch टूल"
x-i18n:
  source_path: tools/apply-patch.md
  source_hash: 8cec2b4ee3afa910
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:41Z
---

# apply_patch टूल

संरचित पैच फ़ॉर्मैट का उपयोग करके फ़ाइल परिवर्तन लागू करें। यह बहु-फ़ाइल
या बहु-हंक संपादनों के लिए आदर्श है, जहाँ एकल `edit` कॉल अस्थिर हो सकता है।

यह टूल एक एकल `input` स्ट्रिंग स्वीकार करता है जो एक या अधिक फ़ाइल ऑपरेशनों को समेटती है:

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

## पैरामीटर

- `input` (आवश्यक): पूर्ण पैच सामग्री, जिसमें `*** Begin Patch` और `*** End Patch` शामिल हैं।

## नोट्स

- पाथ्स को वर्कस्पेस रूट के सापेक्ष रेज़ॉल्व किया जाता है।
- फ़ाइलों का नाम बदलने के लिए `*** Update File:` हंक के भीतर `*** Move to:` का उपयोग करें।
- आवश्यकता होने पर `*** End of File` केवल-EOF इन्सर्ट को चिह्नित करता है।
- प्रयोगात्मक है और डिफ़ॉल्ट रूप से अक्षम है। `tools.exec.applyPatch.enabled` के साथ सक्षम करें।
- केवल OpenAI के लिए (OpenAI Codex सहित)। वैकल्पिक रूप से मॉडल के माध्यम से गेट करें:
  `tools.exec.applyPatch.allowModels`।
- विन्यास केवल `tools.exec` के अंतर्गत है।

## उदाहरण

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
