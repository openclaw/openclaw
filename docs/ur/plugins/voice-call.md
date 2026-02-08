---
summary: "وائس کال پلگ اِن: Twilio/Telnyx/Plivo کے ذریعے آؤٹ باؤنڈ + اِن باؤنڈ کالز (پلگ اِن انسٹال + کنفیگ + CLI)"
read_when:
  - آپ OpenClaw سے آؤٹ باؤنڈ وائس کال کرنا چاہتے ہیں
  - آپ voice-call پلگ اِن کو کنفیگر یا ڈیولپ کر رہے ہیں
title: "وائس کال پلگ اِن"
x-i18n:
  source_path: plugins/voice-call.md
  source_hash: 46d05a5912b785d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:38Z
---

# وائس کال (پلگ اِن)

OpenClaw کے لیے پلگ اِن کے ذریعے وائس کالز۔ آؤٹ باؤنڈ نوٹیفکیشنز اور اِن باؤنڈ پالیسیز کے ساتھ ملٹی ٹرن گفتگو کی سپورٹ فراہم کرتا ہے۔

موجودہ فراہم کنندگان:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

فوری ذہنی ماڈل:

- پلگ اِن انسٹال کریں
- Gateway ری اسٹارٹ کریں
- `plugins.entries.voice-call.config` کے تحت کنفیگر کریں
- `openclaw voicecall ...` یا `voice_call` اوزار استعمال کریں

## یہ کہاں چلتا ہے (لوکل بمقابلہ ریموٹ)

وائس کال پلگ اِن **Gateway پروسس کے اندر** چلتا ہے۔

اگر آپ ریموٹ Gateway استعمال کرتے ہیں تو پلگ اِن کو **اس مشین پر انسٹال/کنفیگر کریں جہاں Gateway چل رہا ہو**، پھر Gateway کو ری اسٹارٹ کریں تاکہ یہ لوڈ ہو جائے۔

## انسٹال

### آپشن A: npm سے انسٹال کریں (سفارش کردہ)

```bash
openclaw plugins install @openclaw/voice-call
```

اس کے بعد Gateway کو ری اسٹارٹ کریں۔

### آپشن B: لوکل فولڈر سے انسٹال کریں (ڈیولپمنٹ، بغیر کاپی)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

اس کے بعد Gateway کو ری اسٹارٹ کریں۔

## کنفیگ

کنفیگ کو `plugins.entries.voice-call.config` کے تحت سیٹ کریں:

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

نوٹس:

- Twilio/Telnyx کے لیے **عوامی طور پر قابلِ رسائی** ویب ہوک URL درکار ہے۔
- Plivo کے لیے **عوامی طور پر قابلِ رسائی** ویب ہوک URL درکار ہے۔
- `mock` ایک لوکل ڈیولپمنٹ فراہم کنندہ ہے (کوئی نیٹ ورک کالز نہیں)۔
- `skipSignatureVerification` صرف لوکل ٹیسٹنگ کے لیے ہے۔
- اگر آپ ngrok فری ٹیر استعمال کرتے ہیں تو `publicUrl` کو عین ngrok URL پر سیٹ کریں؛ دستخط کی توثیق ہمیشہ نافذ رہتی ہے۔
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` Twilio ویب ہوکس کو **صرف** اس صورت میں غلط دستخط کے ساتھ اجازت دیتا ہے جب `tunnel.provider="ngrok"` اور `serve.bind` لوپ بیک ہو (ngrok لوکل ایجنٹ)۔ صرف لوکل ڈیولپمنٹ کے لیے استعمال کریں۔
- Ngrok فری ٹیر URLs تبدیل ہو سکتے ہیں یا انٹر اسٹی شیئل رویہ شامل کر سکتے ہیں؛ اگر `publicUrl` میں فرق آ جائے تو Twilio کے دستخط ناکام ہو جائیں گے۔ پروڈکشن کے لیے مستحکم ڈومین یا Tailscale funnel کو ترجیح دیں۔

## ویب ہوک سکیورٹی

جب Gateway کے سامنے کوئی پراکسی یا سرنگ ہو تو پلگ اِن دستخط کی توثیق کے لیے عوامی URL کو دوبارہ تشکیل دیتا ہے۔ یہ اختیارات اس بات کو کنٹرول کرتے ہیں کہ کون سے فارورڈڈ ہیڈرز پر بھروسا کیا جائے۔

`webhookSecurity.allowedHosts` فارورڈنگ ہیڈرز سے ہوسٹس کی اجازت فہرست بناتا ہے۔

`webhookSecurity.trustForwardingHeaders` اجازت فہرست کے بغیر فارورڈڈ ہیڈرز پر بھروسا کرتا ہے۔

`webhookSecurity.trustedProxyIPs` صرف اس وقت فارورڈڈ ہیڈرز پر بھروسا کرتا ہے جب ریکویسٹ کا ریموٹ IP فہرست سے میچ کرے۔

ایک مستحکم عوامی ہوسٹ کے ساتھ مثال:

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

## کالز کے لیے TTS

وائس کال، کالز پر اسٹریمنگ اسپیچ کے لیے بنیادی `messages.tts` کنفیگریشن (OpenAI یا ElevenLabs) استعمال کرتا ہے۔ آپ پلگ اِن کنفیگ کے تحت **اسی ساخت** کے ساتھ اسے اووررائیڈ کر سکتے ہیں — یہ `messages.tts` کے ساتھ ڈیپ‑مرج ہو جاتا ہے۔

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

نوٹس:

- **وائس کالز کے لیے Edge TTS کو نظرانداز کیا جاتا ہے** (ٹیلی فونی آڈیو کے لیے PCM درکار ہوتا ہے؛ Edge آؤٹ پٹ غیر معتبر ہے)۔
- جب Twilio میڈیا اسٹریمنگ فعال ہو تو بنیادی TTS استعمال ہوتا ہے؛ بصورتِ دیگر کالز فراہم کنندہ کی مقامی آوازوں پر واپس آ جاتی ہیں۔

### مزید مثالیں

صرف بنیادی TTS استعمال کریں (کوئی اووررائیڈ نہیں):

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

صرف کالز کے لیے ElevenLabs پر اووررائیڈ کریں (دیگر جگہوں پر بنیادی ڈیفالٹ برقرار رکھیں):

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

صرف کالز کے لیے OpenAI ماڈل اووررائیڈ کریں (ڈیپ‑مرج مثال):

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

## اِن باؤنڈ کالز

اِن باؤنڈ پالیسی بطورِ طے شدہ `disabled` ہے۔ اِن باؤنڈ کالز فعال کرنے کے لیے سیٹ کریں:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

خودکار جوابات ایجنٹ سسٹم استعمال کرتے ہیں۔ درج ذیل کے ذریعے ٹیون کریں:

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

## ایجنٹ اوزار

اوزار کا نام: `voice_call`

کارروائیاں:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

یہ ریپو `skills/voice-call/SKILL.md` پر ایک ہم آہنگ skill دستاویز فراہم کرتا ہے۔

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
