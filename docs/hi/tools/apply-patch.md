---
summary: "apply_patch टूल के साथ बहु-फ़ाइल पैच लागू करें"
read_when:
  - आपको कई फ़ाइलों में संरचित संपादन की आवश्यकता है
  - आप पैच-आधारित संपादनों का दस्तावेज़ीकरण या डिबग करना चाहते हैं
title: "apply_patch टूल"
---

# apply_patch टूल

Apply file changes using a structured patch format. This is ideal for multi-file
or multi-hunk edits where a single `edit` call would be brittle.

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
- Experimental and disabled by default. Enable with `tools.exec.applyPatch.enabled`.
- OpenAI-only (including OpenAI Codex). Optionally gate by model via
  `tools.exec.applyPatch.allowModels`.
- विन्यास केवल `tools.exec` के अंतर्गत है।

## उदाहरण

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
