---
summary: "एंवेलप, प्रॉम्प्ट, टूल्स और कनेक्टर्स में दिनांक और समय का प्रबंधन"
read_when:
  - आप यह बदल रहे हैं कि मॉडल या उपयोगकर्ताओं को टाइमस्टैम्प कैसे दिखाए जाते हैं
  - आप संदेशों या सिस्टम प्रॉम्प्ट आउटपुट में समय-स्वरूपण का डिबग कर रहे हैं
title: "दिनांक और समय"
---

# Date & Time

6. OpenClaw transport timestamps के लिए डिफ़ॉल्ट रूप से **host‑local time** और **system prompt में केवल user timezone** का उपयोग करता है।
7. Provider timestamps को संरक्षित रखा जाता है ताकि tools अपनी native semantics बनाए रखें (current time `session_status` के माध्यम से उपलब्ध है)।

## Message envelopes (local by default)

इनबाउंड संदेशों को एक टाइमस्टैम्प के साथ लपेटा जाता है (मिनट-स्तरीय सटीकता):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

यह एंवेलप टाइमस्टैम्प **डिफ़ॉल्ट रूप से होस्ट-लोकल** होता है, प्रदाता टाइमज़ोन की परवाह किए बिना।

आप इस व्यवहार को ओवरराइड कर सकते हैं:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` UTC का उपयोग करता है।
- `envelopeTimezone: "local"` होस्ट टाइमज़ोन का उपयोग करता है।
- `envelopeTimezone: "user"` `agents.defaults.userTimezone` का उपयोग करता है (होस्ट टाइमज़ोन पर फ़ॉलबैक)।
- किसी निश्चित ज़ोन के लिए स्पष्ट IANA टाइमज़ोन (उदा., `"America/Chicago"`) का उपयोग करें।
- `envelopeTimestamp: "off"` एंवेलप हेडर से पूर्ण टाइमस्टैम्प हटाता है।
- `envelopeElapsed: "off"` बीता हुआ समय प्रत्यय हटाता है (`+2m` शैली)।

### Examples

**Local (default):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**User timezone:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Elapsed time enabled:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## System prompt: Current Date & Time

यदि उपयोगकर्ता टाइमज़ोन ज्ञात है, तो सिस्टम प्रॉम्प्ट में एक समर्पित
**Current Date & Time** अनुभाग शामिल होता है, जिसमें **केवल टाइम ज़ोन** होता है (कोई घड़ी/समय-स्वरूप नहीं),
ताकि प्रॉम्प्ट कैशिंग स्थिर बनी रहे:

```
Time zone: America/Chicago
```

जब एजेंट को वर्तमान समय की आवश्यकता हो, तो `session_status` टूल का उपयोग करें; स्टेटस
कार्ड में एक टाइमस्टैम्प पंक्ति शामिल होती है।

## System event lines (local by default)

एजेंट संदर्भ में डाले गए कतारबद्ध सिस्टम इवेंट्स को एक टाइमस्टैम्प के साथ प्रीफ़िक्स किया जाता है,
जो संदेश एंवेलप्स के समान टाइमज़ोन चयन का उपयोग करता है (डिफ़ॉल्ट: होस्ट-लोकल)।

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configure user timezone + format

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` प्रॉम्प्ट संदर्भ के लिए **उपयोगकर्ता-लोकल टाइमज़ोन** सेट करता है।
- 8. `timeFormat` prompt में **12h/24h display** को नियंत्रित करता है। 9. `auto` OS preferences का पालन करता है।

## Time format detection (auto)

10. जब `timeFormat: "auto"` होता है, OpenClaw OS preference (macOS/Windows) का निरीक्षण करता है
    और locale formatting पर fallback करता है। 11. Detect किया गया मान **per process cached** किया जाता है
    taaki repeated system calls से बचा जा सके।

## Tool payloads + connectors (raw provider time + normalized fields)

चैनल टूल्स **प्रदाता-देशी टाइमस्टैम्प** लौटाते हैं और संगति के लिए सामान्यीकृत फ़ील्ड्स जोड़ते हैं:

- `timestampMs`: epoch मिलीसेकंड (UTC)
- `timestampUtc`: ISO 8601 UTC स्ट्रिंग

रॉ प्रदाता फ़ील्ड्स संरक्षित रहते हैं ताकि कुछ भी न खोए।

- Slack: API से epoch-जैसी स्ट्रिंग्स
- Discord: UTC ISO टाइमस्टैम्प्स
- Telegram/WhatsApp: प्रदाता-विशिष्ट संख्यात्मक/ISO टाइमस्टैम्प्स

यदि आपको लोकल समय चाहिए, तो ज्ञात टाइमज़ोन का उपयोग करके इसे डाउनस्ट्रीम में परिवर्तित करें।

## Related docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
