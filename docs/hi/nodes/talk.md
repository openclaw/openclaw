---
summary: "Talk मोड: ElevenLabs TTS के साथ सतत भाषण वार्तालाप"
read_when:
  - macOS/iOS/Android पर Talk मोड लागू करते समय
  - वॉइस/TTS/इंटरप्ट व्यवहार बदलते समय
title: "Talk मोड"
---

# Talk मोड

Talk मोड एक सतत वॉइस वार्तालाप लूप है:

1. भाषण सुनें
2. ट्रांसक्रिप्ट को मॉडल को भेजें (मुख्य सत्र, chat.send)
3. प्रतिक्रिया की प्रतीक्षा करें
4. ElevenLabs के माध्यम से उसे बोलें (स्ट्रीमिंग प्लेबैक)

## व्यवहार (macOS)

- Talk मोड सक्षम होने पर **हमेशा-ऑन ओवरले**।
- **Listening → Thinking → Speaking** चरण संक्रमण।
- **छोटे विराम** (मौन विंडो) पर, वर्तमान ट्रांसक्रिप्ट भेज दिया जाता है।
- उत्तर **WebChat में लिखे जाते हैं** (टाइप करने के समान)।
- **भाषण पर इंटरप्ट** (डिफ़ॉल्ट चालू): यदि सहायक बोलते समय उपयोगकर्ता बोलना शुरू करता है, तो हम प्लेबैक रोक देते हैं और अगले प्रॉम्प्ट के लिए इंटरप्शन टाइमस्टैम्प नोट करते हैं।

## उत्तरों में वॉइस निर्देश

सहायक वॉइस को नियंत्रित करने के लिए अपने उत्तर की शुरुआत में **एकल JSON पंक्ति** जोड़ सकता है:

```json
{ "voice": "<voice-id>", "once": true }
```

नियम:

- केवल पहली गैर-खाली पंक्ति।
- अज्ञात कुंजियाँ अनदेखी की जाती हैं।
- `once: true` केवल वर्तमान उत्तर पर लागू होता है।
- `once` के बिना, वॉइस Talk मोड के लिए नया डिफ़ॉल्ट बन जाता है।
- JSON पंक्ति TTS प्लेबैक से पहले हटा दी जाती है।

समर्थित कुंजियाँ:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## विन्यास (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

डिफ़ॉल्ट्स:

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` पर फ़ॉलबैक (या API कुंजी उपलब्ध होने पर पहला ElevenLabs वॉइस)
- `modelId`: अनसेट होने पर `eleven_v3` पर डिफ़ॉल्ट
- `apiKey`: `ELEVENLABS_API_KEY` पर फ़ॉलबैक (या उपलब्ध होने पर gateway शेल प्रोफ़ाइल)
- `outputFormat`: macOS/iOS पर `pcm_44100` और Android पर `pcm_24000` पर डिफ़ॉल्ट (MP3 स्ट्रीमिंग को मजबूर करने के लिए `mp3_*` सेट करें)

## macOS UI

- मेनू बार टॉगल: **Talk**
- कॉन्फ़िग टैब: **Talk Mode** समूह (वॉइस आईडी + इंटरप्ट टॉगल)
- ओवरले:
  - **Listening**: माइक्रोफ़ोन स्तर के साथ क्लाउड पल्स
  - **Thinking**: डूबती हुई एनीमेशन
  - **Speaking**: फैलते हुए रिंग्स
  - क्लाउड पर क्लिक: बोलना रोकें
  - X पर क्लिक: Talk मोड से बाहर निकलें

## नोट्स

- Speech + Microphone अनुमतियों की आवश्यकता है।
- सत्र कुंजी `main` के विरुद्ध `chat.send` का उपयोग करता है।
- TTS कम विलंबता के लिए macOS/iOS/Android पर `ELEVENLABS_API_KEY` और इन्क्रिमेंटल प्लेबैक के साथ ElevenLabs स्ट्रीमिंग API का उपयोग करता है।
- `eleven_v3` के लिए `stability` को `0.0`, `0.5`, या `1.0` तक मान्य किया जाता है; अन्य मॉडल `0..1` स्वीकार करते हैं।
- `latency_tier` सेट होने पर `0..4` तक मान्य किया जाता है।
- Android कम विलंबता AudioTrack स्ट्रीमिंग के लिए `pcm_16000`, `pcm_22050`, `pcm_24000`, और `pcm_44100` आउटपुट फ़ॉर्मैट्स का समर्थन करता है।
