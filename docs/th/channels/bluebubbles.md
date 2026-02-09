---
summary: "iMessage ผ่านเซิร์ฟเวอร์ BlueBubbles บน macOS (ส่ง/รับแบบ REST, การพิมพ์, รีแอคชัน, การจับคู่, แอ็กชันขั้นสูง)"
read_when:
  - การตั้งค่าช่องทาง BlueBubbles
  - การแก้ไขปัญหาการจับคู่ webhook
  - การกำหนดค่า iMessage บน macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. สถานะ: ปลั๊กอินที่รวมมาให้ซึ่งสื่อสารกับเซิร์ฟเวอร์ BlueBubbles บน macOS ผ่าน HTTP **แนะนำสำหรับการเชื่อมต่อ iMessage** เนื่องจากมี API ที่สมบูรณ์กว่าและตั้งค่าได้ง่ายกว่าช่องทาง imsg แบบเดิม

## ภาพรวม

- ทำงานบน macOS ผ่านแอปช่วย BlueBubbles ([bluebubbles.app](https://bluebubbles.app))
- 17. แนะนำ/ทดสอบแล้ว: macOS Sequoia (15) แนะนำ/ทดสอบแล้ว: macOS Sequoia (15) ใช้งานได้กับ macOS Tahoe (26) แต่การแก้ไขข้อความขณะนี้ไม่ทำงานบน Tahoe และการอัปเดตไอคอนกลุ่มอาจรายงานว่าสำเร็จแต่ไม่ซิงก์
- OpenClaw สื่อสารผ่าน REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`)
- ข้อความขาเข้าเข้ามาผ่าน webhooks; การตอบกลับขาออก ตัวบ่งชี้การพิมพ์ ใบรับการอ่าน และ tapbacks เป็น REST calls
- ไฟล์แนบและสติกเกอร์ถูกรับเข้าเป็นสื่อขาเข้า (และแสดงให้เอเจนต์เมื่อเป็นไปได้)
- การจับคู่/รายการอนุญาตทำงานเหมือนช่องทางอื่น ๆ (`/channels/pairing` เป็นต้น) ด้วย `channels.bluebubbles.allowFrom` + โค้ดจับคู่
- รีแอคชันจะแสดงเป็นอีเวนต์ของระบบเหมือน Slack/Telegram เพื่อให้เอเจนต์สามารถ “อ้างถึง” ก่อนตอบกลับได้
- ฟีเจอร์ขั้นสูง: แก้ไข ยกเลิกการส่ง เธรดการตอบ เอฟเฟกต์ข้อความ การจัดการกลุ่ม

## เริ่มต้นอย่างรวดเร็ว

1. ติดตั้งเซิร์ฟเวอร์ BlueBubbles บน Mac ของคุณ (ทำตามคำแนะนำที่ [bluebubbles.app/install](https://bluebubbles.app/install))

2. ในคอนฟิก BlueBubbles เปิดใช้งาน web API และตั้งรหัสผ่าน

3. รัน `openclaw onboard` และเลือก BlueBubbles หรือกำหนดค่าด้วยตนเอง:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. ชี้ webhooks ของ BlueBubbles ไปยัง Gateway ของคุณ (ตัวอย่าง: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

5. เริ่ม Gateway; ระบบจะลงทะเบียนตัวจัดการ webhook และเริ่มการจับคู่

## การทำให้ Messages.app ทำงานตลอด (VM / headless)

การตั้งค่า macOS แบบ VM / เปิดตลอดบางแบบอาจทำให้ Messages.app เข้าสู่สถานะ “idle” (อีเวนต์ขาเข้าหยุดจนกว่าจะเปิดแอปหรือดึงขึ้นหน้า) วิธีแก้ชั่วคราวที่ง่ายคือ **กระตุ้น Messages ทุก 5 นาที** ด้วย AppleScript + LaunchAgent 18. วิธีแก้ชั่วคราวแบบง่ายคือ **กระตุ้น Messages ทุก ๆ 5 นาที** โดยใช้ AppleScript + LaunchAgent

### 1. บันทึก AppleScript

บันทึกเป็น:

- `~/Scripts/poke-messages.scpt`

ตัวอย่างสคริปต์ (ไม่โต้ตอบ; ไม่แย่งโฟกัส):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. ติดตั้ง LaunchAgent

บันทึกเป็น:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

หมายเหตุ:

- ทำงาน **ทุก 300 วินาที** และ **เมื่อเข้าสู่ระบบ**
- การรันครั้งแรกอาจกระตุ้นพรอมต์ **Automation** ของ macOS (`osascript` → Messages) ให้อนุมัติในเซสชันผู้ใช้เดียวกับที่รัน LaunchAgent 19. อนุมัติสิทธิ์ในเซสชันผู้ใช้เดียวกันกับที่รัน LaunchAgent

โหลดใช้งาน:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## 20. การเริ่มต้นใช้งาน

BlueBubbles มีให้เลือกในวิซาร์ดตั้งค่าแบบโต้ตอบ:

```
openclaw onboard
```

21. วิซาร์ดจะถาม:

- **Server URL** (จำเป็น): ที่อยู่เซิร์ฟเวอร์ BlueBubbles (เช่น `http://192.168.1.100:1234`)
- **Password** (จำเป็น): รหัสผ่าน API จากการตั้งค่า BlueBubbles Server
- **Webhook path** (ไม่บังคับ): ค่าเริ่มต้นคือ `/bluebubbles-webhook`
- **DM policy**: pairing, allowlist, open หรือ disabled
- **Allow list**: หมายเลขโทรศัพท์ อีเมล หรือเป้าหมายแชต

คุณสามารถเพิ่ม BlueBubbles ผ่าน CLI ได้เช่นกัน:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## การควบคุมการเข้าถึง (DMs + กลุ่ม)

DMs:

- ค่าเริ่มต้น: `channels.bluebubbles.dmPolicy = "pairing"`
- ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดจับคู่; ข้อความจะถูกละเว้นจนกว่าจะอนุมัติ (โค้ดหมดอายุภายใน 1 ชั่วโมง)
- อนุมัติผ่าน:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing is the default token exchange. การจับคู่เป็นการแลกเปลี่ยนโทเคนเริ่มต้น รายละเอียด: [Pairing](/channels/pairing)

กลุ่ม:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (ค่าเริ่มต้น: `allowlist`)
- `channels.bluebubbles.groupAllowFrom` ควบคุมว่าใครสามารถทริกเกอร์ในกลุ่มเมื่อกำหนด `allowlist`

### Mention gating (groups)

BlueBubbles รองรับการกรองด้วยการกล่าวถึงสำหรับแชตกลุ่ม ตรงตามพฤติกรรม iMessage/WhatsApp:

- ใช้ `agents.list[].groupChat.mentionPatterns` (หรือ `messages.groupChat.mentionPatterns`) เพื่อตรวจจับการกล่าวถึง
- เมื่อเปิดใช้งาน `requireMention` สำหรับกลุ่ม เอเจนต์จะตอบกลับเฉพาะเมื่อถูกกล่าวถึง
- คำสั่งควบคุมจากผู้ส่งที่ได้รับอนุญาตจะข้ามการกรองด้วยการกล่าวถึง

การกำหนดค่ารายกลุ่ม:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### การกรองคำสั่ง (Command gating)

- คำสั่งควบคุม (เช่น `/config`, `/model`) ต้องได้รับอนุญาต
- ใช้ `allowFrom` และ `groupAllowFrom` เพื่อกำหนดการอนุญาตคำสั่ง
- ผู้ส่งที่ได้รับอนุญาตสามารถรันคำสั่งควบคุมได้แม้ไม่กล่าวถึงในกลุ่ม

## การพิมพ์ + ใบรับการอ่าน

- **ตัวบ่งชี้การพิมพ์**: ส่งอัตโนมัติก่อนและระหว่างการสร้างคำตอบ
- **ใบรับการอ่าน**: ควบคุมด้วย `channels.bluebubbles.sendReadReceipts` (ค่าเริ่มต้น: `true`)
- **ตัวบ่งชี้การพิมพ์**: OpenClaw ส่งอีเวนต์เริ่มพิมพ์; BlueBubbles จะล้างสถานะการพิมพ์อัตโนมัติเมื่อส่งหรือหมดเวลา (การหยุดแบบ manual ผ่าน DELETE ไม่น่าเชื่อถือ)

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## แอ็กชันขั้นสูง

BlueBubbles รองรับแอ็กชันข้อความขั้นสูงเมื่อเปิดใช้งานในคอนฟิก:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

แอ็กชันที่มีให้:

- **react**: เพิ่ม/ลบ tapback reactions (`messageId`, `emoji`, `remove`)
- **edit**: แก้ไขข้อความที่ส่งแล้ว (`messageId`, `text`)
- **unsend**: ยกเลิกการส่งข้อความ (`messageId`)
- **reply**: ตอบกลับข้อความที่ระบุ (`messageId`, `text`, `to`)
- **sendWithEffect**: ส่งพร้อมเอฟเฟกต์ iMessage (`text`, `to`, `effectId`)
- **renameGroup**: เปลี่ยนชื่อแชตกลุ่ม (`chatGuid`, `displayName`)
- **setGroupIcon**: ตั้งค่าไอคอน/รูปกลุ่ม (`chatGuid`, `media`) — ไม่เสถียรบน macOS 26 Tahoe (API อาจรายงานว่าสำเร็จแต่ไอคอนไม่ซิงก์)
- **addParticipant**: เพิ่มสมาชิกเข้ากลุ่ม (`chatGuid`, `address`)
- **removeParticipant**: ลบสมาชิกออกจากกลุ่ม (`chatGuid`, `address`)
- **leaveGroup**: ออกจากแชตกลุ่ม (`chatGuid`)
- **sendAttachment**: ส่งสื่อ/ไฟล์ (`to`, `buffer`, `filename`, `asVoice`)
  - ข้อความเสียง: ตั้งค่า `asVoice: true` ด้วยไฟล์เสียง **MP3** หรือ **CAF** เพื่อส่งเป็นข้อความเสียง iMessage โดย BlueBubbles จะแปลง MP3 → CAF เมื่อส่ง 24. BlueBubbles จะแปลง MP3 → CAF เมื่อส่งวอยซ์เมโม

### Message IDs (แบบสั้น vs แบบเต็ม)

OpenClaw อาจแสดง message ID แบบ _สั้น_ (เช่น `1`, `2`) เพื่อประหยัดโทเคน

- `MessageSid` / `ReplyToId` อาจเป็น ID แบบสั้น
- `MessageSidFull` / `ReplyToIdFull` เป็น ID แบบเต็มจากผู้ให้บริการ
- ID แบบสั้นอยู่ในหน่วยความจำ อาจหมดอายุเมื่อรีสตาร์ตหรือถูกล้างแคช
- แอ็กชันรองรับ `messageId` ทั้งแบบสั้นหรือเต็ม แต่ ID แบบสั้นจะเกิดข้อผิดพลาดหากไม่พร้อมใช้งานแล้ว

ใช้ ID แบบเต็มสำหรับออโตเมชันและการจัดเก็บที่ต้องการความคงทน:

- เทมเพลต: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- บริบท: `MessageSidFull` / `ReplyToIdFull` ใน payload ขาเข้า

ดู [Configuration](/gateway/configuration) สำหรับตัวแปรเทมเพลต

## สตรีมแบบบล็อก

ควบคุมว่าการตอบกลับจะส่งเป็นข้อความเดียวหรือสตรีมเป็นบล็อก:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## สื่อ + ข้อจำกัด

- ไฟล์แนบขาเข้าจะถูกดาวน์โหลดและเก็บในแคชสื่อ
- จำกัดขนาดสื่อด้วย `channels.bluebubbles.mediaMaxMb` (ค่าเริ่มต้น: 8 MB)
- ข้อความขาออกถูกแบ่งเป็น `channels.bluebubbles.textChunkLimit` (ค่าเริ่มต้น: 4000 ตัวอักษร)

## เอกสารอ้างอิงการกำหนดค่า

การกำหนดค่าแบบเต็ม: [Configuration](/gateway/configuration)

ตัวเลือกผู้ให้บริการ:

- `channels.bluebubbles.enabled`: เปิด/ปิดช่องทาง
- `channels.bluebubbles.serverUrl`: URL ฐานของ BlueBubbles REST API
- `channels.bluebubbles.password`: รหัสผ่าน API
- `channels.bluebubbles.webhookPath`: พาธ endpoint ของ webhook (ค่าเริ่มต้น: `/bluebubbles-webhook`)
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (ค่าเริ่มต้น: `pairing`)
- `channels.bluebubbles.allowFrom`: DM allowlist (แฮนด์เดิล อีเมล หมายเลข E.164, `chat_id:*`, `chat_guid:*`)
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (ค่าเริ่มต้น: `allowlist`)
- `channels.bluebubbles.groupAllowFrom`: Allowlist ผู้ส่งในกลุ่ม
- `channels.bluebubbles.groups`: คอนฟิกรายกลุ่ม (`requireMention` เป็นต้น)
- `channels.bluebubbles.sendReadReceipts`: ส่งใบรับการอ่าน (ค่าเริ่มต้น: `true`)
- `channels.bluebubbles.blockStreaming`: เปิดใช้งานสตรีมแบบบล็อก (ค่าเริ่มต้น: `false`; จำเป็นสำหรับการตอบแบบสตรีม)
- `channels.bluebubbles.textChunkLimit`: ขนาดการแบ่งข้อความขาออกเป็นตัวอักษร (ค่าเริ่มต้น: 4000)
- `channels.bluebubbles.chunkMode`: `length` (ค่าเริ่มต้น) จะแบ่งเฉพาะเมื่อเกิน `textChunkLimit`; `newline` จะแบ่งตามบรรทัดว่าง (ขอบเขตย่อหน้า) ก่อนการแบ่งตามความยาว
- `channels.bluebubbles.mediaMaxMb`: ขีดจำกัดสื่อขาเข้าเป็น MB (ค่าเริ่มต้น: 8)
- `channels.bluebubbles.historyLimit`: จำนวนข้อความกลุ่มสูงสุดสำหรับบริบท (0 คือปิด)
- `channels.bluebubbles.dmHistoryLimit`: ขีดจำกัดประวัติ DM
- `channels.bluebubbles.actions`: เปิด/ปิดแอ็กชันเฉพาะ
- `channels.bluebubbles.accounts`: การกำหนดค่าแบบหลายบัญชี

ตัวเลือกส่วนกลางที่เกี่ยวข้อง:

- `agents.list[].groupChat.mentionPatterns` (หรือ `messages.groupChat.mentionPatterns`)
- `messages.responsePrefix`

## การระบุที่อยู่ / เป้าหมายการส่งมอบ

แนะนำให้ใช้ `chat_guid` เพื่อการกำหนดเส้นทางที่เสถียร:

- `chat_guid:iMessage;-;+15555550123` (แนะนำสำหรับกลุ่ม)
- `chat_id:123`
- `chat_identifier:...`
- แฮนด์เดิลโดยตรง: `+15555550123`, `user@example.com`
  - หากแฮนด์เดิลโดยตรงยังไม่มีแชต DM อยู่ OpenClaw จะสร้างให้ผ่าน `POST /api/v1/chat/new` ซึ่งต้องเปิดใช้งาน BlueBubbles Private API 25. ต้องเปิดใช้งาน BlueBubbles Private API

## ความปลอดภัย

- คำขอ webhook จะถูกยืนยันตัวตนโดยเปรียบเทียบพารามิเตอร์คิวรีหรือเฮดเดอร์ `guid`/`password` กับ `channels.bluebubbles.password` คำขอจาก `localhost` ก็ยอมรับได้เช่นกัน 26. คำขอจาก `localhost` ก็ได้รับการยอมรับเช่นกัน
- เก็บรหัสผ่าน API และ endpoint ของ webhook เป็นความลับ (ปฏิบัติเหมือนข้อมูลรับรอง)
- ความเชื่อถือ localhost หมายความว่า reverse proxy บนโฮสต์เดียวกันอาจข้ามการตรวจรหัสผ่านได้โดยไม่ตั้งใจ หากทำพร็อกซีให้ Gateway ให้บังคับยืนยันตัวตนที่พร็อกซีและกำหนดค่า `gateway.trustedProxies` ดู [Gateway security](/gateway/security#reverse-proxy-configuration) 27. หากคุณทำ proxy ให้กับ gateway ให้บังคับใช้การยืนยันตัวตนที่ proxy และตั้งค่า `gateway.trustedProxies` 28. ดู [Gateway security](/gateway/security#reverse-proxy-configuration)
- เปิดใช้งาน HTTPS + กฎไฟร์วอลล์บนเซิร์ฟเวอร์ BlueBubbles หากเปิดให้เข้าถึงจากนอก LAN

## การแก้ไขปัญหา

- หากอีเวนต์การพิมพ์/การอ่านหยุดทำงาน ตรวจสอบล็อก webhook ของ BlueBubbles และยืนยันว่าพาธของ Gateway ตรงกับ `channels.bluebubbles.webhookPath`
- โค้ดจับคู่หมดอายุภายในหนึ่งชั่วโมง ใช้ `openclaw pairing list bluebubbles` และ `openclaw pairing approve bluebubbles <code>`
- รีแอคชันต้องใช้ BlueBubbles private API (`POST /api/v1/message/react`) ตรวจสอบให้แน่ใจว่าเวอร์ชันเซิร์ฟเวอร์รองรับ
- การแก้ไข/ยกเลิกการส่งต้องใช้ macOS 13+ และเวอร์ชัน BlueBubbles ที่เข้ากันได้ บน macOS 26 (Tahoe) การแก้ไขขณะนี้ไม่ทำงานเนื่องจากการเปลี่ยนแปลง private API 29. บน macOS 26 (Tahoe) ฟังก์ชันแก้ไขยังไม่ทำงานเนื่องจากการเปลี่ยนแปลงของ private API
- การอัปเดตไอคอนกลุ่มอาจไม่เสถียรบน macOS 26 (Tahoe): API อาจรายงานว่าสำเร็จแต่ไอคอนไม่ซิงก์
- 30. OpenClaw จะซ่อนแอ็กชันที่ทราบว่าใช้งานไม่ได้โดยอัตโนมัติตามเวอร์ชัน macOS ของเซิร์ฟเวอร์ BlueBubbles OpenClaw จะซ่อนแอ็กชันที่ทราบว่ามีปัญหาโดยอัตโนมัติตามเวอร์ชัน macOS ของเซิร์ฟเวอร์ BlueBubbles หากยังเห็นการแก้ไขบน macOS 26 (Tahoe) ให้ปิดด้วยตนเองด้วย `channels.bluebubbles.actions.edit=false`
- สำหรับข้อมูลสถานะ/สุขภาพระบบ: `openclaw status --all` หรือ `openclaw status --deep`

สำหรับภาพรวมเวิร์กโฟลว์ของช่องทางทั่วไป ดู [Channels](/channels) และคู่มือ [Plugins](/tools/plugin)
