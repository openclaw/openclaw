---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าของบอต Zalo"
read_when:
  - ทำงานกับฟีเจอร์หรือเว็บฮุคของZalo
title: "Zalo"
---

# Zalo (Bot API)

สถานะ: ทดลอง สถานะ: ทดลองใช้งาน รองรับเฉพาะข้อความส่วนตัว; กลุ่มจะมาเร็วๆนี้ตามเอกสารของZalo

## Plugin required

Zalo จัดส่งมาในรูปแบบปลั๊กอินและไม่รวมอยู่ในการติดตั้งแกนหลัก

- ติดตั้งผ่านCLI: `openclaw plugins install @openclaw/zalo`
- หรือเลือก **Zalo** ระหว่างการเริ่มต้นใช้งานและยืนยันพรอมต์การติดตั้ง
- รายละเอียด: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. ติดตั้งปลั๊กอินZalo:
   - จากซอร์สโค้ดที่เช็กเอาต์: `openclaw plugins install ./extensions/zalo`
   - จากnpm(หากมีการเผยแพร่): `openclaw plugins install @openclaw/zalo`
   - หรือเลือก **Zalo** ในขั้นตอนเริ่มต้นใช้งานและยืนยันพรอมต์การติดตั้ง
2. ตั้งค่าโทเคน:
   - Env: `ZALO_BOT_TOKEN=...`
   - หรือคอนฟิก: `channels.zalo.botToken: "..."`.
3. รีสตาร์ตGateway(หรือทำขั้นตอนเริ่มต้นใช้งานให้เสร็จ)
4. การเข้าถึงDMเป็นแบบจับคู่โดยค่าเริ่มต้น; อนุมัติรหัสจับคู่เมื่อมีการติดต่อครั้งแรก

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## What it is

Zalo เป็นแอปส่งข้อความที่เน้นตลาดเวียดนาม; Bot API ช่วยให้Gatewayรันบอตสำหรับการสนทนาแบบ1:1
เหมาะสำหรับงานซัพพอร์ตหรือการแจ้งเตือนที่ต้องการเส้นทางการตอบกลับที่แน่นอนกลับไปยังZalo
เหมาะอย่างยิ่งสำหรับงานซัพพอร์ตหรือการแจ้งเตือนที่คุณต้องการการกำหนดเส้นทางแบบกำหนดแน่นอนกลับไปยัง Zalo

- ช่องทาง Zalo Bot API ที่Gatewayเป็นเจ้าของ
- การกำหนดเส้นทางแบบแน่นอน: การตอบกลับจะกลับไปที่Zalo; โมเดลจะไม่เลือกช่องทาง
- DMใช้เซสชันหลักของเอเจนต์ร่วมกัน
- ยังไม่รองรับกลุ่ม(Zalo docs ระบุว่า“coming soon”)

## Setup (fast path)

### 1. สร้างบอตโทเคน (Zalo Bot Platform)

1. ไปที่ [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) และลงชื่อเข้าใช้
2. สร้างบอตใหม่และตั้งค่าตามต้องการ
3. คัดลอกบอตโทเคน(รูปแบบ: `12345689:abc-xyz`)

### 2) กำหนดค่าโทเคน (env หรือคอนฟิก)

ตัวอย่าง:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

ตัวเลือกEnv: `ZALO_BOT_TOKEN=...` (ใช้ได้กับบัญชีเริ่มต้นเท่านั้น)

รองรับหลายบัญชี: ใช้ `channels.zalo.accounts` พร้อมโทเคนต่อบัญชีและ `name` (ไม่บังคับ)

3. รีสตาร์ทGateway（เกตเวย์） รีสตาร์ตGateway Zaloจะเริ่มทำงานเมื่อสามารถแก้ไขโทเคนได้(envหรือคอนฟิก)
4. การเข้าถึง DM ค่าเริ่มต้นคือการจับคู่ (pairing) การเข้าถึงDMค่าเริ่มต้นคือการจับคู่ อนุมัติรหัสเมื่อบอตถูกติดต่อครั้งแรก

## How it works (behavior)

- ข้อความขาเข้าจะถูกทำให้เป็นมาตรฐานในซองช่องทางที่ใช้ร่วมกันพร้อมตัวแทนสื่อ
- การตอบกลับจะถูกส่งกลับไปยังแชตZaloเดิมเสมอ
- ค่าเริ่มต้นเป็นlong-polling; มีโหมดเว็บฮุคให้ใช้ด้วย `channels.zalo.webhookUrl`

## Limits

- ข้อความขาออกถูกแบ่งเป็นชิ้นละ2000อักขระ(ข้อจำกัดของZalo API)
- การดาวน์โหลด/อัปโหลดสื่อจำกัดโดย `channels.zalo.mediaMaxMb` (ค่าเริ่มต้น5)
- การสตรีมถูกปิดโดยค่าเริ่มต้นเนื่องจากข้อจำกัด2000อักขระทำให้สตรีมไม่คุ้มค่า

## Access control (DMs)

### DM access

- ค่าเริ่มต้น: `channels.zalo.dmPolicy = "pairing"`. ค่าเริ่มต้น: `channels.zalo.dmPolicy = "pairing"` ผู้ส่งที่ไม่รู้จักจะได้รับรหัสจับคู่; ข้อความจะถูกเพิกเฉยจนกว่าจะอนุมัติ(รหัสหมดอายุหลัง1ชั่วโมง)
- อนุมัติผ่าน:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- การจับคู่เป็นการแลกเปลี่ยนโทเค็นตามค่าเริ่มต้น การจับคู่เป็นการแลกเปลี่ยนโทเคนเริ่มต้น รายละเอียด: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` รองรับเฉพาะรหัสผู้ใช้แบบตัวเลข(ไม่มีการค้นหาชื่อผู้ใช้)

## Long-polling vs webhook

- ค่าเริ่มต้น: long-polling(ไม่ต้องใช้URLสาธารณะ)
- โหมดเว็บฮุค: ตั้งค่า `channels.zalo.webhookUrl` และ `channels.zalo.webhookSecret`
  - Webhook secret ต้องมีความยาว 8-256 อักขระ
  - URLเว็บฮุคต้องใช้HTTPS
  - Zalo ส่งอีเวนต์พร้อมเฮดเดอร์ `X-Bot-Api-Secret-Token` เพื่อการยืนยัน
  - Gateway HTTP จัดการคำขอเว็บฮุคที่ `channels.zalo.webhookPath` (ค่าเริ่มต้นเป็นพาธของURLเว็บฮุค)

**หมายเหตุ:** getUpdates(polling) และเว็บฮุคไม่สามารถใช้พร้อมกันได้ตามเอกสารZalo API

## Supported message types

- **Text messages**: รองรับเต็มรูปแบบพร้อมการแบ่งชิ้น2000อักขระ
- **Image messages**: ดาวน์โหลดและประมวลผลรูปภาพขาเข้า; ส่งรูปภาพผ่าน `sendPhoto`
- **Stickers**: บันทึกไว้แต่ไม่ประมวลผลเต็มรูปแบบ(ไม่มีการตอบกลับจากเอเจนต์)
- **Unsupported types**: บันทึกไว้(เช่นข้อความจากผู้ใช้ที่ได้รับการป้องกัน)

## Capabilities

| Feature                           | Status                                        |
| --------------------------------- | --------------------------------------------- |
| Direct messages                   | ✅ รองรับ                                      |
| Groups                            | ❌ เร็วๆนี้(ตามเอกสารZalo)  |
| Media (images) | ✅ รองรับ                                      |
| Reactions                         | ❌ ไม่รองรับ                                   |
| Threads                           | ❌ ไม่รองรับ                                   |
| Polls                             | ❌ ไม่รองรับ                                   |
| Native commands                   | ❌ ไม่รองรับ                                   |
| Streaming                         | ⚠️ ถูกปิด(จำกัด2000อักขระ) |

## Delivery targets (CLI/cron)

- ใช้chat idเป็นเป้าหมาย
- ตัวอย่าง: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Troubleshooting

**บอตไม่ตอบสนอง:**

- ตรวจสอบว่าโทเคนถูกต้อง: `openclaw channels status --probe`
- ยืนยันว่าผู้ส่งได้รับการอนุมัติแล้ว(การจับคู่หรือallowFrom)
- ตรวจสอบล็อกGateway: `openclaw logs --follow`

**เว็บฮุคไม่ได้รับอีเวนต์:**

- ตรวจสอบให้แน่ใจว่าURLเว็บฮุคใช้HTTPS
- ตรวจสอบว่า secret token มีความยาว 8-256 อักขระ
- ยืนยันว่าเอ็นด์พอยต์HTTPของGatewayเข้าถึงได้บนพาธที่กำหนด
- ตรวจสอบว่าไม่ได้รันgetUpdates pollingอยู่(ไม่สามารถใช้พร้อมกันได้)

## Configuration reference (Zalo)

คอนฟิกทั้งหมด: [Configuration](/gateway/configuration)

ตัวเลือกของผู้ให้บริการ:

- `channels.zalo.enabled`: เปิด/ปิดการเริ่มต้นช่องทาง
- `channels.zalo.botToken`: บอตโทเคนจากZalo Bot Platform
- `channels.zalo.tokenFile`: อ่านโทเคนจากพาธไฟล์
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (ค่าเริ่มต้น: pairing)
- `channels.zalo.allowFrom`: allowlistสำหรับDM(รหัสผู้ใช้) `open` ต้องใช้ `"*"` ตัวช่วยจะถามรหัสตัวเลข `open` ต้องใช้ `"*"`. วิซาร์ดจะขอ ID ที่เป็นตัวเลข
- `channels.zalo.mediaMaxMb`: ขีดจำกัดสื่อขาเข้า/ขาออก(MB,ค่าเริ่มต้น5)
- `channels.zalo.webhookUrl`: เปิดโหมดเว็บฮุค(ต้องใช้HTTPS)
- `channels.zalo.webhookSecret`: ซีเคร็ตเว็บฮุค(8-256อักขระ)
- `channels.zalo.webhookPath`: พาธเว็บฮุคบนเซิร์ฟเวอร์HTTPของGateway
- `channels.zalo.proxy`: URLพร็อกซีสำหรับคำขอAPI

ตัวเลือกหลายบัญชี:

- `channels.zalo.accounts.<id>.botToken`: โทเคนต่อบัญชี
- `channels.zalo.accounts.<id>.tokenFile`: ไฟล์โทเคนต่อบัญชี
- `channels.zalo.accounts.<id>.name`: ชื่อที่แสดง
- `channels.zalo.accounts.<id>.enabled`: เปิด/ปิดบัญชี
- `channels.zalo.accounts.<id>.dmPolicy`: นโยบายDMต่อบัญชี
- `channels.zalo.accounts.<id>.allowFrom`: allowlistต่อบัญชี
- `channels.zalo.accounts.<id>.webhookUrl`: URLเว็บฮุคต่อบัญชี
- `channels.zalo.accounts.<id>.webhookSecret`: ซีเคร็ตเว็บฮุคต่อบัญชี
- `channels.zalo.accounts.<id>.webhookPath`: พาธเว็บฮุคต่อบัญชี
- `channels.zalo.accounts.<id>.proxy`: URLพร็อกซีต่อบัญชี
