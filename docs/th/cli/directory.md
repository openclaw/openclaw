---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw directory` (self, peers, groups)"
read_when:
  - คุณต้องการค้นหาIDของผู้ติดต่อ/กลุ่ม/ตัวเองสำหรับช่องทางหนึ่ง
  - คุณกำลังพัฒนาอะแดปเตอร์ไดเรกทอรีของช่องทาง
title: "ไดเรกทอรี"
---

# `openclaw directory`

การค้นหาไดเรกทอรีสำหรับช่องทางที่รองรับ(ผู้ติดต่อ/เพื่อน, กลุ่ม และ “ฉัน”)

## แฟล็กที่ใช้บ่อย

- `--channel <name>`: channel id/alias (จำเป็นเมื่อมีการกำหนดค่าหลายช่องทาง; จะเลือกอัตโนมัติเมื่อกำหนดค่าเพียงช่องทางเดียว)
- `--account <id>`: account id (ค่าเริ่มต้น: ค่าเริ่มต้นของช่องทาง)
- `--json`: เอาต์พุตJSON

## หมายเหตุ

- `directory` มีไว้เพื่อช่วยคุณค้นหาIDที่สามารถคัดลอกไปวางในคำสั่งอื่นได้(โดยเฉพาะ `openclaw message send --target ...`)。
- สำหรับหลายช่องทาง ผลลัพธ์จะอ้างอิงจากคอนฟิก(allowlists/กลุ่มที่ตั้งค่าไว้)มากกว่าการดึงจากไดเรกทอรีของผู้ให้บริการแบบสด
- เอาต์พุตค่าเริ่มต้นคือ `id` (และบางครั้ง `name`) คั่นด้วยแท็บ; ใช้ `--json` สำหรับงานสคริปต์

## การใช้ผลลัพธ์ร่วมกับ `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## รูปแบบID(ตามช่องทาง)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (กลุ่ม)
- Telegram: `@username` หรือ chat id แบบตัวเลข; กลุ่มใช้ id แบบตัวเลข
- Slack: `user:U…` และ `channel:C…`
- Discord: `user:<id>` และ `channel:<id>`
- Matrix (ปลั๊กอิน): `user:@user:server`, `room:!roomId:server` หรือ `#alias:server`
- Microsoft Teams (ปลั๊กอิน): `user:<id>` และ `conversation:<id>`
- Zalo (ปลั๊กอิน): user id (Bot API)
- Zalo Personal / `zalouser` (ปลั๊กอิน): thread id (DM/กลุ่ม) จาก `zca` (`me`, `friend list`, `group list`)

## ตัวเอง(“ฉัน”)

```bash
openclaw directory self --channel zalouser
```

## เพื่อน(ผู้ติดต่อ/ผู้ใช้)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## กลุ่ม

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
