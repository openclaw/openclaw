---
summary: "SOUL Evil hook (สลับ SOUL.md กับ SOUL_EVIL.md)"
read_when:
  - คุณต้องการเปิดใช้งานหรือปรับแต่ง SOUL Evil hook
  - คุณต้องการช่วงเวลา purge หรือการสลับ persona แบบสุ่ม
title: "SOUL Evil Hook"
---

# SOUL Evil Hook

SOUL Evil hook จะสลับเนื้อหา `SOUL.md` ที่ถูก **inject** กับ `SOUL_EVIL.md` ระหว่าง
ช่วงเวลา purge หรือด้วยโอกาสแบบสุ่ม โดยจะ **ไม่** แก้ไขไฟล์บนดิสก์ มัน **ไม่** แก้ไขไฟล์บนดิสก์

## ทำงานอย่างไร

เมื่อ `agent:bootstrap` ทำงาน hook สามารถแทนที่เนื้อหา `SOUL.md` ในหน่วยความจำ
ก่อนที่จะประกอบ system prompt หาก `SOUL_EVIL.md` หายไปหรือว่างเปล่า
OpenClaw จะบันทึกคำเตือนและคงใช้ `SOUL.md` ตามปกติ หาก `SOUL_EVIL.md` หายไปหรือว่างเปล่า
OpenClaw จะบันทึกคำเตือนและคงใช้ `SOUL.md` ตามปกติ

การรัน sub-agent จะ **ไม่** รวม `SOUL.md` ในไฟล์ bootstrap ดังนั้น hook นี้
จึงไม่มีผลกับ sub-agent

## เปิดใช้งาน

```bash
openclaw hooks enable soul-evil
```

จากนั้นตั้งค่า config:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

สร้าง `SOUL_EVIL.md` ในรากเวิร์กสเปซของเอเจนต์ (ถัดจาก `SOUL.md`)

## ตัวเลือก

- `file` (string): ชื่อไฟล์ SOUL ทางเลือก (ค่าเริ่มต้น: `SOUL_EVIL.md`)
- `chance` (number 0–1): โอกาสแบบสุ่มต่อการรันเพื่อใช้ `SOUL_EVIL.md`
- `purge.at` (HH:mm): เวลาเริ่ม purge รายวัน (รูปแบบ 24 ชั่วโมง)
- `purge.duration` (duration): ความยาวของช่วงเวลา (เช่น `30s`, `10m`, `1h`)

**ลำดับความสำคัญ:** ช่วงเวลา purge มีผลเหนือกว่าค่าโอกาสสุ่ม

**โซนเวลา:** ใช้ `agents.defaults.userTimezone` เมื่อมีการตั้งค่า มิฉะนั้นจะใช้โซนเวลาของโฮสต์

## หมายเหตุ

- ไม่มีการเขียนหรือแก้ไขไฟล์ใดๆ บนดิสก์
- หาก `SOUL.md` ไม่อยู่ในรายการ bootstrap hook จะไม่ทำอะไร

## ดูเพิ่มเติม

- [Hooks](/automation/hooks)
