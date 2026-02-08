---
summary: "उच्च‑संकेत वाले इश्यू और बग रिपोर्ट दर्ज करना"
title: "इश्यू सबमिट करना"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:22Z
---

## इश्यू सबमिट करना

स्पष्ट और संक्षिप्त इश्यू निदान और सुधार को तेज़ करते हैं। बग, रिग्रेशन, या फीचर गैप के लिए निम्नलिखित शामिल करें:

### क्या शामिल करें

- [ ] शीर्षक: क्षेत्र एवं लक्षण
- [ ] न्यूनतम पुनरुत्पादन (repro) चरण
- [ ] अपेक्षित बनाम वास्तविक
- [ ] प्रभाव एवं गंभीरता
- [ ] परिवेश: OS, रनटाइम, संस्करण, विन्यास
- [ ] प्रमाण: संपादित (redacted) लॉग, स्क्रीनशॉट (गैर‑PII)
- [ ] दायरा: नया, रिग्रेशन, या लंबे समय से मौजूद
- [ ] कोड शब्द: अपने इश्यू में lobster-biscuit
- [ ] मौजूदा इश्यू के लिए कोडबेस एवं GitHub खोजा
- [ ] हाल ही में ठीक/सुलझाया नहीं गया है, इसकी पुष्टि (विशेषकर सुरक्षा)
- [ ] दावे प्रमाण या पुनरुत्पादन द्वारा समर्थित

संक्षिप्त रहें। पूर्ण व्याकरण से अधिक संक्षेप महत्वपूर्ण है।

मान्यकरण (PR से पहले चलाएँ/ठीक करें):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- यदि प्रोटोकॉल कोड: `pnpm protocol:check`

### टेम्पलेट्स

#### बग रिपोर्ट

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### सुरक्षा इश्यू

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_सार्वजनिक रूप से सीक्रेट/एक्सप्लॉइट विवरण से बचें। संवेदनशील इश्यू के लिए विवरण न्यूनतम रखें और निजी प्रकटीकरण का अनुरोध करें।_

#### रिग्रेशन रिपोर्ट

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### फीचर अनुरोध

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### एन्हांसमेंट

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### जांच

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### फिक्स PR सबमिट करना

PR से पहले इश्यू वैकल्पिक है। यदि छोड़ रहे हैं तो PR में विवरण शामिल करें। PR को केंद्रित रखें, इश्यू नंबर नोट करें, परीक्षण जोड़ें या उनकी अनुपस्थिति का कारण बताएं, व्यवहार परिवर्तन/जोखिम दस्तावेज़ करें, प्रमाण के रूप में संपादित लॉग/स्क्रीनशॉट शामिल करें, और सबमिट करने से पहले उचित मान्यकरण चलाएँ।
