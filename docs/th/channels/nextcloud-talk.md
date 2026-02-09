---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าของ Nextcloud Talk"
read_when:
  - ทำงานกับฟีเจอร์ของช่องทาง Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (ปลั๊กอิน)

สถานะ: รองรับผ่านปลั๊กอิน(บอตแบบ webhook) รองรับข้อความส่วนตัว ห้อง ปฏิกิริยา และข้อความแบบ markdown รองรับข้อความส่วนตัว ห้อง แสดงปฏิกิริยา และข้อความแบบมาร์กดาวน์

## Plugin required

Nextcloud Talk มาในรูปแบบปลั๊กอินและไม่ได้รวมมากับการติดตั้งแกนหลัก

ติดตั้งผ่าน CLI (npm registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

เช็กเอาต์ในเครื่อง (เมื่อรันจาก git repo):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

หากคุณเลือก Nextcloud Talk ระหว่างการกำหนดค่า/การเริ่มต้นใช้งาน และตรวจพบการเช็กเอาต์จาก git
OpenClaw จะเสนอพาธการติดตั้งในเครื่องโดยอัตโนมัติ

รายละเอียด: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. ติดตั้งปลั๊กอิน Nextcloud Talk

2. บนเซิร์ฟเวอร์ Nextcloud ของคุณ สร้างบอต:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. เปิดใช้งานบอตในการตั้งค่าห้องเป้าหมาย

4. กำหนดค่า OpenClaw:
   - คอนฟิก: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - หรือ env: `NEXTCLOUD_TALK_BOT_SECRET` (เฉพาะบัญชีค่าเริ่มต้น)

5. รีสตาร์ท Gateway(เกตเวย์)(หรือเสร็จสิ้นการเริ่มต้นใช้งาน)

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notes

- บอตไม่สามารถเริ่ม DM ได้ ผู้ใช้ต้องส่งข้อความหาบอตก่อน ผู้ใช้ต้องส่งข้อความถึงบอทก่อน
- URL ของ webhook ต้องเข้าถึงได้โดย Gateway; ตั้งค่า `webhookPublicUrl` หากอยู่หลังพร็อกซี
- การอัปโหลดสื่อไม่รองรับโดย API ของบอต; สื่อจะถูกส่งเป็น URL
- payload ของ webhook ไม่แยกแยะ DM กับห้อง; ตั้งค่า `apiUser` + `apiPassword` เพื่อเปิดใช้การตรวจสอบประเภทห้อง (มิฉะนั้น DM จะถูกมองเป็นห้อง)

## Access control (DMs)

- ค่าเริ่มต้น: `channels.nextcloud-talk.dmPolicy = "pairing"` ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดการจับคู่ ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดสำหรับการจับคู่
- อนุมัติผ่าน:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- DM แบบสาธารณะ: `channels.nextcloud-talk.dmPolicy="open"` พร้อม `channels.nextcloud-talk.allowFrom=["*"]`
- `allowFrom` จับคู่เฉพาะ Nextcloud user ID; ชื่อที่แสดงจะถูกละเว้น

## Rooms (groups)

- ค่าเริ่มต้น: `channels.nextcloud-talk.groupPolicy = "allowlist"` (ต้องมีการกล่าวถึง)
- อนุญาตห้องด้วย `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- หากไม่ต้องการอนุญาตห้องใด ให้เว้น allowlist ว่างหรือกำหนด `channels.nextcloud-talk.groupPolicy="disabled"`

## Capabilities

| ฟีเจอร์         | สถานะ     |
| --------------- | --------- |
| Direct messages | รองรับ    |
| ห้อง            | รองรับ    |
| Threads         | ไม่รองรับ |
| สื่อ            | เฉพาะ URL |
| ปฏิกิริยา       | รองรับ    |
| คำสั่งเนทีฟ     | ไม่รองรับ |

## Configuration reference (Nextcloud Talk)

คอนฟิกทั้งหมด: [Configuration](/gateway/configuration)

ตัวเลือกผู้ให้บริการ:

- `channels.nextcloud-talk.enabled`: เปิด/ปิดการเริ่มต้นช่องทาง
- `channels.nextcloud-talk.baseUrl`: URL ของอินสแตนซ์ Nextcloud
- `channels.nextcloud-talk.botSecret`: shared secret ของบอต
- `channels.nextcloud-talk.botSecretFile`: พาธไฟล์ secret
- `channels.nextcloud-talk.apiUser`: ผู้ใช้ API สำหรับค้นหาห้อง (การตรวจจับ DM)
- `channels.nextcloud-talk.apiPassword`: รหัสผ่าน API/app สำหรับค้นหาห้อง
- `channels.nextcloud-talk.apiPasswordFile`: พาธไฟล์รหัสผ่าน API
- `channels.nextcloud-talk.webhookPort`: พอร์ตตัวรับ webhook (ค่าเริ่มต้น: 8788)
- `channels.nextcloud-talk.webhookHost`: โฮสต์ webhook (ค่าเริ่มต้น: 0.0.0.0)
- `channels.nextcloud-talk.webhookPath`: พาธ webhook (ค่าเริ่มต้น: /nextcloud-talk-webhook)
- `channels.nextcloud-talk.webhookPublicUrl`: URL webhook ที่เข้าถึงได้จากภายนอก
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: allowlist ของ DM (user ID). `open` ต้องใช้ `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: allowlist กลุ่ม (user ID)
- `channels.nextcloud-talk.rooms`: การตั้งค่าต่อห้องและ allowlist
- `channels.nextcloud-talk.historyLimit`: ขีดจำกัดประวัติกลุ่ม (0 คือปิดใช้งาน)
- `channels.nextcloud-talk.dmHistoryLimit`: ขีดจำกัดประวัติ DM (0 คือปิดใช้งาน)
- `channels.nextcloud-talk.dms`: การแทนที่ต่อ DM (historyLimit)
- `channels.nextcloud-talk.textChunkLimit`: ขนาดการแบ่งข้อความขาออก (อักขระ)
- `channels.nextcloud-talk.chunkMode`: `length` (ค่าเริ่มต้น) หรือ `newline` เพื่อแบ่งตามบรรทัดว่าง (ขอบเขตย่อหน้า) ก่อนการแบ่งตามความยาว
- `channels.nextcloud-talk.blockStreaming`: ปิดใช้งาน block streaming สำหรับช่องทางนี้
- `channels.nextcloud-talk.blockStreamingCoalesce`: การปรับจูนการรวม block streaming
- `channels.nextcloud-talk.mediaMaxMb`: ขีดจำกัดสื่อขาเข้า (MB)
