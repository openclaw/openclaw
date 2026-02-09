---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าของ Matrix"
read_when:
  - ทำงานเกี่ยวกับฟีเจอร์ของช่องทาง Matrix
title: "Matrix"
---

# Matrix (ปลั๊กอิน)

Matrix เป็นโปรโตคอลการส่งข้อความแบบเปิดและกระจายศูนย์ Matrix เป็นโปรโตคอลการส่งข้อความแบบเปิดและกระจายศูนย์ OpenClaw เชื่อมต่อในฐานะ **ผู้ใช้** Matrix
บน homeserver ใดก็ได้ ดังนั้นคุณต้องมีบัญชี Matrix สำหรับบอต เมื่อเข้าสู่ระบบแล้ว
คุณสามารถส่ง DM ถึงบอตโดยตรงหรือเชิญเข้าห้อง (Matrix “groups”) ได้ Beeper ก็เป็นตัวเลือกไคลเอนต์ที่ใช้ได้เช่นกัน
แต่จำเป็นต้องเปิดใช้งาน E2EE เมื่อเข้าสู่ระบบแล้ว คุณสามารถ DM
บอทโดยตรงหรือเชิญเข้าไปในห้อง ("กลุ่ม" ของ Matrix) Beeper เป็นตัวเลือกไคลเอนต์ที่ใช้ได้เช่นกัน,
แต่ต้องเปิดใช้ E2EE

สถานะ: รองรับผ่านปลั๊กอิน (@vector-im/matrix-bot-sdk) สถานะ: รองรับผ่านปลั๊กอิน (@vector-im/matrix-bot-sdk) รองรับข้อความส่วนตัว ห้อง เธรด สื่อ รีแอ็กชัน
โพล (ส่ง + poll-start เป็นข้อความ) ตำแหน่ง และ E2EE (พร้อมการรองรับคริปโต)

## ต้องใช้ปลั๊กอิน

Matrix จัดส่งในรูปแบบปลั๊กอินและไม่รวมอยู่ในการติดตั้งแกนหลัก

ติดตั้งผ่าน CLI (npm registry):

```bash
openclaw plugins install @openclaw/matrix
```

เช็กเอาต์ภายในเครื่อง (เมื่อรันจากรีโป git):

```bash
openclaw plugins install ./extensions/matrix
```

หากคุณเลือก Matrix ระหว่างการกำหนดค่า/การเริ่มต้นใช้งาน และตรวจพบการเช็กเอาต์ git
OpenClaw จะเสนอเส้นทางติดตั้งภายในเครื่องให้อัตโนมัติ

รายละเอียด: [Plugins](/tools/plugin)

## การตั้งค่า

1. ติดตั้งปลั๊กอิน Matrix:
   - จาก npm: `openclaw plugins install @openclaw/matrix`
   - จากการเช็กเอาต์ภายในเครื่อง: `openclaw plugins install ./extensions/matrix`

2. สร้างบัญชี Matrix บน homeserver:
   - ดูตัวเลือกโฮสติ้งที่ [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - หรือโฮสต์เอง

3. รับ access token สำหรับบัญชีบอต:

   - ใช้ Matrix login API ด้วย `curl` ที่ homeserver ของคุณ:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - แทนที่ `matrix.example.org` ด้วย URL ของ homeserver
   - หรือกำหนด `channels.matrix.userId` + `channels.matrix.password`: OpenClaw จะเรียก
     endpoint การล็อกอินเดียวกัน จัดเก็บ access token ไว้ใน `~/.openclaw/credentials/matrix/credentials.json`
     และนำกลับมาใช้เมื่อเริ่มต้นครั้งถัดไป

4. กำหนดค่าข้อมูลรับรอง:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (หรือ `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - หรือ config: `channels.matrix.*`
   - หากตั้งค่าทั้งสองแบบ config จะมีลำดับความสำคัญสูงกว่า
   - เมื่อใช้ access token ระบบจะดึง user ID อัตโนมัติผ่าน `/whoami`
   - เมื่อกำหนดแล้ว `channels.matrix.userId` ควรเป็น Matrix ID แบบเต็ม (ตัวอย่าง: `@bot:example.org`)

5. รีสตาร์ต Gateway (หรือทำขั้นตอนการเริ่มต้นใช้งานให้เสร็จ)

6. เริ่ม DM กับบอตหรือเชิญเข้าห้องจากไคลเอนต์ Matrix ใดก็ได้
   (Element, Beeper ฯลฯ; ดู [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)) Beeper ต้องใช้ E2EE
   ดังนั้นให้ตั้งค่า `channels.matrix.encryption: true` และยืนยันอุปกรณ์ Beeper ต้องการ E2EE,
   ดังนั้นให้ตั้งค่า `channels.matrix.encryption: true` และยืนยันอุปกรณ์

คอนฟิกขั้นต่ำ (access token, ดึง user ID อัตโนมัติ):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

คอนฟิก E2EE (เปิดใช้งานการเข้ารหัสแบบ end-to-end):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## การเข้ารหัส (E2EE)

รองรับการเข้ารหัสแบบ end-to-end **แล้ว** ผ่าน Rust crypto SDK

เปิดใช้งานด้วย `channels.matrix.encryption: true`:

- หากโมดูลคริปโตโหลดได้ ห้องที่เข้ารหัสจะถูกถอดรหัสอัตโนมัติ
- สื่อขาออกจะถูกเข้ารหัสเมื่อส่งไปยังห้องที่เข้ารหัส
- ในการเชื่อมต่อครั้งแรก OpenClaw จะขอการยืนยันอุปกรณ์จากเซสชันอื่นของคุณ
- ยืนยันอุปกรณ์ในไคลเอนต์ Matrix อื่น (Element ฯลฯ) เพื่อเปิดใช้การแชร์กุญแจ เพื่อเปิดใช้การแชร์คีย์
- หากไม่สามารถโหลดโมดูลคริปโตได้ E2EE จะถูกปิดใช้งานและห้องที่เข้ารหัสจะไม่ถูกถอดรหัส;
  OpenClaw จะบันทึกคำเตือน
- หากพบข้อผิดพลาดเกี่ยวกับโมดูลคริปโตที่หายไป (เช่น `@matrix-org/matrix-sdk-crypto-nodejs-*`)
  ให้อนุญาต build scripts สำหรับ `@matrix-org/matrix-sdk-crypto-nodejs` และรัน
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` หรือดึงไบนารีด้วย
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`

สถานะคริปโตถูกจัดเก็บต่อบัญชี + access token ใน
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(ฐานข้อมูล SQLite) สถานะการซิงก์จะอยู่เคียงกันใน `bot-storage.json`
หาก access token (อุปกรณ์) เปลี่ยน ระบบจะสร้างสโตร์ใหม่และบอตต้อง
ยืนยันใหม่สำหรับห้องที่เข้ารหัส สถานะการซิงก์จะอยู่ควบคู่กันใน `bot-storage.json`
หากโทเคนการเข้าถึง (อุปกรณ์) เปลี่ยน จะมีการสร้างสโตร์ใหม่ และบอทต้อง
ได้รับการยืนยันใหม่สำหรับห้องที่เข้ารหัส

**การยืนยันอุปกรณ์:**
เมื่อเปิดใช้งาน E2EE บอตจะขอการยืนยันจากเซสชันอื่นของคุณเมื่อเริ่มต้นระบบ
เปิด Element (หรือไคลเอนต์อื่น) และอนุมัติคำขอยืนยันเพื่อสร้างความเชื่อถือ
เมื่อยืนยันแล้ว บอตจะสามารถถอดรหัสข้อความในห้องที่เข้ารหัสได้
เปิด Element (หรือไคลเอนต์อื่น) และอนุมัติคำขอยืนยันเพื่อสร้างความเชื่อถือ
เมื่อยืนยันแล้ว บอทจะสามารถถอดรหัสข้อความในห้องที่เข้ารหัสได้

## โมเดลการกำหนดเส้นทาง

- การตอบกลับจะส่งกลับไปยัง Matrix เสมอ
- DMs ใช้เซสชันหลักของเอเจนต์ร่วมกัน ส่วนห้องจะแมปเป็นเซสชันกลุ่ม

## การควบคุมการเข้าถึง(DMs)

- ค่าเริ่มต้น: `channels.matrix.dm.policy = "pairing"` ผู้ส่งที่ไม่รู้จักจะได้รับรหัสจับคู่ ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดจับคู่
- อนุมัติผ่าน:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- DMs แบบสาธารณะ: `channels.matrix.dm.policy="open"` พร้อม `channels.matrix.dm.allowFrom=["*"]`
- `channels.matrix.dm.allowFrom` รองรับ Matrix user ID แบบเต็ม (ตัวอย่าง: `@user:server`) `channels.matrix.dm.allowFrom` รับ Matrix user ID แบบเต็ม (ตัวอย่าง: `@user:server`) ตัวช่วยตั้งค่าจะทำการแปลงชื่อที่แสดงเป็น user ID เมื่อการค้นหาไดเรกทอรีพบตรงกันแบบเดียว

## ห้อง (กลุ่ม)

- ค่าเริ่มต้น: `channels.matrix.groupPolicy = "allowlist"` (ต้องกล่าวถึงจึงตอบ) ใช้ `channels.defaults.groupPolicy` เพื่อแทนค่าค่าเริ่มต้นเมื่อยังไม่ตั้งค่า ใช้ `channels.defaults.groupPolicy` เพื่อแทนที่ค่าเริ่มต้นเมื่อยังไม่ตั้งค่า
- อนุญาตห้องด้วย `channels.matrix.groups` (room IDs หรือ aliases; ระบบจะแปลงชื่อเป็น ID เมื่อการค้นหาไดเรกทอรีพบตรงกันแบบเดียว):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` เปิดการตอบกลับอัตโนมัติในห้องนั้น
- `groups."*"` สามารถตั้งค่าเริ่มต้นของการบังคับกล่าวถึงข้ามหลายห้อง
- `groupAllowFrom` จำกัดผู้ส่งที่สามารถกระตุ้นบอตในห้อง (Matrix user ID แบบเต็ม)
- allowlist ต่อห้อง `users` สามารถจำกัดผู้ส่งเพิ่มเติมภายในห้องเฉพาะ (ใช้ Matrix user ID แบบเต็ม)
- ตัวช่วยตั้งค่าจะถาม allowlist ของห้อง (room IDs, aliases หรือชื่อ) และจะแปลงชื่อเฉพาะกรณีที่ตรงกันแบบเอกลักษณ์
- เมื่อเริ่มต้น OpenClaw จะแปลงชื่อห้อง/ผู้ใช้ใน allowlists เป็น IDs และบันทึกการแมป รายการที่ไม่สามารถแปลงได้จะถูกละเว้นในการจับคู่ allowlist
- คำเชิญจะถูกเข้าร่วมอัตโนมัติโดยค่าเริ่มต้น ควบคุมด้วย `channels.matrix.autoJoin` และ `channels.matrix.autoJoinAllowlist`
- หากต้องการ **ไม่อนุญาตห้องใดเลย** ให้ตั้งค่า `channels.matrix.groupPolicy: "disabled"` (หรือปล่อย allowlist ว่าง)
- คีย์แบบเดิม: `channels.matrix.rooms` (โครงสร้างเดียวกับ `groups`)

## Threads

- รองรับการตอบกลับแบบเธรด
- `channels.matrix.threadReplies` ควบคุมว่าการตอบกลับจะอยู่ในเธรดหรือไม่:
  - `off`, `inbound` (ค่าเริ่มต้น), `always`
- `channels.matrix.replyToMode` ควบคุมเมทาดาทา reply-to เมื่อไม่ตอบในเธรด:
  - `off` (ค่าเริ่มต้น), `first`, `all`

## ความสามารถ

| ฟีเจอร์         | สถานะ                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Direct messages | ✅ รองรับ                                                                                           |
| ห้อง            | ✅ รองรับ                                                                                           |
| Threads         | ✅ รองรับ                                                                                           |
| สื่อ            | ✅ รองรับ                                                                                           |
| E2EE            | ✅ รองรับ (ต้องใช้โมดูลคริปโต)                                                   |
| รีแอ็กชัน       | ✅ รองรับ (ส่ง/อ่านผ่านเครื่องมือ)                                               |
| Polls           | ✅ รองรับการส่ง; การเริ่มโพลขาเข้าจะถูกแปลงเป็นข้อความ (ละเว้นการตอบ/การสิ้นสุด) |
| ตำแหน่ง         | ✅ รองรับ (geo URI; ไม่สนใจระดับความสูง)                                         |
| คำสั่งเนทีฟ     | ✅ รองรับ                                                                                           |

## การแก้ไขปัญหา

ให้รันลำดับขั้นนี้ก่อน:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

จากนั้นตรวจสอบสถานะการจับคู่ DM หากจำเป็น:

```bash
openclaw pairing list matrix
```

ปัญหาที่พบบ่อย:

- ล็อกอินแล้วแต่ข้อความในห้องถูกละเลย: ห้องถูกบล็อกโดย `groupPolicy` หรือ allowlist ของห้อง
- DMs ถูกละเลย: ผู้ส่งรอการอนุมัติเมื่อ `channels.matrix.dm.policy="pairing"`
- ห้องที่เข้ารหัสล้มเหลว: การรองรับคริปโตหรือการตั้งค่าการเข้ารหัสไม่ตรงกัน

โฟลว์การไตรเอจ: [/channels/troubleshooting](/channels/troubleshooting)

## อ้างอิงการกำหนดค่า (Matrix)

การกำหนดค่าแบบเต็ม: [Configuration](/gateway/configuration)

ตัวเลือกของผู้ให้บริการ:

- `channels.matrix.enabled`: เปิด/ปิดการเริ่มต้นช่องทาง
- `channels.matrix.homeserver`: URL ของ homeserver
- `channels.matrix.userId`: Matrix user ID (ไม่บังคับเมื่อใช้ access token)
- `channels.matrix.accessToken`: access token
- `channels.matrix.password`: รหัสผ่านสำหรับการล็อกอิน (มีการจัดเก็บโทเคน)
- `channels.matrix.deviceName`: ชื่อแสดงของอุปกรณ์
- `channels.matrix.encryption`: เปิดใช้งาน E2EE (ค่าเริ่มต้น: false)
- `channels.matrix.initialSyncLimit`: ขีดจำกัดการซิงก์เริ่มต้น
- `channels.matrix.threadReplies`: `off | inbound | always` (ค่าเริ่มต้น: inbound)
- `channels.matrix.textChunkLimit`: ขนาดชิ้นข้อความขาออก (ตัวอักษร)
- `channels.matrix.chunkMode`: `length` (ค่าเริ่มต้น) หรือ `newline` เพื่อแยกตามบรรทัดว่าง (ขอบเขตย่อหน้า) ก่อนการตัดตามความยาว
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (ค่าเริ่มต้น: pairing)
- `channels.matrix.dm.allowFrom`: allowlist ของ DM (Matrix user ID แบบเต็ม) `open` ต้องใช้ `"*"` ตัวช่วยตั้งค่าจะแปลงชื่อเป็น ID เมื่อเป็นไปได้ `open` ต้องใช้ `"*"`. วิซาร์ดจะจับคู่ชื่อเป็น ID เมื่อเป็นไปได้
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (ค่าเริ่มต้น: allowlist)
- `channels.matrix.groupAllowFrom`: ผู้ส่งที่อยู่ใน allowlist สำหรับข้อความกลุ่ม (Matrix user ID แบบเต็ม)
- `channels.matrix.allowlistOnly`: บังคับกฎ allowlist สำหรับ DMs + ห้อง
- `channels.matrix.groups`: allowlist กลุ่ม + แผนที่การตั้งค่าต่อห้อง
- `channels.matrix.rooms`: allowlist/คอนฟิกกลุ่มแบบเดิม
- `channels.matrix.replyToMode`: โหมด reply-to สำหรับเธรด/แท็ก
- `channels.matrix.mediaMaxMb`: ขีดจำกัดสื่อขาเข้า/ขาออก (MB)
- `channels.matrix.autoJoin`: การจัดการคำเชิญ (`always | allowlist | off`, ค่าเริ่มต้น: always)
- `channels.matrix.autoJoinAllowlist`: room IDs/aliases ที่อนุญาตสำหรับการเข้าร่วมอัตโนมัติ
- `channels.matrix.actions`: การควบคุมเครื่องมือตามการกระทำ (reactions/messages/pins/memberInfo/channelInfo)
