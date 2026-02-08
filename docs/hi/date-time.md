---
summary: "एंवेलप, प्रॉम्प्ट, टूल्स और कनेक्टर्स में दिनांक और समय का प्रबंधन"
read_when:
  - आप यह बदल रहे हैं कि मॉडल या उपयोगकर्ताओं को टाइमस्टैम्प कैसे दिखाए जाते हैं
  - आप संदेशों या सिस्टम प्रॉम्प्ट आउटपुट में समय-स्वरूपण का डिबग कर रहे हैं
title: "दिनांक और समय"
x-i18n:
  source_path: date-time.md
  source_hash: 753af5946a006215
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:13Z
---

# Date & Time

OpenClaw डिफ़ॉल्ट रूप से **परिवहन टाइमस्टैम्प के लिए होस्ट-लोकल समय** और **सिस्टम प्रॉम्प्ट में केवल उपयोगकर्ता टाइमज़ोन** का उपयोग करता है।
प्रदाता टाइमस्टैम्प संरक्षित रहते हैं ताकि टूल्स अपनी मूल अर्थवत्ता बनाए रखें (वर्तमान समय `session_status` के माध्यम से उपलब्ध है)।

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
- `timeFormat` प्रॉम्प्ट में **12h/24h डिस्प्ले** को नियंत्रित करता है। `auto` OS प्राथमिकताओं का पालन करता है।

## Time format detection (auto)

जब `timeFormat: "auto"` सक्षम हो, OpenClaw OS प्राथमिकता (macOS/Windows) का निरीक्षण करता है
और लोकैल स्वरूपण पर फ़ॉलबैक करता है। पहचाना गया मान **प्रति प्रक्रिया कैश** किया जाता है
ताकि बार-बार सिस्टम कॉल से बचा जा सके।

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
