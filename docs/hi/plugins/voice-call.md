---
summary: "वॉइस कॉल प्लगइन: Twilio/Telnyx/Plivo के माध्यम से आउटबाउंड + इनबाउंड कॉल (प्लगइन इंस्टॉल + विन्यास + CLI)"
read_when:
  - आप OpenClaw से आउटबाउंड वॉइस कॉल करना चाहते हैं
  - आप voice-call प्लगइन को विन्यस्त या विकसित कर रहे हैं
title: "वॉइस कॉल प्लगइन"
x-i18n:
  source_path: plugins/voice-call.md
  source_hash: 46d05a5912b785d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:38Z
---

# वॉइस कॉल (प्लगइन)

OpenClaw के लिए प्लगइन के माध्यम से वॉइस कॉल। आउटबाउंड सूचनाएँ और इनबाउंड नीतियों के साथ
मल्टी-टर्न बातचीत का समर्थन करता है।

वर्तमान प्रदाता:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

त्वरित मानसिक मॉडल:

- प्लगइन इंस्टॉल करें
- Gateway (गेटवे) को पुनः आरंभ करें
- `plugins.entries.voice-call.config` के अंतर्गत विन्यास करें
- `openclaw voicecall ...` या `voice_call` टूल का उपयोग करें

## यह कहाँ चलता है (स्थानीय बनाम दूरस्थ)

वॉइस कॉल प्लगइन **Gateway प्रक्रिया के भीतर** चलता है।

यदि आप दूरस्थ Gateway का उपयोग करते हैं, तो **Gateway चलाने वाली मशीन** पर प्लगइन को इंस्टॉल/विन्यस्त करें, फिर उसे लोड करने के लिए Gateway को पुनः आरंभ करें।

## इंस्टॉल

### विकल्प A: npm से इंस्टॉल करें (अनुशंसित)

```bash
openclaw plugins install @openclaw/voice-call
```

इसके बाद Gateway को पुनः आरंभ करें।

### विकल्प B: स्थानीय फ़ोल्डर से इंस्टॉल करें (dev, बिना कॉपी)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

इसके बाद Gateway को पुनः आरंभ करें।

## विन्यास

`plugins.entries.voice-call.config` के अंतर्गत विन्यास सेट करें:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

टिप्पणियाँ:

- Twilio/Telnyx के लिए **सार्वजनिक रूप से पहुँचा जा सकने वाला** webhook URL आवश्यक है।
- Plivo के लिए **सार्वजनिक रूप से पहुँचा जा सकने वाला** webhook URL आवश्यक है।
- `mock` एक स्थानीय dev प्रदाता है (कोई नेटवर्क कॉल नहीं)।
- `skipSignatureVerification` केवल स्थानीय परीक्षण के लिए है।
- यदि आप ngrok फ्री टियर का उपयोग करते हैं, तो `publicUrl` को सटीक ngrok URL पर सेट करें; सिग्नेचर सत्यापन हमेशा लागू रहता है।
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` केवल तब Twilio webhooks को अमान्य सिग्नेचर के साथ अनुमति देता है जब `tunnel.provider="ngrok"` और `serve.bind` loopback (ngrok स्थानीय एजेंट) हों। केवल स्थानीय dev के लिए उपयोग करें।
- Ngrok फ्री टियर URL बदल सकते हैं या इंटरस्टिशियल व्यवहार जोड़ सकते हैं; यदि `publicUrl` में विचलन होता है, तो Twilio सिग्नेचर विफल हो जाएँगे। उत्पादन के लिए, स्थिर डोमेन या Tailscale फ़नल को प्राथमिकता दें।

## Webhook सुरक्षा

जब Gateway के सामने कोई प्रॉक्सी या टनल होती है, तो प्लगइन
सिग्नेचर सत्यापन के लिए सार्वजनिक URL का पुनर्निर्माण करता है। ये विकल्प नियंत्रित करते हैं कि
कौन से फ़ॉरवर्डेड हेडर भरोसेमंद हैं।

`webhookSecurity.allowedHosts` फ़ॉरवर्डिंग हेडर्स से होस्ट्स को allowlist करता है।

`webhookSecurity.trustForwardingHeaders` allowlist के बिना फ़ॉरवर्डेड हेडर्स पर भरोसा करता है।

`webhookSecurity.trustedProxyIPs` केवल तब फ़ॉरवर्डेड हेडर्स पर भरोसा करता है जब अनुरोध
का remote IP सूची से मेल खाता हो।

स्थिर सार्वजनिक होस्ट के साथ उदाहरण:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## कॉल के लिए TTS

वॉइस कॉल कॉल्स पर स्ट्रीमिंग स्पीच के लिए कोर `messages.tts` विन्यास (OpenAI या ElevenLabs) का उपयोग करता है। आप इसे प्लगइन विन्यास के अंतर्गत **उसी संरचना** के साथ ओवरराइड कर सकते हैं — यह `messages.tts` के साथ डीप‑मर्ज होता है।

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

टिप्पणियाँ:

- **वॉइस कॉल्स के लिए Edge TTS को अनदेखा किया जाता है** (टेलीफोनी ऑडियो को PCM चाहिए; Edge आउटपुट अविश्वसनीय है)।
- जब Twilio मीडिया स्ट्रीमिंग सक्षम होती है, तब कोर TTS उपयोग होता है; अन्यथा कॉल्स प्रदाता की मूल आवाज़ों पर वापस चली जाती हैं।

### और उदाहरण

केवल कोर TTS का उपयोग करें (कोई ओवरराइड नहीं):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

केवल कॉल्स के लिए ElevenLabs पर ओवरराइड करें (अन्यत्र कोर डिफ़ॉल्ट रखें):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

केवल कॉल्स के लिए OpenAI मॉडल को ओवरराइड करें (डीप‑मर्ज उदाहरण):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## इनबाउंड कॉल्स

इनबाउंड नीति डिफ़ॉल्ट रूप से `disabled` है। इनबाउंड कॉल्स सक्षम करने के लिए, सेट करें:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

ऑटो‑रिस्पॉन्स एजेंट सिस्टम का उपयोग करते हैं। इन्हें ट्यून करें:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## एजेंट टूल

टूल नाम: `voice_call`

क्रियाएँ:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

यह रिपॉज़िटरी `skills/voice-call/SKILL.md` पर एक मेल खाता Skill दस्तावेज़ प्रदान करती है।

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
