---
summary: "ตรวจสอบวันหมดอายุ OAuth สำหรับผู้ให้บริการโมเดล"
read_when:
  - การตั้งค่าการตรวจสอบหรือการแจ้งเตือนวันหมดอายุของการยืนยันตัวตน
  - การทำอัตโนมัติสำหรับการตรวจสอบการรีเฟรช OAuth ของ Claude Code / Codex
title: "การตรวจสอบการยืนยันตัวตน"
---

# การตรวจสอบการยืนยันตัวตน

OpenClaw เปิดเผยสถานะสุขภาพของวันหมดอายุ OAuth ผ่าน `openclaw models status` ใช้สิ่งนี้สำหรับ
การทำอัตโนมัติและการแจ้งเตือน; สคริปต์เป็นตัวเสริมเพิ่มเติมสำหรับเวิร์กโฟลว์บนโทรศัพท์ Use that for
automation and alerting; scripts are optional extras for phone workflows.

## แนะนำ: ตรวจสอบผ่าน CLI (พกพาได้)

```bash
openclaw models status --check
```

รหัสสถานะการออก:

- `0`: ปกติ
- `1`: ข้อมูลยืนยันตัวตนหมดอายุหรือขาดหาย
- `2`: กำลังจะหมดอายุเร็วๆนี้ (ภายใน 24 ชม.)

วิธีนี้ทำงานได้กับ cron/systemd และไม่ต้องใช้สคริปต์เพิ่มเติม

## สคริปต์เสริม (งานปฏิบัติการ / เวิร์กโฟลว์บนโทรศัพท์)

These live under `scripts/` and are **optional**. สคริปต์เหล่านี้อยู่ภายใต้ `scripts/` และเป็น **ตัวเลือก** โดยสมมติว่ามีการเข้าถึง SSH ไปยัง
โฮสต์Gateway และถูกปรับแต่งสำหรับ systemd + Termux

- `scripts/claude-auth-status.sh` ปัจจุบันใช้ `openclaw models status --json` เป็น
  แหล่งข้อมูลหลัก (และจะถอยกลับไปอ่านไฟล์โดยตรงหาก CLI ใช้งานไม่ได้)
  ดังนั้นให้คง `openclaw` ไว้บน `PATH` สำหรับตัวตั้งเวลา
- `scripts/auth-monitor.sh`: เป้าหมายตัวตั้งเวลา cron/systemd; ส่งการแจ้งเตือน (ntfy หรือโทรศัพท์)
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: ตัวตั้งเวลา systemd ระดับผู้ใช้
- `scripts/claude-auth-status.sh`: ตัวตรวจสอบการยืนยันตัวตน Claude Code + OpenClaw (full/json/simple)
- `scripts/mobile-reauth.sh`: เวิร์กโฟลว์การยืนยันตัวตนใหม่แบบแนะนำผ่าน SSH
- `scripts/termux-quick-auth.sh`: วิดเจ็ตแบบแตะครั้งเดียวสำหรับสถานะ + เปิด URL การยืนยันตัวตน
- `scripts/termux-auth-widget.sh`: เวิร์กโฟลว์วิดเจ็ตแบบแนะนำครบถ้วน
- `scripts/termux-sync-widget.sh`: ซิงค์ข้อมูลยืนยันตัวตน Claude Code → OpenClaw

หากไม่ต้องการการทำอัตโนมัติบนโทรศัพท์หรือ ตัวตั้งเวลา systemd สามารถข้ามสคริปต์เหล่านี้ได้
