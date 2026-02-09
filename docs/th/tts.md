---
summary: "แปลงข้อความเป็นเสียง(TTS)สำหรับการตอบกลับขาออก"
read_when:
  - การเปิดใช้งานแปลงข้อความเป็นเสียงสำหรับการตอบกลับ
  - การกำหนดค่าผู้ให้บริการTTSหรือข้อจำกัด
  - การใช้งานคำสั่ง/tts
title: "แปลงข้อความเป็นเสียง"
---

# แปลงข้อความเป็นเสียง(TTS)

OpenClawสามารถแปลงการตอบกลับขาออกเป็นเสียงโดยใช้ ElevenLabs, OpenAI หรือ Edge TTS
ใช้งานได้ทุกที่ที่ OpenClawสามารถส่งเสียงได้; Telegramจะแสดงเป็นบับเบิลโน้ตเสียงทรงกลม
It works anywhere OpenClaw can send audio; Telegram gets a round voice-note bubble.

## บริการที่รองรับ

- **ElevenLabs** (ผู้ให้บริการหลักหรือสำรอง)
- **OpenAI** (ผู้ให้บริการหลักหรือสำรอง; ใช้สำหรับสรุปด้วย)
- **Edge TTS** (ผู้ให้บริการหลักหรือสำรอง; ใช้ `node-edge-tts`, ค่าเริ่มต้นเมื่อไม่มีAPI key)

### หมายเหตุเกี่ยวกับEdge TTS

Edge TTSใช้บริการTTSแบบโครงข่ายประสาทออนไลน์ของMicrosoft Edgeผ่านไลบรารี
`node-edge-tts`
เป็นบริการที่โฮสต์ไว้(ไม่ใช่ในเครื่อง), ใช้เอนด์พอยต์ของMicrosoft และ
ไม่ต้องใช้API key `node-edge-tts`เปิดเผยตัวเลือกการกำหนดค่าการพูดและ
รูปแบบเอาต์พุต แต่ไม่ใช่ทุกตัวเลือกที่Edgeรองรับ citeturn2search0 It's a hosted service (not local), uses Microsoft’s endpoints, and does
not require an API key. `node-edge-tts` exposes speech configuration options and
output formats, but not all options are supported by the Edge service. citeturn2search0

เนื่องจาก Edge TTS เป็นบริการเว็บสาธารณะโดยไม่มี SLA หรือโควตาที่เผยแพร่ไว้ จึงควรใช้งานแบบ best‑effort หากต้องการขีดจำกัดและการสนับสนุนที่รับประกัน ให้ใช้ OpenAI หรือ ElevenLabs
เนื่องจากEdge TTSเป็นบริการเว็บสาธารณะโดยไม่มีSLAหรือโควตาที่ประกาศไว้ ให้ถือว่าเป็นแบบbest‑effort หากต้องการขีดจำกัดและการสนับสนุนที่รับประกัน ให้ใช้OpenAIหรือElevenLabs
เอกสารMicrosoft Speech REST APIระบุขีดจำกัดเสียง10นาทีต่อคำขอ; Edge TTSไม่เผยแพร่ขีดจำกัด จึงควรสมมติว่ามีขีดจำกัดใกล้เคียงหรือต่ำกว่า citeturn0search3 citeturn0search3

## คีย์ไม่บังคับ

หากต้องการใช้OpenAIหรือElevenLabs:

- `ELEVENLABS_API_KEY` (หรือ `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **ไม่** จำเป็นต้องใช้ API key Edge TTS **ไม่**ต้องใช้API key หากไม่พบAPI keyใดๆ OpenClawจะใช้Edge TTSเป็นค่าเริ่มต้น
(เว้นแต่จะปิดผ่าน `messages.tts.edge.enabled=false`)

หากมีการกำหนดค่าผู้ให้บริการหลายราย ระบบจะใช้ผู้ให้บริการที่เลือกก่อน และรายอื่นจะเป็นตัวเลือกสำรอง
หากกำหนดค่าผู้ให้บริการหลายราย ระบบจะใช้ผู้ให้บริการที่เลือกก่อน และใช้รายอื่นเป็นตัวสำรอง
การสรุปอัตโนมัติใช้งานผู้ให้บริการที่กำหนดใน `summaryModel` (หรือ `agents.defaults.model.primary`)
ดังนั้นหากเปิดการสรุป ผู้ให้บริการนั้นต้องผ่านการยืนยันตัวตนด้วย

## ลิงก์บริการ

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## เปิดใช้งานเป็นค่าเริ่มต้นหรือไม่?

ไม่ Auto‑TTS ถูกตั้งค่าเป็น **ปิด** โดยค่าเริ่มต้น ไม่ การแปลงเป็นเสียงอัตโนมัติ(Auto‑TTS) **ปิด**เป็นค่าเริ่มต้น เปิดใช้งานได้ในคอนฟิกด้วย
`messages.tts.auto` หรือรายเซสชันด้วย `/tts always` (ชื่อเรียกอื่น: `/tts on`)

Edge TTS **เปิดใช้งาน**เป็นค่าเริ่มต้นเมื่อเปิดTTSแล้ว และจะถูกใช้โดยอัตโนมัติ
เมื่อไม่มีAPI keyของOpenAIหรือElevenLabs

## คอนฟิก

คอนฟิกTTSอยู่ภายใต้ `messages.tts` ใน `openclaw.json`
สคีมาฉบับเต็มอยู่ใน [Gateway configuration](/gateway/configuration)
สคีมาแบบเต็มอยู่ที่ [Gateway configuration](/gateway/configuration)

### คอนฟิกขั้นต่ำ(เปิดใช้งาน+ผู้ให้บริการ)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### ใช้OpenAIเป็นหลักและElevenLabsเป็นสำรอง

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### ใช้Edge TTSเป็นหลัก(ไม่ต้องใช้API key)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### ปิดEdge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### ขีดจำกัดแบบกำหนดเอง+พาธprefs

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### ตอบกลับด้วยเสียงเฉพาะเมื่อมีโน้ตเสียงขาเข้า

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### ปิดการสรุปอัตโนมัติสำหรับการตอบยาว

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

จากนั้นรัน:

```
/tts summary off
```

### หมายเหตุเกี่ยวกับฟิลด์

- `auto`: โหมดAuto‑TTS (`off`, `always`, `inbound`, `tagged`)
  - `inbound` ส่งเสียงเฉพาะหลังจากมีโน้ตเสียงขาเข้า
  - `tagged` ส่งเสียงเฉพาะเมื่อการตอบมีแท็ก `[[tts]]`
- `enabled`: สวิตช์แบบเดิม(doctorจะย้ายไปยัง `auto`)
- `mode`: `"final"` (ค่าเริ่มต้น) หรือ `"all"` (รวมการตอบจากเครื่องมือ/บล็อก)
- `provider`: `"elevenlabs"`, `"openai"` หรือ `"edge"` (มีfallbackอัตโนมัติ)
- หาก `provider` **ไม่ถูกตั้งค่า** OpenClawจะเลือก `openai` (ถ้ามีคีย์) จากนั้น `elevenlabs` (ถ้ามีคีย์)
  มิฉะนั้นใช้ `edge`
- `summaryModel`: โมเดลราคาประหยัดแบบไม่บังคับสำหรับการสรุปอัตโนมัติ; ค่าเริ่มต้นคือ `agents.defaults.model.primary`
  - รองรับ `provider/model` หรือชื่อเรียกโมเดลที่ตั้งค่าไว้
- `modelOverrides`: อนุญาตให้โมเดลส่งคำสั่งTTS (เปิดเป็นค่าเริ่มต้น)
- `maxTextLength`: เพดานอินพุตTTSแบบตายตัว(จำนวนอักขระ) หากเกิน `/tts audio` จะล้มเหลว `/tts audio` จะล้มเหลวหากเกินกำหนด
- `timeoutMs`: หมดเวลาคำขอ(ms)
- `prefsPath`: แทนที่พาธJSONของprefsในเครื่อง(ผู้ให้บริการ/ขีดจำกัด/สรุป)
- ค่า `apiKey` จะย้อนกลับไปใช้ตัวแปรสภาพแวดล้อม (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`)
- `elevenlabs.baseUrl`: แทนที่Base URLของAPI ElevenLabs
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0=ปกติ)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: รหัสภาษาISO 639-1แบบ2ตัวอักษร(เช่น `en`, `de`)
- `elevenlabs.seed`: จำนวนเต็ม `0..4294967295` (ความกำหนดแน่นอนแบบbest‑effort)
- `edge.enabled`: อนุญาตการใช้Edge TTS (ค่าเริ่มต้น `true`; ไม่ต้องใช้API key)
- `edge.voice`: ชื่อเสียงประสาทของEdge(เช่น `en-US-MichelleNeural`)
- `edge.lang`: โค้ดภาษา(เช่น `en-US`)
- `edge.outputFormat`: รูปแบบเอาต์พุตของEdge(เช่น `audio-24khz-48kbitrate-mono-mp3`)
  - ดูMicrosoft Speech output formatsสำหรับค่าที่ใช้ได้; ไม่ใช่ทุกฟอร์แมตที่Edgeรองรับ
- `edge.rate` / `edge.pitch` / `edge.volume`: สตริงเปอร์เซ็นต์(เช่น `+10%`, `-5%`)
- `edge.saveSubtitles`: เขียนคำบรรยายJSONควบคู่ไฟล์เสียง
- `edge.proxy`: URLพร็อกซีสำหรับคำขอEdge TTS
- `edge.timeoutMs`: แทนที่เวลาหมดคำขอ(ms)

## การแทนที่ที่ขับเคลื่อนโดยโมเดล(เปิดเป็นค่าเริ่มต้น)

ตามค่าเริ่มต้น โมเดล **สามารถ** ส่งคำสั่งTTSสำหรับการตอบครั้งเดียวได้
เมื่อ `messages.tts.auto` เป็น `tagged` คำสั่งเหล่านี้จำเป็นเพื่อทริกเกอร์เสียง
เมื่อ `messages.tts.auto` เป็น `tagged` จำเป็นต้องมีคำสั่งเหล่านี้เพื่อกระตุ้นเสียง

เมื่อเปิดใช้งาน โมเดลสามารถส่งคำสั่ง `[[tts:...]]` เพื่อแทนที่เสียงสำหรับการตอบครั้งเดียว
พร้อมบล็อก `[[tts:text]]...[[/tts:text]]` แบบไม่บังคับ เพื่อระบุแท็กการแสดงอารมณ์
(เสียงหัวเราะ สัญญาณการร้องเพลง ฯลฯ) ที่ควรปรากฏเฉพาะในเสียง

ตัวอย่างเพย์โหลดการตอบ:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

คีย์คำสั่งที่มีให้(เมื่อเปิดใช้งาน):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (เสียงOpenAI) หรือ `voiceId` (ElevenLabs)
- `model` (โมเดลTTSของOpenAIหรือidโมเดลของElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

ปิดการแทนที่ทั้งหมดจากโมเดล:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

รายการอนุญาตแบบไม่บังคับ(ปิดการแทนที่บางรายการแต่ยังเปิดแท็กไว้):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## ค่ากำหนดต่อผู้ใช้

คำสั่งแบบSlashจะเขียนการแทนที่ในเครื่องไปยัง `prefsPath` (ค่าเริ่มต้น:
`~/.openclaw/settings/tts.json`, แทนที่ด้วย `OPENCLAW_TTS_PREFS` หรือ
`messages.tts.prefsPath`)

ฟิลด์ที่จัดเก็บ:

- `enabled`
- `provider`
- `maxLength` (เกณฑ์สรุป; ค่าเริ่มต้น1500อักขระ)
- `summarize` (ค่าเริ่มต้น `true`)

ค่าพวกนี้จะเขียนทับ `messages.tts.*` สำหรับโฮสต์นั้น

## รูปแบบเอาต์พุต(คงที่)

- **Telegram**: โน้ตเสียงOpus (`opus_48000_64` จากElevenLabs, `opus` จากOpenAI)
  - 48kHz / 64kbps เป็นสมดุลที่ดีสำหรับโน้ตเสียงและจำเป็นสำหรับบับเบิลทรงกลม
- **ช่องทางอื่น**: MP3 (`mp3_44100_128` จากElevenLabs, `mp3` จากOpenAI)
  - 44.1kHz / 128kbps เป็นค่าเริ่มต้นที่สมดุลสำหรับความชัดเจนของเสียงพูด
- **Edge TTS**: ใช้ `edge.outputFormat` (ค่าเริ่มต้น `audio-24khz-48kbitrate-mono-mp3`)
  - `node-edge-tts` รองรับ `outputFormat` แต่ไม่ใช่ทุกฟอร์แมตที่มีจากบริการEdge citeturn2search0 citeturn2search0
  - ค่ารูปแบบเอาต์พุตเป็นไปตามMicrosoft Speech output formats(รวมถึงOgg/WebM Opus) citeturn1search0 citeturn1search0
  - Telegram `sendVoice` รองรับOGG/MP3/M4A; หากต้องการโน้ตเสียงOpusที่รับประกัน
    ให้ใช้OpenAI/ElevenLabs citeturn1search1 citeturn1search1
  - หากรูปแบบเอาต์พุตของEdgeที่ตั้งค่าไว้ล้มเหลว OpenClawจะลองใหม่ด้วยMP3

รูปแบบของOpenAI/ElevenLabsเป็นแบบคงที่; TelegramคาดหวังOpusเพื่อประสบการณ์โน้ตเสียง

## พฤติกรรมAuto‑TTS

เมื่อเปิดใช้งาน OpenClawจะ:

- ข้ามTTSหากการตอบมีสื่ออยู่แล้วหรือมีคำสั่ง `MEDIA:`
- ข้ามการตอบที่สั้นมาก(<10อักขระ)
- สรุปการตอบยาวเมื่อเปิดใช้งานโดยใช้ `agents.defaults.model.primary` (หรือ `summaryModel`)
- แนบเสียงที่สร้างขึ้นไปกับการตอบ

หากการตอบยาวเกิน `maxLength` และปิดการสรุป(หรือไม่มีAPI keyสำหรับโมเดลสรุป)
จะข้ามเสียงและส่งการตอบแบบข้อความตามปกติ

## ผังงาน

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## การใช้งานคำสั่งSlash

มีคำสั่งเดียวคือ: `/tts`
ดูรายละเอียดการเปิดใช้งานได้ที่ [Slash commands](/tools/slash-commands)
ดูรายละเอียดการเปิดใช้งานได้ที่ [Slash commands](/tools/slash-commands)

หมายเหตุสำหรับDiscord: `/tts` เป็นคำสั่งที่มีอยู่แล้วในDiscord ดังนั้นOpenClawจะลงทะเบียน
`/voice` เป็นคำสั่งเนทีฟแทน ข้อความ `/tts ...` ยังใช้งานได้ ข้อความ `/tts ...` ยังใช้งานได้

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

หมายเหตุ:

- คำสั่งต้องมาจากผู้ส่งที่ได้รับอนุญาต(กฎallowlist/เจ้าของยังคงใช้)
- ต้องเปิดใช้งาน `commands.text` หรือการลงทะเบียนคำสั่งเนทีฟ
- `off|always|inbound|tagged` เป็นสวิตช์ต่อเซสชัน (`/tts on` เป็นชื่อเรียกของ `/tts always`)
- `limit` และ `summary` ถูกเก็บในprefsในเครื่อง ไม่ใช่คอนฟิกหลัก
- `/tts audio` สร้างการตอบเป็นเสียงครั้งเดียว(ไม่สลับเปิดTTS)

## เครื่องมือเอเจนต์

เครื่องมือ `tts` แปลงข้อความเป็นเสียงและส่งกลับเป็นพาธ `MEDIA:` เครื่องมือ `tts` แปลงข้อความเป็นเสียงและส่งคืนพาธ `MEDIA:` เมื่อผลลัพธ์เข้ากันได้กับTelegram เครื่องมือจะใส่ `[[audio_as_voice]]` เพื่อให้Telegramส่งบับเบิลเสียง

## Gateway RPC

เมธอดของGateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
