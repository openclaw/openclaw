---
summary: "ปลั๊กอิน Zalo Personal: เข้าสู่ระบบด้วย QR + การส่งข้อความผ่าน zca-cli (ติดตั้งปลั๊กอิน + คอนฟิกช่องทาง + CLI + เครื่องมือ)"
read_when:
  - คุณต้องการรองรับ Zalo Personal (ไม่เป็นทางการ) ใน OpenClaw
  - คุณกำลังกำหนดค่าหรือพัฒนาปลั๊กอิน zalouser
title: "ปลั๊กอิน Zalo Personal"
---

# Zalo Personal (ปลั๊กอิน)

รองรับ Zalo Personal สำหรับ OpenClaw ผ่านปลั๊กอิน โดยใช้ `zca-cli` เพื่อทำงานอัตโนมัติกับบัญชีผู้ใช้ Zalo ปกติ

> **คำเตือน:** การทำงานอัตโนมัติแบบไม่เป็นทางการอาจทำให้บัญชีถูกระงับ/แบน ใช้งานด้วยความเสี่ยงของคุณเอง 22. ใช้ด้วยความเสี่ยงของคุณเอง

## การตั้งชื่อ

Channel id คือ `zalouser` เพื่อระบุอย่างชัดเจนว่านี่คือการทำงานอัตโนมัติของ **บัญชีผู้ใช้ Zalo ส่วนบุคคล** (ไม่เป็นทางการ) เราสงวน `zalo` ไว้สำหรับการผสานรวม Zalo API อย่างเป็นทางการที่อาจมีในอนาคต 23. เราสงวนชื่อ `zalo` ไว้สำหรับความเป็นไปได้ในการผสานรวม Zalo API อย่างเป็นทางการในอนาคต

## ทำงานที่ใด

ปลั๊กอินนี้ทำงาน **ภายในกระบวนการ Gateway（เกตเวย์）**

หากคุณใช้ Gateway ระยะไกล ให้ติดตั้ง/กำหนดค่าบน **เครื่องที่รัน Gateway（เกตเวย์）** จากนั้นรีสตาร์ต Gateway

## ติดตั้ง

### ตัวเลือก A: ติดตั้งจาก npm

```bash
openclaw plugins install @openclaw/zalouser
```

จากนั้นรีสตาร์ต Gateway

### ตัวเลือก B: ติดตั้งจากโฟลเดอร์ภายในเครื่อง (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

จากนั้นรีสตาร์ต Gateway

## ข้อกำหนดก่อนเริ่มต้น: zca-cli

เครื่องของ Gateway ต้องมี `zca` บน `PATH`:

```bash
zca --version
```

## คอนฟิก

คอนฟิกของช่องทางอยู่ภายใต้ `channels.zalouser` (ไม่ใช่ `plugins.entries.*`):

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## เครื่องมือของเอเจนต์

ชื่อเครื่องมือ: `zalouser`

การกระทำ: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
