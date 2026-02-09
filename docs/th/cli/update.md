---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw update` (อัปเดตซอร์สอย่างปลอดภัยพอสมควร + รีสตาร์ตGatewayอัตโนมัติ)"
read_when:
  - คุณต้องการอัปเดตซอร์สเช็กเอาต์อย่างปลอดภัย
  - คุณต้องการทำความเข้าใจพฤติกรรมชอร์ตแฮนด์ของ `--update`
title: "update"
---

# `openclaw update`

อัปเดต OpenClaw อย่างปลอดภัยและสลับระหว่างช่องทาง stable/beta/dev

หากคุณติดตั้งผ่าน **npm/pnpm** (ติดตั้งแบบโกลบอล ไม่มีเมตาดาต้า git) การอัปเดตจะเกิดขึ้นผ่านขั้นตอนของแพ็กเกจเมเนเจอร์ใน [Updating](/install/updating)

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: ข้ามการรีสตาร์ตบริการGatewayหลังจากอัปเดตสำเร็จ
- `--channel <stable|beta|dev>`: ตั้งค่าช่องทางการอัปเดต (git + npm; บันทึกไว้ในคอนฟิก)
- `--tag <dist-tag|version>`: แทนที่ dist-tag หรือเวอร์ชันของ npm สำหรับการอัปเดตครั้งนี้เท่านั้น
- `--json`: พิมพ์ JSON `UpdateRunResult` ที่เครื่องอ่านได้
- `--timeout <seconds>`: ไทม์เอาต์ต่อขั้นตอน (ค่าเริ่มต้นคือ 1200s)

หมายเหตุ: การดาวน์เกรดต้องมีการยืนยัน เนื่องจากเวอร์ชันเก่าอาจทำให้คอนฟิกเสียหายได้

## `update status`

แสดงช่องทางการอัปเดตที่ใช้งานอยู่ + git tag/branch/SHA (สำหรับซอร์สเช็กเอาต์) พร้อมทั้งสถานะความพร้อมของการอัปเดต

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: พิมพ์ JSON สถานะที่เครื่องอ่านได้
- `--timeout <seconds>`: ไทม์เอาต์สำหรับการตรวจสอบ (ค่าเริ่มต้นคือ 3s)

## `update wizard`

โฟลว์แบบโต้ตอบเพื่อเลือกช่องทางการอัปเดตและยืนยันว่าจะรีสตาร์ตGatewayหลังอัปเดตหรือไม่
(ค่าเริ่มต้นคือรีสตาร์ต) หากคุณเลือก `dev` โดยไม่มี git checkout
ระบบจะเสนอให้สร้างขึ้นมา 9. หากคุณเลือก `dev` โดยไม่มี git checkout มันจะ
เสนอให้สร้างให้หนึ่งรายการ

## What it does

เมื่อคุณสลับช่องทางอย่างชัดเจน (`--channel ...`) OpenClaw จะทำให้วิธีการติดตั้งสอดคล้องกันด้วย:

- `dev` → ตรวจสอบให้มี git checkout (ค่าเริ่มต้น: `~/openclaw` สามารถแทนที่ด้วย `OPENCLAW_GIT_DIR`)
  จากนั้นอัปเดต และติดตั้ง CLI แบบโกลบอลจาก checkout นั้น
- `stable`/`beta` → ติดตั้งจาก npm โดยใช้ dist-tag ที่ตรงกัน

## Git checkout flow

Channels:

- `stable`: เช็กเอาต์แท็ก non-beta ล่าสุด จากนั้น build + doctor
- `beta`: เช็กเอาต์แท็ก `-beta` ล่าสุด จากนั้น build + doctor
- `dev`: เช็กเอาต์ `main` จากนั้น fetch + rebase

High-level:

1. ต้องเป็น worktree ที่สะอาด (ไม่มีการเปลี่ยนแปลงที่ยังไม่คอมมิต)
2. สลับไปยังช่องทางที่เลือก (แท็กหรือบรานช์)
3. ดึง upstream (เฉพาะ dev)
4. เฉพาะ dev: รัน preflight lint + TypeScript build ใน worktree ชั่วคราว; หากปลายทางล้มเหลว จะไล่ย้อนกลับได้สูงสุด 10 คอมมิตเพื่อหาบิลด์ที่สะอาดล่าสุด
5. rebase เข้ากับคอมมิตที่เลือก (เฉพาะ dev)
6. ติดตั้ง dependencies (แนะนำ pnpm; สำรองด้วย npm)
7. build + build Control UI
8. รัน `openclaw doctor` เป็นการตรวจสอบ “safe update” ขั้นสุดท้าย
9. ซิงก์ปลั๊กอินให้ตรงกับช่องทางที่ใช้งานอยู่ (dev ใช้ส่วนขยายที่มากับแพ็กเกจ; stable/beta ใช้ npm) และอัปเดตปลั๊กอินที่ติดตั้งผ่าน npm

## `--update` shorthand

`openclaw --update` จะถูกเขียนใหม่เป็น `openclaw update` (มีประโยชน์สำหรับเชลล์และสคริปต์ตัวเรียก)

## See also

- `openclaw doctor` (เสนอให้รันการอัปเดตก่อนสำหรับ git checkout)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
