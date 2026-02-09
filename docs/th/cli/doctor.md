---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw doctor` (การตรวจสุขภาพ + การซ่อมแซมแบบแนะนำ)"
read_when:
  - คุณมีปัญหาการเชื่อมต่อ/การยืนยันตัวตนและต้องการแนวทางแก้ไขแบบแนะนำ
  - คุณได้อัปเดตแล้วและต้องการตรวจสอบความถูกต้องเบื้องต้น
title: "doctor"
---

# `openclaw doctor`

การตรวจสุขภาพและการแก้ไขอย่างรวดเร็วสำหรับ Gatewayและช่องทางต่างๆ

เกี่ยวข้อง:

- การแก้ไขปัญหา: [Troubleshooting](/gateway/troubleshooting)
- การตรวจสอบความปลอดภัย: [Security](/gateway/security)

## ตัวอย่าง

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

หมายเหตุ:

- พรอมต์แบบโต้ตอบ (เช่น การแก้ไข keychain/OAuth) จะทำงานเฉพาะเมื่อ stdin เป็น TTY และไม่ได้ตั้งค่า `--non-interactive` ไว้ การรันแบบไม่มีหัว (cron, Telegram, ไม่มีเทอร์มินัล) จะข้ามพรอมต์ การรันแบบไม่มีส่วนโต้ตอบ (cron, Telegram, ไม่มีเทอร์มินัล) จะข้ามพรอมต์
- `--fix` (นามแฝงของ `--repair`) จะเขียนไฟล์สำรองไปที่ `~/.openclaw/openclaw.json.bak` และลบคีย์คอนฟิกที่ไม่รู้จัก โดยจะแสดงรายการการลบแต่ละรายการ

## macOS: การ override env ของ `launchctl`

หากคุณเคยรัน `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (หรือ `...PASSWORD`) มาก่อน ค่านั้นจะไป override ไฟล์คอนฟิกของคุณและอาจทำให้เกิดข้อผิดพลาด “unauthorized” อย่างต่อเนื่อง

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
