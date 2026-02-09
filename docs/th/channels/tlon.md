---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าสำหรับ Tlon/Urbit"
read_when:
  - กำลังทำงานเกี่ยวกับฟีเจอร์ช่องทาง Tlon/Urbit
title: "Tlon"
---

# Tlon (ปลั๊กอิน)

Tlon is a decentralized messenger built on Urbit. Tlon เป็นแอปส่งข้อความแบบกระจายศูนย์ที่สร้างบน Urbit OpenClaw เชื่อมต่อกับ Urbit ship ของคุณและสามารถ
ตอบกลับข้อความส่วนตัว(DMs)และข้อความแชทกลุ่มได้ การตอบกลับในกลุ่มต้องมีการ @ mention ตามค่าเริ่มต้น และสามารถ
จำกัดเพิ่มเติมได้ด้วย allowlists Group replies require an @ mention by default and can
be further restricted via allowlists.

Status: supported via plugin. สถานะ: รองรับผ่านปลั๊กอิน รองรับ DMs, การกล่าวถึงในกลุ่ม, การตอบกลับในเธรด และการสำรองสื่อเป็นข้อความเท่านั้น
(แนบ URL ต่อท้ายคำบรรยาย) ไม่รองรับรีแอ็กชัน โพล และการอัปโหลดสื่อแบบเนทีฟ Reactions, polls, and native media uploads are not supported.

## ต้องใช้ปลั๊กอิน

Tlon จัดส่งมาเป็นปลั๊กอินและไม่ได้รวมมากับการติดตั้งแกนหลัก

ติดตั้งผ่าน CLI (npm registry):

```bash
openclaw plugins install @openclaw/tlon
```

เช็กเอาต์แบบโลคัล (เมื่อรันจาก git repo):

```bash
openclaw plugins install ./extensions/tlon
```

รายละเอียด: [Plugins](/tools/plugin)

## การตั้งค่า

1. ติดตั้งปลั๊กอิน Tlon
2. รวบรวม URL ของ ship และโค้ดล็อกอิน
3. กำหนดค่า `channels.tlon`
4. รีสตาร์ทGateway（เกตเวย์）
5. ส่ง DM ถึงบอตหรือกล่าวถึงในช่องทางกลุ่ม

คอนฟิกขั้นต่ำ (บัญชีเดียว):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## ช่องทางกลุ่ม

Auto-discovery is enabled by default. เปิดใช้งานการค้นหาอัตโนมัติเป็นค่าเริ่มต้น คุณยังสามารถปักหมุดช่องทางด้วยตนเองได้:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

ปิดการค้นหาอัตโนมัติ:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## การควบคุมการเข้าถึง

DM allowlist (ว่าง = อนุญาตทั้งหมด):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

การอนุญาตในกลุ่ม (จำกัดเป็นค่าเริ่มต้น):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## เป้าหมายการส่งมอบ(CLI/cron)

ใช้สิ่งเหล่านี้ร่วมกับ `openclaw message send` หรือการส่งมอบด้วย cron:

- DM: `~sampel-palnet` หรือ `dm/~sampel-palnet`
- กลุ่ม: `chat/~host-ship/channel` หรือ `group:~host-ship/channel`

## หมายเหตุ

- การตอบกลับในกลุ่มต้องมีการกล่าวถึง (เช่น `~your-bot-ship`) จึงจะตอบได้
- การตอบกลับในเธรด: หากข้อความขาเข้าอยู่ในเธรด OpenClaw จะตอบกลับในเธรด
- สื่อ: `sendMedia` จะสำรองเป็นข้อความ + URL (ไม่มีการอัปโหลดแบบเนทีฟ)
