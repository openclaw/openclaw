---
summary: "แก้ไขปัญหาการตั้งเวลาและการส่งมอบของ cron และ heartbeat"
read_when:
  - Cron ไม่ทำงาน
  - Cron ทำงานแล้วแต่ไม่มีการส่งข้อความ
  - Heartbeat ดูเหมือนเงียบหรือถูกข้าม
title: "การแก้ไขปัญหาอัตโนมัติ"
---

# การแก้ไขปัญหาอัตโนมัติ

ใช้หน้านี้สำหรับปัญหาด้านตัวตั้งเวลาและการส่งมอบ (`cron` + `heartbeat`).

## ลำดับขั้นคำสั่ง

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

จากนั้นรันการตรวจสอบระบบอัตโนมัติ:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron ไม่ทำงาน

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

เอาต์พุตที่ถูกต้องควรมีลักษณะดังนี้:

- `cron status` รายงานว่าเปิดใช้งานอยู่และมี `nextWakeAtMs` ในอนาคต
- งานถูกเปิดใช้งานและมีตารางเวลา/เขตเวลาที่ถูกต้อง
- `cron runs` แสดง `ok` หรือเหตุผลที่ข้ามอย่างชัดเจน

ลักษณะอาการที่พบบ่อย:

- `cron: scheduler disabled; jobs will not run automatically` → cron ถูกปิดใช้งานในคอนฟิก/ตัวแปรสภาพแวดล้อม
- `cron: timer tick failed` → การติ๊กของตัวตั้งเวลาล้มเหลว; ตรวจสอบสแตก/บริบทของล็อกรอบข้าง
- `reason: not-due` ในเอาต์พุตการรัน → เรียกการรันด้วยตนเองโดยไม่มี `--force` และงานยังไม่ถึงเวลา

## Cron ทำงานแล้วแต่ไม่มีการส่งมอบ

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

เอาต์พุตที่ถูกต้องควรมีลักษณะดังนี้:

- สถานะการรันคือ `ok`
- ตั้งค่าโหมด/เป้าหมายการส่งมอบสำหรับงานที่แยกเดี่ยวแล้ว
- การตรวจสอบช่องทางรายงานว่าช่องทางเป้าหมายเชื่อมต่ออยู่

ลักษณะอาการที่พบบ่อย:

- การรันสำเร็จแต่โหมดการส่งมอบเป็น `none` → ไม่คาดหวังให้มีข้อความภายนอก
- เป้าหมายการส่งมอบหายไป/ไม่ถูกต้อง (`channel`/`to`) → การรันอาจสำเร็จภายในแต่ข้ามการส่งออก
- ข้อผิดพลาดการยืนยันตัวตนของช่องทาง (`unauthorized`, `missing_scope`, `Forbidden`) → การส่งมอบถูกบล็อกโดยข้อมูลรับรอง/สิทธิ์ของช่องทาง

## Heartbeat ถูกระงับหรือถูกข้าม

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

เอาต์พุตที่ถูกต้องควรมีลักษณะดังนี้:

- เปิดใช้งาน Heartbeat และมีช่วงเวลาไม่เป็นศูนย์
- ผลลัพธ์ heartbeat ล่าสุดคือ `ran` (หรือเข้าใจเหตุผลที่ข้ามแล้ว)

ลักษณะอาการที่พบบ่อย:

- `heartbeat skipped` พร้อม `reason=quiet-hours` → อยู่นอก `activeHours`
- `requests-in-flight` → เลนหลักไม่ว่าง; heartbeat ถูกเลื่อน
- `empty-heartbeat-file` → มี `HEARTBEAT.md` อยู่แต่ไม่มีเนื้อหาที่ดำเนินการได้
- `alerts-disabled` → การตั้งค่าการมองเห็นระงับข้อความ heartbeat ขาออก

## ข้อควรระวังเรื่องเขตเวลาและ activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

กฎสั้นๆ:

- `Config path not found: agents.defaults.userTimezone` หมายถึงคีย์ไม่ได้ตั้งค่า; heartbeat จะย้อนกลับไปใช้เขตเวลาของโฮสต์ (หรือ `activeHours.timezone` หากตั้งค่าไว้)
- Cron ที่ไม่มี `--tz` จะใช้เขตเวลาของโฮสต์Gateway
- Heartbeat `activeHours` ใช้การแก้ไขเขตเวลาตามที่ตั้งค่าไว้ (`user`, `local`, หรือ IANA tz ที่ระบุชัดเจน)
- เวลาแบบ ISO ที่ไม่มีเขตเวลาจะถูกมองว่าเป็น UTC สำหรับตาราง cron `at`

ลักษณะอาการที่พบบ่อย:

- งานรันผิดเวลานาฬิกาจริงหลังจากมีการเปลี่ยนเขตเวลาของโฮสต์
- Heartbeat ถูกข้ามเสมอในช่วงเวลากลางวันของคุณเพราะ `activeHours.timezone` ไม่ถูกต้อง

เกี่ยวข้อง:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
