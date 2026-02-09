---
summary: "ปลั๊กอิน Voice Call: โทรออกและรับสายผ่าน Twilio/Telnyx/Plivo (ติดตั้งปลั๊กอิน + คอนฟิก + CLI)"
read_when:
  - คุณต้องการโทรออกด้วยเสียงจาก OpenClaw
  - คุณกำลังกำหนดค่าหรือพัฒนาปลั๊กอิน voice-call
title: "ปลั๊กอิน Voice Call"
---

# Voice Call (ปลั๊กอิน)

การโทรด้วยเสียงสำหรับ OpenClaw ผ่านปลั๊กอิน รองรับการแจ้งเตือนโทรออกและ
การสนทนาแบบหลายเทิร์นพร้อมนโยบายสำหรับสายเรียกเข้า 15. รองรับการแจ้งเตือนขาออกและ
การสนทนาแบบหลายเทิร์นพร้อมนโยบายขาเข้า

ผู้ให้บริการปัจจุบัน:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/ไม่มีเครือข่าย)

โมเดลความเข้าใจแบบย่อ:

- ติดตั้งปลั๊กอิน
- รีสตาร์ทGateway
- กำหนดค่าภายใต้ `plugins.entries.voice-call.config`
- ใช้ `openclaw voicecall ...` หรือเครื่องมือ `voice_call`

## รันที่ไหน (ภายในเครื่อง vs ระยะไกล)

ปลั๊กอิน Voice Call รัน **ภายในโปรเซสของGateway**

หากคุณใช้Gatewayระยะไกล ให้ติดตั้ง/กำหนดค่าปลั๊กอินบน **เครื่องที่รันGateway** จากนั้นรีสตาร์ทGatewayเพื่อโหลดปลั๊กอิน

## ติดตั้ง

### ตัวเลือก A: ติดตั้งจาก npm (แนะนำ)

```bash
openclaw plugins install @openclaw/voice-call
```

จากนั้นรีสตาร์ทGateway

### ตัวเลือก B: ติดตั้งจากโฟลเดอร์ภายในเครื่อง (dev, ไม่ต้องคัดลอก)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

จากนั้นรีสตาร์ทGateway

## คอนฟิก

ตั้งค่าคอนฟิกภายใต้ `plugins.entries.voice-call.config`:

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

หมายเหตุ:

- Twilio/Telnyx ต้องการ URL webhook ที่ **เข้าถึงได้สาธารณะ**
- Plivo ต้องการ URL webhook ที่ **เข้าถึงได้สาธารณะ**
- `mock` เป็นผู้ให้บริการสำหรับ dev ภายในเครื่อง (ไม่มีการเรียกเครือข่าย)
- `skipSignatureVerification` ใช้สำหรับการทดสอบภายในเครื่องเท่านั้น
- หากใช้ ngrok ระดับฟรี ให้ตั้งค่า `publicUrl` เป็น URL ngrok ที่ตรงกันทุกประการ; การตรวจสอบลายเซ็นจะถูกบังคับเสมอ
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` อนุญาต webhook ของ Twilio ที่มีลายเซ็นไม่ถูกต้อง **เฉพาะเมื่อ** `tunnel.provider="ngrok"` และ `serve.bind` เป็น loopback (ngrok local agent) ใช้สำหรับ dev ภายในเครื่องเท่านั้น 16. ใช้สำหรับการพัฒนาในเครื่องเท่านั้น
- URL ของ ngrok ระดับฟรีอาจเปลี่ยนหรือเพิ่มพฤติกรรมคั่นกลาง; หาก `publicUrl` เปลี่ยน Twilio signature จะล้มเหลว สำหรับโปรดักชัน แนะนำโดเมนที่เสถียรหรือ Tailscale funnel 17. สำหรับการใช้งานจริง แนะนำให้ใช้โดเมนที่เสถียรหรือ Tailscale funnel

## ความปลอดภัยของ Webhook

เมื่อมีพร็อกซีหรืออุโมงค์อยู่หน้่าGateway ปลั๊กอินจะสร้าง
URL สาธารณะใหม่เพื่อใช้ตรวจสอบลายเซ็น ตัวเลือกเหล่านี้ควบคุมว่าจะเชื่อถือ
header ที่ถูกส่งต่อใดบ้าง 18. ตัวเลือกเหล่านี้ควบคุมว่า
เฮดเดอร์ที่ถูกฟอร์เวิร์ดใดบ้างที่เชื่อถือได้

`webhookSecurity.allowedHosts` ทำ allowlist โฮสต์จาก forwarding headers

`webhookSecurity.trustForwardingHeaders` เชื่อถือ forwarding headers โดยไม่ต้องมี allowlist

`webhookSecurity.trustedProxyIPs` เชื่อถือ forwarding headers เฉพาะเมื่อ
IP ระยะไกลของคำขอตรงกับรายการ

ตัวอย่างกับโฮสต์สาธารณะที่เสถียร:

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

## TTS สำหรับการโทร

Voice Call ใช้คอนฟิก `messages.tts` หลัก (OpenAI หรือ ElevenLabs) สำหรับ
การสตรีมเสียงพูดระหว่างการโทร คุณสามารถ override ใต้คอนฟิกของปลั๊กอินด้วย
**โครงสร้างเดียวกัน** — โดยจะ deep‑merge กับ `messages.tts` 19. คุณสามารถ override ได้ภายใต้การตั้งค่าปลั๊กอินด้วย
**โครงสร้างเดียวกัน** — โดยจะทำการ deep‑merge กับ `messages.tts`

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

หมายเหตุ:

- **Edge TTS จะถูกละเว้นสำหรับการโทรด้วยเสียง** (เสียงโทรศัพท์ต้องเป็น PCM; เอาต์พุตของ Edge ไม่เสถียร)
- จะใช้ TTS หลักเมื่อเปิดใช้งาน Twilio media streaming; มิฉะนั้นการโทรจะใช้เสียงของผู้ให้บริการโดยตรง

### ตัวอย่างเพิ่มเติม

ใช้เฉพาะ TTS หลัก (ไม่ override):

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

Override เป็น ElevenLabs เฉพาะสำหรับการโทร (คงค่าเริ่มต้นหลักไว้ที่อื่น):

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

Override เฉพาะโมเดล OpenAI สำหรับการโทร (ตัวอย่าง deep‑merge):

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

## สายเรียกเข้า

นโยบายสายเรียกเข้าเริ่มต้นเป็น `disabled` หากต้องการเปิดใช้งานสายเรียกเข้า ให้ตั้งค่า: 20. หากต้องการเปิดใช้การเรียกขาเข้า ให้ตั้งค่า:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

การตอบกลับอัตโนมัติใช้ระบบเอเจนต์ ปรับแต่งได้ด้วย: 21. ปรับแต่งด้วย:

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

## เครื่องมือเอเจนต์

ชื่อเครื่องมือ: `voice_call`

การกระทำ:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

รีโปนี้มาพร้อมเอกสาร skill ที่สอดคล้องกันที่ `skills/voice-call/SKILL.md`

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
