---
summary: "इनबाउंड ऑडियो/वॉयस नोट्स कैसे डाउनलोड किए जाते हैं, ट्रांसक्राइब होते हैं, और उत्तरों में इंजेक्ट किए जाते हैं"
read_when:
  - ऑडियो ट्रांसक्रिप्शन या मीडिया हैंडलिंग बदलते समय
title: "ऑडियो और वॉयस नोट्स"
---

# ऑडियो / वॉयस नोट्स — 2026-01-17

## क्या काम करता है

- **मीडिया समझ (ऑडियो)**: यदि ऑडियो समझ सक्षम है (या स्वतः‑पता चल जाती है), OpenClaw:
  1. पहले ऑडियो अटैचमेंट (लोकल पथ या URL) को खोजता है और आवश्यकता होने पर डाउनलोड करता है।
  2. प्रत्येक मॉडल एंट्री को भेजने से पहले `maxBytes` लागू करता है।
  3. क्रम में पहली पात्र मॉडल एंट्री (प्रदाता या CLI) चलाता है।
  4. यदि वह विफल होती है या स्किप होती है (आकार/टाइमआउट), तो अगली एंट्री आज़माता है।
  5. सफलता पर, `Body` को `[Audio]` ब्लॉक से बदलता है और `{{Transcript}}` सेट करता है।
- **कमांड पार्सिंग**: जब ट्रांसक्रिप्शन सफल होता है, तो `CommandBody`/`RawBody` को ट्रांसक्रिप्ट पर सेट किया जाता है ताकि स्लैश कमांड्स काम करते रहें।
- **विस्तृत लॉगिंग**: `--verbose` में, हम लॉग करते हैं कि ट्रांसक्रिप्शन कब चलता है और कब यह बॉडी को बदलता है।

## स्वतः‑पता लगाना (डिफ़ॉल्ट)

यदि आप **मॉडल कॉन्फ़िगर नहीं करते** और `tools.media.audio.enabled` को `false` पर **सेट नहीं** किया गया है,
तो OpenClaw निम्न क्रम में स्वतः‑पता लगाता है और पहली कार्यशील विकल्प पर रुक जाता है:

1. **लोकल CLI** (यदि इंस्टॉल हों)
   - `sherpa-onnx-offline` (इसके लिए `SHERPA_ONNX_MODEL_DIR` आवश्यक है, जिसमें encoder/decoder/joiner/tokens हों)
   - `whisper-cli` (`whisper-cpp` से; `WHISPER_CPP_MODEL` या बंडल्ड tiny मॉडल का उपयोग करता है)
   - `whisper` (Python CLI; मॉडल स्वतः डाउनलोड करता है)
2. **Gemini CLI** (`gemini`) का उपयोग `read_many_files` के साथ
3. **प्रदाता कुंजियाँ** (OpenAI → Groq → Deepgram → Google)

Auto-detection को अक्षम करने के लिए, `tools.media.audio.enabled: false` सेट करें।
Customize करने के लिए, `tools.media.audio.models` सेट करें।
टिप्पणी: बाइनरी डिटेक्शन macOS/Linux/Windows पर best‑effort है; सुनिश्चित करें कि CLI `PATH` पर है (हम `~` का विस्तार करते हैं), या पूर्ण कमांड पथ के साथ एक स्पष्ट CLI मॉडल सेट करें।

## विन्यास उदाहरण

### प्रदाता + CLI फ़ॉलबैक (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### स्कोप गेटिंग के साथ केवल‑प्रदाता

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### केवल‑प्रदाता (Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## नोट्स और सीमाएँ

- प्रदाता प्रमाणीकरण मानक मॉडल प्रमाणीकरण क्रम का पालन करता है (auth प्रोफ़ाइल, env vars, `models.providers.*.apiKey`)।
- Deepgram, जब `provider: "deepgram"` उपयोग किया जाता है, तो `DEEPGRAM_API_KEY` को ग्रहण करता है।
- Deepgram सेटअप विवरण: [Deepgram (ऑडियो ट्रांसक्रिप्शन)](/providers/deepgram)।
- ऑडियो प्रदाता `tools.media.audio` के माध्यम से `baseUrl`, `headers`, और `providerOptions` को ओवरराइड कर सकते हैं।
- Default size cap 20MB है (`tools.media.audio.maxBytes`)। Oversize audio उस मॉडल के लिए छोड़ दिया जाता है और अगली प्रविष्टि आज़माई जाती है।
- Audio के लिए default `maxChars` **unset** होता है (पूरा transcript)। आउटपुट ट्रिम करने के लिए `tools.media.audio.maxChars` या प्रति-प्रविष्टि `maxChars` सेट करें।
- OpenAI का ऑटो डिफ़ॉल्ट `gpt-4o-mini-transcribe` है; अधिक सटीकता के लिए `model: "gpt-4o-transcribe"` सेट करें।
- अनेक वॉयस नोट्स प्रोसेस करने के लिए `tools.media.audio.attachments` का उपयोग करें (`mode: "all"` + `maxAttachments`)।
- ट्रांसक्रिप्ट टेम्पलेट्स में `{{Transcript}}` के रूप में उपलब्ध है।
- CLI stdout सीमित है (5MB); CLI आउटपुट संक्षिप्त रखें।

## सावधानियाँ

- Scope rules में first-match wins लागू होता है। `chatType` को `direct`, `group`, या `room` में normalize किया जाता है।
- सुनिश्चित करें कि आपका CLI 0 के साथ बाहर निकलता है और सादा पाठ प्रिंट करता है; JSON को `jq -r .text` के माध्यम से समायोजित करना होगा।
- उत्तर कतार को ब्लॉक होने से बचाने के लिए टाइमआउट उचित रखें (`timeoutSeconds`, डिफ़ॉल्ट 60s)।
