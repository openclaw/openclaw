---
summary: "การถอดเสียงด้วย Deepgram สำหรับโน้ตเสียงขาเข้า"
read_when:
  - คุณต้องการใช้ Deepgram แปลงเสียงเป็นข้อความสำหรับไฟล์เสียงแนบ
  - คุณต้องการตัวอย่างคอนฟิก Deepgram แบบรวดเร็ว
title: "Deepgram"
---

# Deepgram (การถอดเสียงจากเสียง)

47. Deepgram คือ API สำหรับแปลงเสียงเป็นข้อความ Deepgram เป็น API สำหรับแปลงเสียงเป็นข้อความ ใน OpenClaw จะใช้สำหรับ **การถอดเสียงไฟล์เสียง/โน้ตเสียงขาเข้า**
    ผ่าน `tools.media.audio`.

เมื่อเปิดใช้งาน OpenClaw จะอัปโหลดไฟล์เสียงไปยัง Deepgram และแทรกข้อความถอดเสียง
เข้าสู่ไปป์ไลน์การตอบกลับ (`{{Transcript}}` + บล็อก `[Audio]`). วิธีนี้ **ไม่ใช่การสตรีม**;
โดยใช้เอนด์พอยต์การถอดเสียงจากไฟล์ที่บันทึกไว้ล่วงหน้า

เว็บไซต์: [https://deepgram.com](https://deepgram.com)  
เอกสาร: [https://developers.deepgram.com](https://developers.deepgram.com)

## เริ่มต้นอย่างรวดเร็ว

1. ตั้งค่า API key ของคุณ:

```
DEEPGRAM_API_KEY=dg_...
```

2. เปิดใช้งานผู้ให้บริการ:

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

## ตัวเลือก

- `model`: รหัสโมเดล Deepgram (ค่าเริ่มต้น: `nova-3`)
- `language`: ตัวช่วยระบุภาษา (ไม่บังคับ)
- `tools.media.audio.providerOptions.deepgram.detect_language`: เปิดใช้การตรวจจับภาษา (ไม่บังคับ)
- `tools.media.audio.providerOptions.deepgram.punctuate`: เปิดใช้เครื่องหมายวรรคตอน (ไม่บังคับ)
- `tools.media.audio.providerOptions.deepgram.smart_format`: เปิดใช้การจัดรูปแบบอัจฉริยะ (ไม่บังคับ)

ตัวอย่างพร้อมภาษา:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

ตัวอย่างพร้อมตัวเลือกของ Deepgram:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## หมายเหตุ

- การยืนยันตัวตนเป็นไปตามลำดับมาตรฐานของผู้ให้บริการ; `DEEPGRAM_API_KEY` เป็นวิธีที่ง่ายที่สุด
- สามารถแทนที่เอนด์พอยต์หรือเฮดเดอร์ด้วย `tools.media.audio.baseUrl` และ `tools.media.audio.headers` เมื่อใช้งานผ่านพร็อกซี
- เอาต์พุตเป็นไปตามกฎเสียงเดียวกับผู้ให้บริการอื่นๆ(ขีดจำกัดขนาด เวลาไทม์เอาต์ และการแทรกทรานสคริปต์)
