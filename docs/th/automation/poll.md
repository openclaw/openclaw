---
summary: "การส่งโพลผ่าน Gateway（เกตเวย์） + CLI"
read_when:
  - การเพิ่มหรือแก้ไขการรองรับโพล
  - การดีบักการส่งโพลจาก CLI หรือ Gateway（เกตเวย์）
title: "Polls"
---

# Polls

## ช่องทางที่รองรับ

- WhatsApp (web channel)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

ตัวเลือก:

- `--channel`: `whatsapp` (ค่าเริ่มต้น), `discord` หรือ `msteams`
- `--poll-multi`: อนุญาตให้เลือกได้หลายตัวเลือก
- `--poll-duration-hours`: ใช้กับ Discord เท่านั้น (ค่าเริ่มต้นคือ 24 เมื่อไม่ระบุ)

## Gateway RPC

เมธอด: `poll`

3. พารามิเตอร์:

- `to` (string, จำเป็น)
- `question` (string, จำเป็น)
- `options` (string[], จำเป็น)
- `maxSelections` (number, ไม่บังคับ)
- `durationHours` (number, ไม่บังคับ)
- `channel` (string, ไม่บังคับ, ค่าเริ่มต้น: `whatsapp`)
- `idempotencyKey` (string, จำเป็น)

## ความแตกต่างตามช่องทาง

- WhatsApp: 2-12 ตัวเลือก, `maxSelections` ต้องอยู่ภายในจำนวนตัวเลือก, ไม่สนใจ `durationHours`.
- Discord: 2-10 ตัวเลือก, `durationHours` ถูกจำกัดให้อยู่ที่ 1-768 ชั่วโมง (ค่าเริ่มต้น 24). `maxSelections > 1` เปิดใช้งานการเลือกหลายตัวเลือก; Discord ไม่รองรับการกำหนดจำนวนการเลือกแบบตายตัว.
- MS Teams: โพลแบบ Adaptive Card (จัดการโดย OpenClaw). ไม่มี API โพลแบบเนทีฟ; `durationHours` จะถูกละเว้น.

## เครื่องมือเอเจนต์ (Message)

ใช้เครื่องมือ `message` กับแอ็กชัน `poll` (`to`, `pollQuestion`, `pollOption`, และไม่บังคับ `pollMulti`, `pollDurationHours`, `channel`).

หมายเหตุ: Discord ไม่มีโหมด “เลือกได้พอดี N”; `pollMulti` จะถูกแมปเป็นการเลือกหลายตัวเลือก.
โพลของ Teams จะแสดงผลเป็น Adaptive Cards และต้องให้ Gateway（เกตเวย์）ออนไลน์ต่อเนื่อง
เพื่อบันทึกคะแนนโหวตใน `~/.openclaw/msteams-polls.json`.
