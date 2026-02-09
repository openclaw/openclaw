---
summary: "उच्च-सिग्नल PR कैसे सबमिट करें"
title: "PR सबमिट करना"
---

Good PRs are easy to review: reviewers should quickly know the intent, verify behavior, and land changes safely. This guide covers concise, high-signal submissions for human and LLM review.

## एक अच्छा PR क्या बनाता है

- [ ] समस्या, उसका महत्व, और किए गए बदलाव को समझाएँ।
- [ ] Keep changes focused. Avoid broad refactors.
- [ ] उपयोगकर्ता-परक/विन्यास/डिफ़ॉल्ट में हुए बदलावों का सार दें।
- [ ] टेस्ट कवरेज, स्किप्स, और उनके कारण सूचीबद्ध करें।
- [ ] प्रमाण जोड़ें: लॉग्स, स्क्रीनशॉट्स, या रिकॉर्डिंग्स (UI/UX)।
- [ ] कोड शब्द: यदि आपने यह गाइड पढ़ी है तो PR विवरण में “lobster-biscuit” डालें।
- [ ] PR बनाने से पहले संबंधित `pnpm` कमांड्स चलाएँ/त्रुटियाँ ठीक करें।
- [ ] संबंधित कार्यक्षमता/समस्याओं/फिक्स के लिए कोडबेस और GitHub में खोज करें।
- [ ] दावों को प्रमाण या अवलोकन पर आधारित रखें।
- [ ] अच्छा शीर्षक: क्रिया + दायरा + परिणाम (उदा., `Docs: add PR and issue templates`)।

Be concise; concise review > grammar. Omit any non-applicable sections.

### आधारभूत सत्यापन कमांड्स (अपने बदलाव के लिए विफलताओं को चलाएँ/ठीक करें)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- प्रोटोकॉल बदलाव: `pnpm protocol:check`

## प्रगतिशील प्रकटीकरण

- शीर्ष: सार/उद्देश्य
- अगला: बदलाव/जोखिम
- अगला: परीक्षण/सत्यापन
- अंत में: कार्यान्वयन/प्रमाण

## सामान्य PR प्रकार: विवरण

- [ ] Fix: पुनरुत्पादन (repro), मूल कारण, सत्यापन जोड़ें।
- [ ] Feature: उपयोग मामलों, व्यवहार/डेमो/स्क्रीनशॉट्स (UI) जोड़ें।
- [ ] Refactor: "व्यवहार में कोई बदलाव नहीं" स्पष्ट करें, क्या स्थानांतरित/सरल किया गया सूचीबद्ध करें।
- [ ] Chore: कारण बताएं (उदा., बिल्ड समय, CI, निर्भरताएँ)।
- [ ] Docs: पहले/बाद का संदर्भ, अपडेटेड पेज का लिंक, `pnpm format` चलाएँ।
- [ ] Test: कौन-सा गैप कवर हुआ; यह रिग्रेशन कैसे रोकता है।
- [ ] Perf: पहले/बाद के मेट्रिक्स जोड़ें, और मापन विधि बताएं।
- [ ] UX/UI: स्क्रीनशॉट/वीडियो, पहुँचयोग्यता पर प्रभाव नोट करें।
- [ ] Infra/Build: परिवेश/सत्यापन।
- [ ] Security: Summarize risk, repro, verification, no sensitive data. Grounded claims only.

## चेकलिस्ट

- [ ] स्पष्ट समस्या/उद्देश्य
- [ ] केंद्रित दायरा
- [ ] व्यवहार बदलावों की सूची
- [ ] परीक्षणों की सूची और परिणाम
- [ ] मैनुअल टेस्ट चरण (जहाँ लागू)
- [ ] कोई सीक्रेट/निजी डेटा नहीं
- [ ] प्रमाण-आधारित

## सामान्य PR टेम्पलेट

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR प्रकार टेम्पलेट्स (अपने प्रकार से बदलें)

### Fix

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Feature

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactor

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Security

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
