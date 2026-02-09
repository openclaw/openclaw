---
summary: "วิธีที่เสียง/โน้ตเสียงขาเข้าถูกดาวน์โหลด ถอดเสียง และแทรกลงในคำตอบ"
read_when:
  - การเปลี่ยนการถอดเสียงหรือการจัดการสื่อเสียง
title: "เสียงและโน้ตเสียง"
---

# เสียง / โน้ตเสียง — 2026-01-17

## สิ่งที่ทำงานได้

- **การทำความเข้าใจสื่อ(เสียง)**: หากเปิดใช้งานการทำความเข้าใจเสียง(หรือมีการตรวจจับอัตโนมัติ) OpenClaw จะ:
  1. ค้นหาไฟล์แนบเสียงรายการแรก(พาธภายในเครื่องหรือURL)และดาวน์โหลดหากจำเป็น
  2. บังคับใช้ `maxBytes` ก่อนส่งไปยังแต่ละรายการโมเดล
  3. รันรายการโมเดลที่เข้าเกณฑ์รายการแรกตามลำดับ(ผู้ให้บริการหรือCLI)
  4. หากล้มเหลวหรือข้าม(ขนาด/หมดเวลา)จะลองรายการถัดไป
  5. เมื่อสำเร็จ จะแทนที่ `Body` ด้วยบล็อก `[Audio]` และตั้งค่า `{{Transcript}}`
- **การแยกวิเคราะห์คำสั่ง**: เมื่อการถอดเสียงสำเร็จ จะตั้งค่า `CommandBody`/`RawBody` เป็นทรานสคริปต์เพื่อให้คำสั่งแบบสแลชยังคงทำงานได้
- **บันทึกล็อกแบบละเอียด**: ใน `--verbose` เราจะบันทึกเมื่อการถอดเสียงทำงานและเมื่อมีการแทนที่เนื้อหา

## การตรวจจับอัตโนมัติ(ค่าเริ่มต้น)

หากคุณ **ไม่ได้กำหนดค่าโมเดล** และ `tools.media.audio.enabled` **ไม่ได้**ถูกตั้งเป็น `false`,
OpenClaw จะตรวจจับอัตโนมัติตามลำดับนี้และหยุดเมื่อพบตัวเลือกที่ทำงานได้ตัวแรก:

1. **Local CLIs** (หากติดตั้งไว้)
   - `sherpa-onnx-offline` (ต้องใช้ `SHERPA_ONNX_MODEL_DIR` พร้อม encoder/decoder/joiner/tokens)
   - `whisper-cli` (จาก `whisper-cpp`; ใช้ `WHISPER_CPP_MODEL` หรือโมเดล tiny ที่มาพร้อมแพ็กเกจ)
   - `whisper` (Python CLI; ดาวน์โหลดโมเดลอัตโนมัติ)
2. **Gemini CLI** (`gemini`) โดยใช้ `read_many_files`
3. **คีย์ผู้ให้บริการ** (OpenAI → Groq → Deepgram → Google)

9) หากต้องการปิดการตรวจจับอัตโนมัติ ให้ตั้งค่า `tools.media.audio.enabled: false`
10) หากต้องการปรับแต่ง ให้ตั้งค่า `tools.media.audio.models`
    หากต้องการปิดการตรวจจับอัตโนมัติ ให้ตั้งค่า `tools.media.audio.enabled: false`  
    หากต้องการปรับแต่ง ให้ตั้งค่า `tools.media.audio.models`  
    หมายเหตุ: การตรวจจับไบนารีเป็นแบบพยายามอย่างดีที่สุดบน macOS/Linux/Windows; โปรดตรวจสอบว่า CLI อยู่บน `PATH`(เราจะขยาย `~`) หรือกำหนดโมเดล CLI แบบระบุพาธคำสั่งเต็ม

## ตัวอย่างคอนฟิก

### ผู้ให้บริการ + CLI สำรอง(OpenAI + Whisper CLI)

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

### ผู้ให้บริการอย่างเดียวพร้อมการจำกัดขอบเขต

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

### ผู้ให้บริการอย่างเดียว(Deepgram)

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

## หมายเหตุและข้อจำกัด

- การยืนยันตัวตนของผู้ให้บริการเป็นไปตามลำดับมาตรฐานของโมเดล(auth profiles, ตัวแปรสภาพแวดล้อม, `models.providers.*.apiKey`)
- Deepgram จะรับค่า `DEEPGRAM_API_KEY` เมื่อใช้ `provider: "deepgram"`
- รายละเอียดการตั้งค่า Deepgram: [Deepgram (audio transcription)](/providers/deepgram)
- ผู้ให้บริการเสียงสามารถแทนที่ `baseUrl`, `headers` และ `providerOptions` ผ่าน `tools.media.audio`
- ขีดจำกัดขนาดเริ่มต้นคือ 20MB (`tools.media.audio.maxBytes`). เสียงที่เกินขนาดจะถูกข้ามสำหรับโมเดลนั้นและจะลองรายการถัดไป
- 11. ค่าเริ่มต้น `maxChars` สำหรับเสียงคือ **ไม่ตั้งค่า** (ถอดความเต็ม) ค่าเริ่มต้นของ `maxChars` สำหรับเสียงคือ **unset** (ทรานสคริปต์เต็ม) ตั้งค่า `tools.media.audio.maxChars` หรือ `maxChars` รายการต่อรายการเพื่อตัดเอาต์พุต
- ค่าเริ่มต้นอัตโนมัติของ OpenAI คือ `gpt-4o-mini-transcribe`; ตั้งค่า `model: "gpt-4o-transcribe"` เพื่อความแม่นยำที่สูงขึ้น
- ใช้ `tools.media.audio.attachments` เพื่อประมวลผลโน้ตเสียงหลายรายการ (`mode: "all"` + `maxAttachments`)
- ทรานสคริปต์พร้อมใช้งานในเทมเพลตเป็น `{{Transcript}}`
- stdout ของ CLI ถูกจำกัด(5MB); ควรทำให้เอาต์พุตของ CLI กระชับ

## 12. ข้อควรระวัง

- 13. กฎของสโคปใช้แบบเจอรายการแรกเป็นผู้ชนะ กฎขอบเขตใช้หลักการจับคู่ครั้งแรกเป็นผู้ชนะ `chatType` จะถูกทำให้เป็นมาตรฐานเป็น `direct`, `group` หรือ `room`
- ตรวจสอบให้แน่ใจว่า CLI ออกจากโปรแกรมด้วยรหัส 0 และพิมพ์ข้อความล้วน; JSON จำเป็นต้องปรับผ่าน `jq -r .text`
- ตั้งค่าเวลา timeout ให้เหมาะสม (`timeoutSeconds`, ค่าเริ่มต้น 60s) เพื่อหลีกเลี่ยงการบล็อกคิวการตอบกลับ
