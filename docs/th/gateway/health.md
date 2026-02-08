---
summary: "ขั้นตอนตรวจสุขภาพสำหรับการเชื่อมต่อช่องทาง"
read_when:
  - วินิจฉัยสุขภาพช่องทางWhatsApp
title: "การตรวจสุขภาพ"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:10Z
---

# การตรวจสุขภาพ(CLI)

คู่มือสั้นเพื่อยืนยันการเชื่อมต่อของช่องทางโดยไม่ต้องเดา

## การตรวจอย่างรวดเร็ว

- `openclaw status` — สรุปภายในเครื่อง: การเข้าถึง/โหมดของGateway, คำแนะนำการอัปเดต, อายุการยืนยันตัวตนของช่องทางที่ลิงก์, เซสชันและกิจกรรมล่าสุด
- `openclaw status --all` — การวินิจฉัยภายในเครื่องแบบครบถ้วน(อ่านอย่างเดียว, มีสี, ปลอดภัยสำหรับคัดลอกไปใช้ดีบัก)
- `openclaw status --deep` — ตรวจสอบGatewayที่กำลังทำงานด้วย(ตรวจแบบต่อช่องทางเมื่อรองรับ)
- `openclaw health --json` — ขอภาพรวมสุขภาพทั้งหมดจากGatewayที่กำลังทำงาน(เฉพาะWS; ไม่มีซ็อกเก็ตBaileysโดยตรง)
- ส่ง `/status` เป็นข้อความเดี่ยวในWhatsApp/WebChat เพื่อรับการตอบกลับสถานะโดยไม่เรียกเอเจนต์
- Logs: tail `/tmp/openclaw/openclaw-*.log` และกรอง `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## การวินิจฉัยเชิงลึก

- Creds บนดิสก์: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime ควรเป็นเวลาล่าสุด)
- ที่เก็บเซสชัน: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (พาธสามารถเขียนทับได้ในคอนฟิก) จำนวนและผู้รับล่าสุดจะแสดงผ่าน `status`.
- ขั้นตอนการลิงก์ใหม่: `openclaw channels logout && openclaw channels login --verbose` เมื่อพบรหัสสถานะ 409–515 หรือ `loggedOut` ใน logs (หมายเหตุ: โฟลว์เข้าสู่ระบบด้วยQRจะรีสตาร์ตอัตโนมัติหนึ่งครั้งสำหรับสถานะ 515 หลังการจับคู่)

## เมื่อมีบางอย่างล้มเหลว

- `logged out` หรือสถานะ 409–515 → ลิงก์ใหม่ด้วย `openclaw channels logout` จากนั้น `openclaw channels login`.
- เข้าถึงGatewayไม่ได้ → เริ่มต้นมัน: `openclaw gateway --port 18789` (ใช้ `--force` หากพอร์ตถูกใช้งานอยู่)
- ไม่มีข้อความขาเข้า → ยืนยันว่าโทรศัพท์ที่ลิงก์ออนไลน์อยู่และผู้ส่งได้รับอนุญาต (`channels.whatsapp.allowFrom`); สำหรับแชตกลุ่ม ให้ตรวจสอบว่า allowlist + กฎการกล่าวถึงตรงกัน (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## คำสั่ง "health" เฉพาะทาง

`openclaw health --json` ขอภาพรวมสุขภาพจากGatewayที่กำลังทำงาน(ไม่มีซ็อกเก็ตช่องทางโดยตรงจากCLI) โดยจะรายงาน creds/อายุการยืนยันตัวตนที่ลิงก์เมื่อมี, สรุปการตรวจแบบต่อช่องทาง, สรุปที่เก็บเซสชัน และระยะเวลาการตรวจ จะจบด้วยสถานะไม่เป็นศูนย์หากเข้าถึงGatewayไม่ได้หรือการตรวจล้มเหลว/หมดเวลา ใช้ `--timeout <ms>` เพื่อเขียนทับค่าเริ่มต้น 10วินาที
