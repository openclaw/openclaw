---
summary: "ملحق المكالمات الصوتية: مكالمات صادرة وواردة عبر Twilio/Telnyx/Plivo (تثبيت الملحق + التهيئة + CLI)"
read_when:
  - تريد إجراء مكالمة صوتية صادرة من OpenClaw
  - تقوم بتهيئة أو تطوير ملحق المكالمات الصوتية
title: "ملحق المكالمات الصوتية"
---

# المكالمات الصوتية (ملحق)

مكالمات صوتية لـ OpenClaw عبر ملحق. يدعم الإشعارات الصادرة والمحادثات متعددة الأدوار مع سياسات المكالمات الواردة.

الموفّرون الحاليون:

- `twilio` (الصوت القابل للبرمجة + تدفقات الوسائط)
- `telnyx` (التحكم بالمكالمات v2)
- `plivo` (واجهة برمجة الصوت + نقل XML + إدخال الكلام GetInput)
- `mock` (تطوير/بدون شبكة)

نموذج ذهني سريع:

- تثبيت الملحق
- إعادة تشغيل Gateway
- التهيئة ضمن `plugins.entries.voice-call.config`
- الاستخدام عبر `openclaw voicecall ...` أو أداة `voice_call`

## أين يعمل (محلي مقابل بعيد)

يعمل ملحق المكالمات الصوتية **داخل عملية Gateway**.

إذا كنت تستخدم Gateway بعيدًا، فقم بتثبيت/تهيئة الملحق على **الجهاز الذي يشغّل Gateway**، ثم أعد تشغيل Gateway لتحميله.

## التثبيت

### الخيار A: التثبيت من npm (موصى به)

```bash
openclaw plugins install @openclaw/voice-call
```

أعد تشغيل Gateway بعد ذلك.

### الخيار B: التثبيت من مجلد محلي (تطوير، بدون نسخ)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

أعد تشغيل Gateway بعد ذلك.

## التهيئة

اضبط التهيئة ضمن `plugins.entries.voice-call.config`:

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

ملاحظات:

- يتطلب Twilio/Telnyx عنوان URL لخطاف ويب **قابل للوصول علنًا**.
- يتطلب Plivo عنوان URL لخطاف ويب **قابل للوصول علنًا**.
- `mock` هو موفّر تطوير محلي (بدون مكالمات شبكة).
- `skipSignatureVerification` مخصّص للاختبار المحلي فقط.
- إذا استخدمت فئة ngrok المجانية، فاضبط `publicUrl` على عنوان ngrok الدقيق؛ يتم دائمًا فرض التحقق من التوقيع.
- يسمح `tunnel.allowNgrokFreeTierLoopbackBypass: true` بخطافات ويب Twilio ذات التواقيع غير الصالحة **فقط** عندما يكون `tunnel.provider="ngrok"` و `serve.bind` حلقة رجوع (وكيل ngrok المحلي). استخدمه للتطوير المحلي فقط.
- قد تتغير عناوين ngrok في الفئة المجانية أو تضيف سلوكيات وسيطة؛ إذا انحرف `publicUrl` فستفشل تواقيع Twilio. للإنتاج، فضّل نطاقًا ثابتًا أو نفق Tailscale.

## أمان خطافات الويب

عندما يكون هناك وكيل أو نفق أمام Gateway، يعيد الملحق بناء
عنوان URL العام للتحقق من التوقيع. تتحكم هذه الخيارات في أي
ترويسات مُعاد توجيهها يتم الوثوق بها.

`webhookSecurity.allowedHosts` يضيف قائمة سماح للمضيفين من ترويسات إعادة التوجيه.

`webhookSecurity.trustForwardingHeaders` يثق بترويسات إعادة التوجيه دون قائمة سماح.

`webhookSecurity.trustedProxyIPs` يثق بترويسات إعادة التوجيه فقط عندما يطابق
عنوان IP البعيد للطلب القائمة.

مثال مع مضيف عام ثابت:

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

## TTS للمكالمات

تستخدم المكالمات الصوتية تهيئة `messages.tts` الأساسية (OpenAI أو ElevenLabs) لـ
بثّ الكلام أثناء المكالمات. يمكنك تجاوزها ضمن تهيئة الملحق
بنفس **البنية** — حيث يتم الدمج العميق مع `messages.tts`.

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

ملاحظات:

- **يتم تجاهل Edge TTS للمكالمات الصوتية** (صوت الاتصالات يتطلب PCM؛ ومخرجات Edge غير موثوقة).
- يتم استخدام TTS الأساسي عند تمكين بث وسائط Twilio؛ وإلا فستعود المكالمات إلى الأصوات الأصلية لدى الموفّر.

### مزيد من الأمثلة

استخدام TTS الأساسي فقط (بدون تجاوز):

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

التجاوز إلى ElevenLabs للمكالمات فقط (مع الإبقاء على الإعداد الافتراضي الأساسي في أماكن أخرى):

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

تجاوز نموذج OpenAI فقط للمكالمات (مثال دمج عميق):

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

## المكالمات الواردة

تكون سياسة المكالمات الواردة افتراضيًا `disabled`. لتمكين المكالمات الواردة، اضبط:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

تستخدم الردود التلقائية نظام الوكيل. اضبطها عبر:

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

## أداة الوكيل

اسم الأداة: `voice_call`

الإجراءات:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

يشحن هذا المستودع مستند Skill مطابقًا في `skills/voice-call/SKILL.md`.

## استدعاء RPC لـ Gateway

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
