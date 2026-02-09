---
summary: "SOUL Evil हुक (SOUL.md को SOUL_EVIL.md से स्वैप करता है)"
read_when:
  - आप SOUL Evil हुक को सक्षम या ट्यून करना चाहते हैं
  - आप पर्ज विंडो या रैंडम-चांस पर्सोना स्वैप चाहते हैं
title: "SOUL Evil हुक"
---

# SOUL Evil हुक

SOUL Evil hook, **injected** `SOUL.md` कंटेंट को purge window के दौरान या रैंडम चांस से `SOUL_EVIL.md` से स्वैप कर देता है। यह डिस्क पर मौजूद फ़ाइलों को **modify नहीं** करता।

## यह कैसे काम करता है

जब `agent:bootstrap` चलता है, तब सिस्टम प्रॉम्प्ट असेंबल होने से पहले hook मेमोरी में `SOUL.md` कंटेंट को बदल सकता है। अगर `SOUL_EVIL.md` गायब है या खाली है,
OpenClaw एक warning लॉग करता है और सामान्य `SOUL.md` को बनाए रखता है।

सब-एजेंट रन में अपने बूटस्ट्रैप फ़ाइलों में `SOUL.md` शामिल नहीं होता, इसलिए इस हुक का सब-एजेंट्स पर कोई प्रभाव नहीं पड़ता।

## सक्षम करें

```bash
openclaw hooks enable soul-evil
```

फिर विन्यास सेट करें:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

एजेंट वर्कस्पेस रूट में `SOUL_EVIL.md` बनाएँ ( `SOUL.md` के बगल में)।

## विकल्प

- `file` (string): वैकल्पिक SOUL फ़ाइलनाम (डिफ़ॉल्ट: `SOUL_EVIL.md`)
- `chance` (number 0–1): प्रति रन `SOUL_EVIL.md` का उपयोग करने की रैंडम संभावना
- `purge.at` (HH:mm): दैनिक पर्ज प्रारंभ (24-घंटे की घड़ी)
- `purge.duration` (duration): window की लंबाई (उदा. `30s`, `10m`, `1h`)

**प्राथमिकता:** पर्ज विंडो की प्राथमिकता रैंडम चांस पर होती है।

**समय-क्षेत्र:** सेट होने पर `agents.defaults.userTimezone` का उपयोग करता है; अन्यथा होस्ट का समय-क्षेत्र।

## टिप्पणियाँ

- डिस्क पर कोई फ़ाइल लिखी या संशोधित नहीं की जाती।
- यदि `SOUL.md` बूटस्ट्रैप सूची में नहीं है, तो हुक कुछ नहीं करता।

## यह भी देखें

- [Hooks](/automation/hooks)
