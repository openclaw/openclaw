---
summary: "उच्च‑संकेत वाले इश्यू और बग रिपोर्ट दर्ज करना"
title: "इश्यू सबमिट करना"
---

## इश्यू सबमिट करना

Clear, concise issues speed up diagnosis and fixes. Include the following for bugs, regressions, or feature gaps:

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

Be brief. Terseness > perfect grammar.

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

_Avoid secrets/exploit details in public. For sensitive issues, minimize detail and request private disclosure._

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

Issue before PR is optional. Include details in PR if skipping. Keep the PR focused, note issue number, add tests or explain absence, document behavior changes/risks, include redacted logs/screenshots as proof, and run proper validation before submitting.
