---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw security` (ตรวจสอบและแก้ไขจุดเสี่ยงด้านความปลอดภัยที่พบบ่อย)"
read_when:
  - คุณต้องการรันการตรวจสอบความปลอดภัยอย่างรวดเร็วกับคอนฟิก/สถานะ
  - คุณต้องการนำคำแนะนำการ “แก้ไข” ที่ปลอดภัยไปใช้ (chmod, ทำให้ค่าเริ่มต้นรัดกุมขึ้น)
title: "security"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:55Z
---

# `openclaw security`

เครื่องมือด้านความปลอดภัย(การตรวจสอบ + การแก้ไขตามตัวเลือก)

เกี่ยวข้อง:

- คู่มือความปลอดภัย: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

การตรวจสอบจะเตือนเมื่อมีผู้ส่งDMหลายรายใช้เซสชันหลักร่วมกัน และแนะนำ **โหมดDMที่ปลอดภัย**: `session.dmScope="per-channel-peer"` (หรือ `per-account-channel-peer` สำหรับช่องทางแบบหลายบัญชี) สำหรับกล่องข้อความที่ใช้ร่วมกัน
นอกจากนี้ยังเตือนเมื่อใช้โมเดลขนาดเล็ก(`<=300B`)โดยไม่ใช้ sandboxing และเปิดใช้งานเครื่องมือเว็บ/เบราว์เซอร์อยู่
