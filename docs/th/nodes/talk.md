---
summary: "โหมดTalk: การสนทนาด้วยเสียงอย่างต่อเนื่องพร้อม ElevenLabs TTS"
read_when:
  - การนำโหมดTalkไปใช้งานบน macOS/iOS/Android
  - การเปลี่ยนพฤติกรรมเสียง/TTS/การขัดจังหวะ
title: "โหมดTalk"
---

# โหมดTalk

โหมดTalkคือวงจรการสนทนาด้วยเสียงอย่างต่อเนื่อง:

1. ฟังเสียงพูด
2. ส่งถอดเสียงไปยังโมเดล (เซสชันหลัก, chat.send)
3. รอการตอบกลับ
4. พูดออกเสียงผ่าน ElevenLabs (การเล่นแบบสตรีม)

## พฤติกรรม (macOS)

- **โอเวอร์เลย์เปิดตลอด** ขณะที่เปิดใช้งานโหมดTalk
- การเปลี่ยนสถานะระหว่าง **Listening → Thinking → Speaking**
- เมื่อมี **การหยุดสั้นๆ** (ช่วงเงียบ) ระบบจะส่งถอดเสียงปัจจุบัน
- คำตอบจะ **ถูกเขียนไปยัง WebChat** (เช่นเดียวกับการพิมพ์)
- **ขัดจังหวะเมื่อมีเสียงพูด** (เปิดเป็นค่าเริ่มต้น): หากผู้ใช้เริ่มพูดขณะผู้ช่วยกำลังพูด ระบบจะหยุดการเล่นและบันทึกเวลาที่ถูกขัดจังหวะสำหรับพรอมป์ถัดไป

## คำสั่งเสียงในคำตอบ

ผู้ช่วยอาจใส่คำนำหน้าคำตอบด้วย **บรรทัด JSON เดียว** เพื่อควบคุมเสียง:

```json
{ "voice": "<voice-id>", "once": true }
```

กฎ:

- ใช้เฉพาะบรรทัดแรกที่ไม่ว่าง
- คีย์ที่ไม่รู้จักจะถูกละเว้น
- `once: true` ใช้กับคำตอบปัจจุบันเท่านั้น
- หากไม่มี `once` เสียงนั้นจะกลายเป็นค่าเริ่มต้นใหม่ของโหมดTalk
- บรรทัด JSON จะถูกตัดออกก่อนการเล่น TTS

คีย์ที่รองรับ:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## คอนฟิก (`~/.openclaw/openclaw.json`)

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

ค่าเริ่มต้น:

- `interruptOnSpeech`: true
- `voiceId`: ถอยกลับไปใช้ `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (หรือเสียง ElevenLabs ตัวแรกเมื่อมีคีย์ API)
- `modelId`: ค่าเริ่มต้นเป็น `eleven_v3` เมื่อไม่ตั้งค่า
- `apiKey`: ถอยกลับไปใช้ `ELEVENLABS_API_KEY` (หรือโปรไฟล์เชลล์ของGatewayหากมี)
- `outputFormat`: ค่าเริ่มต้นเป็น `pcm_44100` บน macOS/iOS และ `pcm_24000` บน Android (ตั้งค่า `mp3_*` เพื่อบังคับสตรีม MP3)

## UI บน macOS

- สวิตช์เมนูบาร์: **Talk**
- แท็บคอนฟิก: กลุ่ม **Talk Mode** (voice id + สวิตช์การขัดจังหวะ)
- โอเวอร์เลย์:
  - **Listening**: เมฆเต้นตามระดับไมค์
  - **Thinking**: แอนิเมชันจมลง
  - **Speaking**: วงแหวนแผ่ออก
  - คลิกเมฆ: หยุดการพูด
  - คลิก X: ออกจากโหมดTalk

## หมายเหตุ

- ต้องการสิทธิ์ Speech และ Microphone
- ใช้ `chat.send` กับคีย์เซสชัน `main`
- TTS ใช้ ElevenLabs streaming API พร้อม `ELEVENLABS_API_KEY` และการเล่นแบบเพิ่มทีละส่วนบน macOS/iOS/Android เพื่อลดความหน่วง
- `stability` สำหรับ `eleven_v3` จะถูกตรวจสอบให้เป็น `0.0`, `0.5`, หรือ `1.0`; โมเดลอื่นยอมรับ `0..1`
- `latency_tier` จะถูกตรวจสอบให้เป็น `0..4` เมื่อมีการตั้งค่า
- Android รองรับรูปแบบเอาต์พุต `pcm_16000`, `pcm_22050`, `pcm_24000`, และ `pcm_44100` สำหรับการสตรีม AudioTrack แบบหน่วงต่ำ
