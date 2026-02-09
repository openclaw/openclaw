---
summary: "แฟล็กการวินิจฉัยสำหรับดีบักล็อกแบบเจาะจง"
read_when:
  - คุณต้องการดีบักล็อกแบบเจาะจงโดยไม่เพิ่มระดับการบันทึกล็อกทั่วทั้งระบบ
  - คุณต้องการเก็บล็อกเฉพาะซับซิสเต็มเพื่อการสนับสนุน
title: "แฟล็กการวินิจฉัย"
---

# แฟล็กการวินิจฉัย

แฟล็กการวินิจฉัยช่วยให้คุณเปิดใช้ดีบักล็อกแบบเจาะจงได้โดยไม่ต้องเปิดการบันทึกล็อกแบบละเอียดทุกที่ แฟล็กเป็นแบบเลือกเปิด(opt-in)และจะไม่มีผลใดๆเว้นแต่ซับซิสเต็มจะตรวจสอบแฟล็กเหล่านั้น Flags are opt-in and have no effect unless a subsystem checks them.

## ทำงานอย่างไร

- แฟล็กเป็นสตริง(ไม่สนใจตัวพิมพ์เล็กใหญ่)
- คุณสามารถเปิดใช้แฟล็กได้ในคอนฟิกหรือผ่านการแทนที่ด้วยตัวแปรสภาพแวดล้อม
- รองรับไวลด์การ์ด:
  - `telegram.*` ตรงกับ `telegram.http`
  - `*` เปิดใช้แฟล็กทั้งหมด

## เปิดใช้ผ่านคอนฟิก

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

หลายแฟล็ก:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

รีสตาร์ทGateway（เกตเวย์）หลังจากเปลี่ยนแฟล็ก

## การ override ผ่าน env (ครั้งเดียว)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

ปิดแฟล็กทั้งหมด:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## ล็อกถูกบันทึกที่ใด

แฟล็กจะปล่อยล็อกไปยังไฟล์ล็อกการวินิจฉัยมาตรฐาน โดยค่าเริ่มต้น: By default:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

If you set `logging.file`, use that path instead. หากคุณตั้งค่า `logging.file` ให้ใช้พาธนั้นแทน ล็อกเป็นรูปแบบJSONL(หนึ่งอ็อบเจ็กต์JSONต่อหนึ่งบรรทัด) การปกปิดข้อมูลยังคงถูกใช้ตาม `logging.redactSensitive`. Redaction still applies based on `logging.redactSensitive`.

## Extract logs

เลือกไฟล์ล็อกล่าสุด:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

กรองสำหรับการวินิจฉัยHTTPของTelegram:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

หรือ tail ระหว่างทำซ้ำปัญหา:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

สำหรับGateway（เกตเวย์）ระยะไกล คุณสามารถใช้ `openclaw logs --follow` ได้ด้วย(ดู [/cli/logs](/cli/logs)).

## หมายเหตุ

- หากตั้งค่า `logging.level` สูงกว่า `warn` ล็อกเหล่านี้อาจถูกระงับ ค่าเริ่มต้น `info` ใช้งานได้ Default `info` is fine.
- ปลอดภัยที่จะเปิดแฟล็กทิ้งไว้; แฟล็กมีผลเฉพาะต่อปริมาณล็อกของซับซิสเต็มที่ระบุเท่านั้น
- ใช้ [/logging](/logging) เพื่อเปลี่ยนปลายทางล็อก ระดับ และการปกปิดข้อมูล
