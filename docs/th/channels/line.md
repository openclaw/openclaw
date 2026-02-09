---
summary: "การตั้งค่า คอนฟิก และการใช้งานปลั๊กอิน LINE Messaging API"
read_when:
  - คุณต้องการเชื่อมต่อ OpenClaw กับ LINE
  - คุณต้องการตั้งค่า webhook และข้อมูลรับรองของ LINE
  - คุณต้องการตัวเลือกข้อความเฉพาะของ LINE
title: LINE
---

# LINE (ปลั๊กอิน)

LINE เชื่อมต่อกับ OpenClaw ผ่าน LINE Messaging API LINE เชื่อมต่อกับ OpenClaw ผ่าน LINE Messaging API ปลั๊กอินทำงานเป็นตัวรับ webhook
บน Gateway และใช้ channel access token และ channel secret ของคุณเพื่อการยืนยันตัวตน

สถานะ: รองรับผ่านปลั๊กอิน สถานะ: รองรับผ่านปลั๊กอิน รองรับข้อความส่วนตัว แชทกลุ่ม สื่อ ตำแหน่ง Flex
messages, template messages และ quick replies ไม่รองรับ reactions และ threads ไม่รองรับรีแอ็กชันและเธรด

## ต้องใช้ปลั๊กอิน

ติดตั้งปลั๊กอิน LINE:

```bash
openclaw plugins install @openclaw/line
```

เช็กเอาต์ในเครื่อง (เมื่อรันจาก git repo):

```bash
openclaw plugins install ./extensions/line
```

## การตั้งค่า

1. สร้างบัญชี LINE Developers และเปิด Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. สร้าง (หรือเลือก) Provider และเพิ่มช่องทาง **Messaging API**
3. คัดลอก **Channel access token** และ **Channel secret** จากการตั้งค่าช่องทาง
4. เปิดใช้งาน **Use webhook** ในการตั้งค่า Messaging API
5. ตั้งค่า webhook URL ไปยังเอ็นด์พอยต์ของ Gateway ของคุณ (ต้องเป็น HTTPS):

```
https://gateway-host/line/webhook
```

Gateway จะตอบสนองการตรวจสอบ webhook ของ LINE (GET) และอีเวนต์ขาเข้า (POST)
หากต้องการพาธแบบกำหนดเอง ให้ตั้งค่า `channels.line.webhookPath` หรือ
`channels.line.accounts.<id>
หากต้องการพาธแบบกำหนดเอง ให้ตั้งค่า `channels.line.webhookPath`หรือ`channels.line.accounts.<id>`.webhookPath` และอัปเดต URL ให้สอดคล้องกัน

## การกำหนดค่า

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

ตัวแปรสภาพแวดล้อม (บัญชีเริ่มต้นเท่านั้น):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

ไฟล์โทเคน/ซีเคร็ต:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

หลายบัญชี:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## การควบคุมการเข้าถึง

ข้อความโดยตรงจะจับคู่เป็นค่าเริ่มต้น ข้อความส่วนตัวจะตั้งค่าเป็นการจับคู่โดยค่าเริ่มต้น ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดจับคู่
และข้อความของพวกเขาจะถูกละเว้นจนกว่าจะได้รับการอนุมัติ

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

รายการอนุญาตและนโยบาย:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: รายการ LINE user ID ที่อนุญาตสำหรับ DMs
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: รายการ LINE user ID ที่อนุญาตสำหรับกลุ่ม
- การกำหนดค่าแทนรายกลุ่ม: `channels.line.groups.<groupId>.allowFrom`

LINE ID แยกแยะตัวพิมพ์เล็ก-ใหญ่ รูปแบบ ID ที่ถูกต้องเช่น: ID ที่ถูกต้องมีลักษณะดังนี้:

- ผู้ใช้: `U` + อักขระฐานสิบหก 32 ตัว
- กลุ่ม: `C` + อักขระฐานสิบหก 32 ตัว
- ห้อง: `R` + อักขระฐานสิบหก 32 ตัว

## พฤติกรรมของข้อความ

- ข้อความจะถูกแบ่งเป็นช่วงละ 5000 อักขระ
- การจัดรูปแบบ Markdown จะถูกลบออก; บล็อกโค้ดและตารางจะถูกแปลงเป็น Flex
  cards เมื่อเป็นไปได้
- การตอบกลับแบบสตรีมจะถูกบัฟเฟอร์; LINE จะได้รับข้อมูลเป็นช่วงเต็มพร้อมแอนิเมชัน
  การโหลดระหว่างที่เอเจนต์ทำงาน
- การดาวน์โหลดสื่อถูกจำกัดโดย `channels.line.mediaMaxMb` (ค่าเริ่มต้น 10)

## ข้อมูลช่องทาง (ข้อความแบบ rich)

ใช้ `channelData.line` เพื่อส่ง quick replies ตำแหน่ง Flex cards หรือ template
messages

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

ปลั๊กอิน LINE ยังมาพร้อมคำสั่ง `/card` สำหรับพรีเซ็ต Flex message:

```
/card info "Welcome" "Thanks for joining!"
```

## การแก้ไขปัญหา

- **การตรวจสอบ webhook ล้มเหลว:** ตรวจสอบให้แน่ใจว่า webhook URL เป็น HTTPS และ
  `channelSecret` ตรงกับใน LINE console
- **ไม่มีอีเวนต์ขาเข้า:** ยืนยันว่า webhook path ตรงกับ `channels.line.webhookPath`
  และ Gateway สามารถเข้าถึงได้จาก LINE
- **ข้อผิดพลาดในการดาวน์โหลดสื่อ:** เพิ่มค่า `channels.line.mediaMaxMb` หากสื่อมีขนาดเกิน
  ขีดจำกัดเริ่มต้น
