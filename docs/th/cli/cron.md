---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw cron` (ตั้งเวลาและรันงานเบื้องหลัง)"
read_when:
  - คุณต้องการงานตามกำหนดเวลาและการปลุกให้ทำงาน
  - คุณกำลังดีบักการทำงานของcronและบันทึกล็อก
title: "cron"
x-i18n:
  source_path: cli/cron.md
  source_hash: 09982d6dd1036a56
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:53Z
---

# `openclaw cron`

จัดการงานcronสำหรับตัวตั้งเวลาของGateway（เกตเวย์）

เกี่ยวข้อง:

- งานcron: [Cron jobs](/automation/cron-jobs)

เคล็ดลับ: รัน `openclaw cron --help` เพื่อดูชุดคำสั่งทั้งหมด

หมายเหตุ: งาน `cron add` แบบแยกเดี่ยวจะตั้งค่าเริ่มต้นเป็นการส่งมอบแบบ `--announce` ใช้ `--no-deliver` เพื่อเก็บเอาต์พุตไว้ภายใน `--deliver` ยังคงอยู่ในฐานะนามแฝงที่เลิกใช้แล้วของ `--announce`.

หมายเหตุ: งานแบบครั้งเดียว (`--at`) จะถูกลบหลังจากสำเร็จตามค่าเริ่มต้น ใช้ `--keep-after-run` เพื่อเก็บไว้

หมายเหตุ: งานที่ทำซ้ำจะใช้การหน่วงเวลาในการลองใหม่แบบเอ็กซ์โปเนนเชียลหลังเกิดข้อผิดพลาดต่อเนื่อง (30วินาที → 1นาที → 5นาที → 15นาที → 60นาที) จากนั้นจะกลับสู่ตารางเวลาปกติหลังการรันที่สำเร็จครั้งถัดไป

## การแก้ไขที่ใช้บ่อย

อัปเดตการตั้งค่าการส่งมอบโดยไม่เปลี่ยนข้อความ:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

ปิดการส่งมอบสำหรับงานแบบแยกเดี่ยว:

```bash
openclaw cron edit <job-id> --no-deliver
```

ประกาศไปยังช่องทางที่ระบุ:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
