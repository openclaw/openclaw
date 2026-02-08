---
summary: "डिवाइस फ़्लो का उपयोग करके OpenClaw से GitHub Copilot में साइन इन करें"
read_when:
  - आप GitHub Copilot को मॉडल प्रदाता के रूप में उपयोग करना चाहते हैं
  - आपको `openclaw models auth login-github-copilot` फ़्लो की आवश्यकता है
title: "GitHub Copilot"
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:34Z
---

# GitHub Copilot

## GitHub Copilot क्या है?

GitHub Copilot, GitHub का एआई कोडिंग सहायक है। यह आपके GitHub खाते और प्लान के लिए Copilot
मॉडलों तक पहुँच प्रदान करता है। OpenClaw, Copilot को मॉडल
प्रदाता के रूप में दो अलग-अलग तरीकों से उपयोग कर सकता है।

## OpenClaw में Copilot उपयोग करने के दो तरीके

### 1) अंतर्निर्मित GitHub Copilot प्रदाता (`github-copilot`)

नेटिव डिवाइस-लॉगिन फ़्लो का उपयोग करके GitHub टोकन प्राप्त करें, फिर जब OpenClaw चलता है तो उसे
Copilot API टोकनों के लिए एक्सचेंज करें। यह **डिफ़ॉल्ट** और सबसे सरल मार्ग है
क्योंकि इसमें VS Code की आवश्यकता नहीं होती।

### 2) Copilot Proxy प्लगइन (`copilot-proxy`)

**Copilot Proxy** VS Code एक्सटेंशन को एक स्थानीय ब्रिज के रूप में उपयोग करें। OpenClaw
प्रॉक्सी के `/v1` एंडपॉइंट से संवाद करता है और वहाँ कॉन्फ़िगर की गई मॉडल सूची का उपयोग करता है।
इसे तब चुनें जब आप पहले से VS Code में Copilot Proxy चला रहे हों या उसके माध्यम से रूट करने की आवश्यकता हो।
आपको प्लगइन सक्षम करना होगा और VS Code एक्सटेंशन को चालू रखना होगा।

GitHub Copilot को मॉडल प्रदाता के रूप में उपयोग करें (`github-copilot`)। लॉगिन कमांड
GitHub डिवाइस फ़्लो चलाता है, एक ऑथ प्रोफ़ाइल सहेजता है, और उस प्रोफ़ाइल का उपयोग करने के लिए
आपके विन्यास को अपडेट करता है।

## CLI सेटअप

```bash
openclaw models auth login-github-copilot
```

आपसे एक URL पर जाने और एक बार उपयोग होने वाला कोड दर्ज करने के लिए कहा जाएगा। प्रक्रिया पूरी होने तक
टर्मिनल खुला रखें।

### वैकल्पिक फ़्लैग्स

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## एक डिफ़ॉल्ट मॉडल सेट करें

```bash
openclaw models set github-copilot/gpt-4o
```

### विन्यास स्निपेट

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## टिप्पणियाँ

- इंटरैक्टिव TTY की आवश्यकता होती है; इसे सीधे टर्मिनल में चलाएँ।
- Copilot मॉडल की उपलब्धता आपके प्लान पर निर्भर करती है; यदि किसी मॉडल को अस्वीकार किया जाता है, तो
  किसी अन्य ID का प्रयास करें (उदाहरण के लिए `github-copilot/gpt-4.1`)।
- लॉगिन, ऑथ प्रोफ़ाइल स्टोर में एक GitHub टोकन सहेजता है और जब OpenClaw चलता है तो उसे
  Copilot API टोकन के लिए एक्सचेंज करता है।
