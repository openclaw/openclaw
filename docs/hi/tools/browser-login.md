---
summary: "ब्राउज़र ऑटोमेशन के लिए मैनुअल लॉगिन + X/Twitter पोस्टिंग"
read_when:
  - आपको ब्राउज़र ऑटोमेशन के लिए साइटों में लॉग इन करना हो
  - आप X/Twitter पर अपडेट पोस्ट करना चाहते हों
title: "ब्राउज़र लॉगिन"
---

# ब्राउज़र लॉगिन + X/Twitter पोस्टिंग

## मैनुअल लॉगिन (अनुशंसित)

जब किसी साइट पर लॉगिन आवश्यक हो, तो **होस्ट** ब्राउज़र प्रोफ़ाइल (OpenClaw ब्राउज़र) में **मैनुअल रूप से साइन इन करें**।

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

मुख्य ब्राउज़र दस्तावेज़ों पर वापस जाएँ: [Browser](/tools/browser).

## कौन‑सी Chrome प्रोफ़ाइल उपयोग होती है?

OpenClaw controls a **dedicated Chrome profile** (named `openclaw`, orange‑tinted UI). This is separate from your daily browser profile.

इसे एक्सेस करने के दो आसान तरीके:

1. **एजेंट से ब्राउज़र खोलने के लिए कहें** और फिर स्वयं लॉग इन करें।
2. **CLI के माध्यम से खोलें**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

यदि आपके पास कई प्रोफ़ाइल हैं, तो `--browser-profile <name>` पास करें (डिफ़ॉल्ट `openclaw` है)।

## X/Twitter: अनुशंसित प्रवाह

- **पढ़ना/खोज/थ्रेड्स:** **होस्ट** ब्राउज़र का उपयोग करें (मैनुअल लॉगिन)।
- **अपडेट पोस्ट करना:** **होस्ट** ब्राउज़र का उपयोग करें (मैनुअल लॉगिन)।

## sandboxing + होस्ट ब्राउज़र एक्सेस

Sandboxed browser sessions are **more likely** to trigger bot detection. For X/Twitter (and other strict sites), prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

फिर होस्ट ब्राउज़र को लक्षित करें:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

या अपडेट पोस्ट करने वाले एजेंट के लिए sandboxing अक्षम करें।
