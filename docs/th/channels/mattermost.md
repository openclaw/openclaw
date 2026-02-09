---
summary: "การตั้งค่าบอต Mattermost และคอนฟิก OpenClaw"
read_when:
  - การตั้งค่า Mattermost
  - การดีบักการกำหนดเส้นทาง Mattermost
title: "Mattermost"
---

# Mattermost (ปลั๊กอิน)

สถานะ: รองรับผ่านปลั๊กอิน (โทเคนบอท + เหตุการณ์ WebSocket) รองรับช่อง (channels), กลุ่ม (groups) และ DM
สถานะ: รองรับผ่านปลั๊กอิน (โทเคนบอต + อีเวนต์ WebSocket) รองรับช่องทาง กลุ่ม และ DMs
Mattermost เป็นแพลตฟอร์มแชทสำหรับทีมที่โฮสต์เองได้ ดูรายละเอียดผลิตภัณฑ์และดาวน์โหลดได้ที่เว็บไซต์ทางการ
[mattermost.com](https://mattermost.com)

## ต้องใช้ปลั๊กอิน

Mattermost ทำงานในรูปแบบปลั๊กอินและไม่ได้รวมมากับการติดตั้งแกนหลัก

ติดตั้งผ่าน CLI (npm registry):

```bash
openclaw plugins install @openclaw/mattermost
```

เช็คเอาต์ภายในเครื่อง (เมื่อรันจากรีโป git):

```bash
openclaw plugins install ./extensions/mattermost
```

หากคุณเลือก Mattermost ระหว่างการตั้งค่า/ออนบอร์ด และตรวจพบการเช็คเอาต์จาก git
OpenClaw จะเสนอพาธการติดตั้งภายในเครื่องให้อัตโนมัติ

รายละเอียด: [Plugins](/tools/plugin)

## ตั้งค่าอย่างรวดเร็ว

1. ติดตั้งปลั๊กอิน Mattermost
2. สร้างบัญชีบอต Mattermost และคัดลอก **โทเคนบอต**
3. คัดลอก **base URL** ของ Mattermost (เช่น `https://chat.example.com`)
4. กำหนดค่า OpenClaw และเริ่ม Gateway

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## ตัวแปรสภาพแวดล้อม (บัญชีค่าเริ่มต้น)

ตั้งค่าบนโฮสต์Gateway หากคุณต้องการใช้ env vars:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Env vars ใช้ได้เฉพาะบัญชี **ค่าเริ่มต้น** (`default`) บัญชีอื่นต้องใช้ค่าจากคอนฟิก บัญชีอื่นต้องใช้ค่าคอนฟิก

## โหมดแชท

Mattermost ตอบ DM โดยอัตโนมัติ Mattermost ตอบกลับ DMs โดยอัตโนมัติ พฤติกรรมในช่องทางควบคุมด้วย `chatmode`:

- `oncall` (ค่าเริ่มต้น): ตอบเฉพาะเมื่อถูก @mention ในช่องทาง
- `onmessage`: ตอบทุกข้อความในช่องทาง
- `onchar`: ตอบเมื่อข้อความเริ่มต้นด้วยคำนำหน้าทริกเกอร์

ตัวอย่างคอนฟิก:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

หมายเหตุ:

- `onchar` ยังตอบสนองต่อ @mention แบบชัดเจน
- `channels.mattermost.requireMention` รองรับสำหรับคอนฟิกแบบเดิม แต่แนะนำให้ใช้ `chatmode`

## การควบคุมการเข้าถึง (DMs)

- ค่าเริ่มต้น: `channels.mattermost.dmPolicy = "pairing"` (ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดการจับคู่)
- อนุมัติผ่าน:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- DMs สาธารณะ: `channels.mattermost.dmPolicy="open"` พร้อมกับ `channels.mattermost.allowFrom=["*"]`

## ช่องทาง (กลุ่ม)

- ค่าเริ่มต้น: `channels.mattermost.groupPolicy = "allowlist"` (จำกัดด้วยการกล่าวถึง)
- อนุญาตผู้ส่งด้วย `channels.mattermost.groupAllowFrom` (user IDs หรือ `@username`)
- ช่องทางเปิด: `channels.mattermost.groupPolicy="open"` (จำกัดด้วยการกล่าวถึง)

## เป้าหมายสำหรับการส่งออกภายนอก

ใช้รูปแบบเป้าหมายเหล่านี้กับ `openclaw message send` หรือ cron/webhooks:

- `channel:<id>` สำหรับช่องทาง
- `user:<id>` สำหรับ DM
- `@username` สำหรับ DM (แก้ไขผ่าน Mattermost API)

ID เปล่าจะถูกตีความเป็นช่องทาง

## หลายบัญชี

Mattermost รองรับหลายบัญชีภายใต้ `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## การแก้ไขปัญหา

- ไม่มีการตอบกลับในช่องทาง: ตรวจสอบว่าบอตอยู่ในช่องทางและกล่าวถึงมัน (oncall) ใช้คำนำหน้าทริกเกอร์ (onchar) หรือกำหนด `chatmode: "onmessage"`
- ข้อผิดพลาดการยืนยันตัวตน: ตรวจสอบโทเคนบอต base URL และสถานะการเปิดใช้งานของบัญชี
- ปัญหาหลายบัญชี: env vars ใช้ได้เฉพาะบัญชี `default`
