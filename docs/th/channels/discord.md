---
summary: "สถานะการรองรับ ความสามารถ และการกำหนดค่าของบอตDiscord"
read_when:
  - กำลังพัฒนาฟีเจอร์ของช่องทางDiscord
title: "Discord"
---

# Discord (Bot API)

สถานะ: พร้อมใช้งานสำหรับDMและช่องข้อความของกิลด์ผ่านเกตเวย์บอตDiscordอย่างเป็นทางการ

## Quick setup (beginner)

1. สร้างบอตDiscordและคัดลอกโทเคนบอต
2. ในการตั้งค่าแอปDiscord ให้เปิดใช้งาน **Message Content Intent** (และ **Server Members Intent** หากคุณวางแผนจะใช้รายการอนุญาตหรือการค้นหาชื่อ)
3. ตั้งค่าโทเคนให้กับOpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - หรือคอนฟิก: `channels.discord.token: "..."`.
   - หากตั้งค่าทั้งสองอย่าง คอนฟิกจะมีลำดับความสำคัญสูงกว่า (env fallback ใช้ได้เฉพาะบัญชีค่าเริ่มต้น)
4. เชิญบอตเข้ามาในเซิร์ฟเวอร์ของคุณพร้อมสิทธิ์การส่งข้อความ (สร้างเซิร์ฟเวอร์ส่วนตัวหากต้องการใช้เฉพาะDM)
5. เริ่มต้น Gateway
6. การเข้าถึงDMเป็นแบบการจับคู่โดยค่าเริ่มต้น; อนุมัติรหัสการจับคู่ในการติดต่อครั้งแรก

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Goals

- สนทนากับOpenClawผ่านDMของDiscordหรือช่องกิลด์
- แชตแบบตรงจะถูกรวมเข้าเป็นเซสชันหลักของเอเจนต์ (ค่าเริ่มต้น `agent:main:main`); ช่องกิลด์จะถูกแยกเป็น `agent:<agentId>:discord:channel:<channelId>` (ชื่อที่แสดงใช้ `discord:<guildSlug>#<channelSlug>`)
- Group DMจะถูกละเว้นโดยค่าเริ่มต้น; เปิดใช้งานด้วย `channels.discord.dm.groupEnabled` และอาจจำกัดด้วย `channels.discord.dm.groupChannels`
- คงการกำหนดเส้นทางให้เป็นแบบกำหนดแน่นอน: การตอบกลับจะส่งกลับไปยังช่องทางที่รับข้อความมาเสมอ

## How it works

1. สร้างแอปพลิเคชันDiscord → Bot เปิดใช้งานintentที่ต้องการ (DMs + ข้อความกิลด์ + เนื้อหาข้อความ) และรับโทเคนบอต
2. เชิญบอตเข้ามาในเซิร์ฟเวอร์ของคุณพร้อมสิทธิ์ที่จำเป็นในการอ่าน/ส่งข้อความในตำแหน่งที่คุณต้องการใช้งาน
3. กำหนดค่าOpenClawด้วย `channels.discord.token` (หรือ `DISCORD_BOT_TOKEN` เป็นตัวสำรอง)
4. รันGateway; ระบบจะเริ่มช่องDiscordอัตโนมัติเมื่อมีโทเคน (คอนฟิกมาก่อน, envเป็นตัวสำรอง) และ `channels.discord.enabled` ไม่เป็น `false`.
   - หากต้องการใช้env vars ให้ตั้งค่า `DISCORD_BOT_TOKEN` (บล็อกคอนฟิกเป็นตัวเลือก)
5. แชตตรง: ใช้ `user:<id>` (หรือการกล่าวถึง `<@id>`) เมื่อส่งมอบ; ทุกเทิร์นจะอยู่ในเซสชันที่ใช้ร่วมกัน `main`. IDตัวเลขล้วนมีความกำกวมและจะถูกปฏิเสธ
6. 39. ช่องทางของกิลด์: ใช้ `channel:<channelId>` สำหรับการส่ง ช่องกิลด์: ใช้ `channel:<channelId>` สำหรับการส่งมอบ ต้องมีการกล่าวถึงโดยค่าเริ่มต้น และสามารถตั้งค่าเป็นรายกิลด์หรือรายช่องได้
7. แชตตรง: ปลอดภัยโดยค่าเริ่มต้นผ่าน `channels.discord.dm.policy` (ค่าเริ่มต้น: `"pairing"`). ผู้ส่งที่ไม่รู้จักจะได้รับรหัสการจับคู่ (หมดอายุหลัง 1 ชั่วโมง); อนุมัติผ่าน `openclaw pairing approve discord <code>`.
   - หากต้องการคงพฤติกรรมแบบ “เปิดให้ใครก็ได้” เดิม: ตั้งค่า `channels.discord.dm.policy="open"` และ `channels.discord.dm.allowFrom=["*"]`.
   - หากต้องการรายการอนุญาตแบบเข้มงวด: ตั้งค่า `channels.discord.dm.policy="allowlist"` และระบุผู้ส่งใน `channels.discord.dm.allowFrom`.
   - หากต้องการละเว้นDMทั้งหมด: ตั้งค่า `channels.discord.dm.enabled=false` หรือ `channels.discord.dm.policy="disabled"`.
8. Group DMจะถูกละเว้นโดยค่าเริ่มต้น; เปิดใช้งานด้วย `channels.discord.dm.groupEnabled` และอาจจำกัดด้วย `channels.discord.dm.groupChannels`.
9. กฎกิลด์เสริม: ตั้งค่า `channels.discord.guilds` โดยคีย์เป็นguild id (แนะนำ) หรือslug พร้อมกฎรายช่อง
10. คำสั่งเนทีฟเสริม: `commands.native` ค่าเริ่มต้นเป็น `"auto"` (เปิดสำหรับDiscord/Telegram, ปิดสำหรับSlack). แทนที่ด้วย `channels.discord.commands.native: true|false|"auto"`; `false` จะล้างคำสั่งที่ลงทะเบียนไว้ก่อนหน้า คำสั่งข้อความถูกควบคุมด้วย `commands.text` และต้องส่งเป็นข้อความ `/...` แบบเดี่ยว ใช้ `commands.useAccessGroups: false` เพื่อข้ามการตรวจกลุ่มการเข้าถึงสำหรับคำสั่ง 40. คำสั่งแบบข้อความถูกควบคุมโดย `commands.text` และต้องส่งเป็นข้อความ `/...` แบบเดี่ยว 41. ใช้ `commands.useAccessGroups: false` เพื่อข้ามการตรวจสอบ access-group สำหรับคำสั่ง
    - รายการคำสั่งทั้งหมด + คอนฟิก: [Slash commands](/tools/slash-commands)
11. ประวัติบริบทกิลด์เสริม: ตั้งค่า `channels.discord.historyLimit` (ค่าเริ่มต้น 20, ถอยกลับไปที่ `messages.groupChat.historyLimit`) เพื่อรวมข้อความกิลด์ล่าสุด N รายการเป็นบริบทเมื่อตอบการกล่าวถึง ตั้งค่า `0` เพื่อปิดใช้งาน 42. ตั้งค่า `0` เพื่อปิดใช้งาน
12. รีแอคชัน: เอเจนต์สามารถทริกเกอร์รีแอคชันผ่านเครื่องมือ `discord` (ควบคุมด้วย `channels.discord.actions.*`)
    - ความหมายการลบรีแอคชัน: ดูที่ [/tools/reactions](/tools/reactions).
    - เครื่องมือ `discord` จะถูกเปิดเผยเฉพาะเมื่อช่องปัจจุบันเป็นDiscord
13. คำสั่งเนทีฟใช้คีย์เซสชันแบบแยก (`agent:<agentId>:discord:slash:<userId>`) แทนเซสชันที่ใช้ร่วมกัน `main`

หมายเหตุ: การแปลงชื่อ → id ใช้การค้นหาสมาชิกกิลด์และต้องใช้Server Members Intent; หากบอตค้นหาสมาชิกไม่ได้ ให้ใช้idหรือการกล่าวถึง `<@id>`
หมายเหตุ: Slugเป็นตัวพิมพ์เล็กและแทนที่ช่องว่างด้วย `-`.
43. หมายเหตุ: slug เป็นตัวพิมพ์เล็ก และแทนที่ช่องว่างด้วย `-` 44. ชื่อช่องทางจะถูกทำเป็น slug โดยไม่รวม `#` นำหน้า
ชื่อช่องจะถูกทำเป็นslugโดยไม่มี `#` นำหน้า
หมายเหตุ: บรรทัดบริบทกิลด์ `[from:]` จะรวม `author.tag` + `id` เพื่อให้ง่ายต่อการตอบแบบping-ready

## Config writes

โดยค่าเริ่มต้น Discord ได้รับอนุญาตให้เขียนอัปเดตคอนฟิกที่ถูกทริกเกอร์โดย `/config set|unset` (ต้องใช้ `commands.config: true`)

ปิดใช้งานด้วย:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## How to create your own bot

นี่คือการตั้งค่า “Discord Developer Portal” สำหรับรันOpenClawในช่องเซิร์ฟเวอร์(guild) เช่น `#help`.

### 1. สร้างแอปDiscord + ผู้ใช้บอต

1. Discord Developer Portal → **Applications** → **New Application**
2. ในแอปของคุณ:
   - **Bot** → **Add Bot**
   - คัดลอก **Bot Token** (นี่คือสิ่งที่คุณใส่ใน `DISCORD_BOT_TOKEN`)

### 2) เปิดใช้งานgateway intentsที่OpenClawต้องใช้

Discordจะบล็อก “privileged intents” เว้นแต่คุณจะเปิดใช้งานอย่างชัดเจน

ใน **Bot** → **Privileged Gateway Intents** ให้เปิดใช้งาน:

- **Message Content Intent** (จำเป็นสำหรับการอ่านข้อความในกิลด์ส่วนใหญ่; หากไม่เปิด คุณจะเห็น “Used disallowed intents” หรือบอตจะเชื่อมต่อได้แต่ไม่ตอบสนองต่อข้อความ)
- **Server Members Intent** (แนะนำ; จำเป็นสำหรับการค้นหาสมาชิก/ผู้ใช้บางอย่างและการจับคู่รายการอนุญาตในกิลด์)

45. โดยทั่วไปคุณ **ไม่** จำเป็นต้องใช้ **Presence Intent** โดยทั่วไปคุณ **ไม่จำเป็น** ต้องใช้ **Presence Intent** การตั้งค่าสถานะของบอตเอง (การกระทำ `setPresence`) ใช้gateway OP3 และไม่ต้องใช้intentนี้; จำเป็นเฉพาะเมื่อคุณต้องการรับอัปเดตสถานะของสมาชิกกิลด์คนอื่น

### 3. สร้างURLเชิญ (OAuth2 URL Generator)

ในแอปของคุณ: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (จำเป็นสำหรับคำสั่งเนทีฟ)

**Bot Permissions** (ขั้นต่ำ)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (ไม่บังคับแต่แนะนำ)
- ✅ Use External Emojis / Stickers (ไม่บังคับ; เฉพาะเมื่อคุณต้องการใช้)

หลีกเลี่ยง **Administrator** เว้นแต่คุณกำลังดีบักและเชื่อถือบอตอย่างเต็มที่

คัดลอกURLที่สร้างขึ้น เปิดURL เลือกเซิร์ฟเวอร์ของคุณ และติดตั้งบอต

### 4. รับids (guild/user/channel)

Discordใช้idตัวเลขทุกที่; คอนฟิกOpenClawแนะนำให้ใช้id

1. Discord (เดสก์ท็อป/เว็บ) → **User Settings** → **Advanced** → เปิด **Developer Mode**
2. คลิกขวา:
   - ชื่อเซิร์ฟเวอร์ → **Copy Server ID** (guild id)
   - ช่อง (เช่น `#help`) → **Copy Channel ID**
   - ผู้ใช้ของคุณ → **Copy User ID**

### 5) กำหนดค่าOpenClaw

#### Token

ตั้งค่าโทเคนบอตผ่านenv var (แนะนำบนเซิร์ฟเวอร์):

- `DISCORD_BOT_TOKEN=...`

หรือผ่านคอนฟิก:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

รองรับหลายบัญชี: ใช้ `channels.discord.accounts` พร้อมโทเคนต่อบัญชีและ `name` (ไม่บังคับ) รองรับหลายบัญชี: ใช้ `channels.discord.accounts` พร้อมโทเคนต่อบัญชีและ `name` (ไม่บังคับ) ดู [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) สำหรับรูปแบบที่ใช้ร่วมกัน

#### Allowlist + การกำหนดเส้นทางช่อง

ตัวอย่าง “เซิร์ฟเวอร์เดียว อนุญาตเฉพาะฉัน อนุญาตเฉพาะ #help”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

หมายเหตุ:

- `requireMention: true` หมายความว่าบอตจะตอบเฉพาะเมื่อถูกกล่าวถึง (แนะนำสำหรับช่องที่ใช้ร่วมกัน)
- `agents.list[].groupChat.mentionPatterns` (หรือ `messages.groupChat.mentionPatterns`) นับเป็นการกล่าวถึงสำหรับข้อความกิลด์ด้วย
- การแทนที่หลายเอเจนต์: ตั้งค่ารูปแบบรายเอเจนต์ที่ `agents.list[].groupChat.mentionPatterns`
- หากมี `channels` ช่องใดที่ไม่อยู่ในรายการจะถูกปฏิเสธโดยค่าเริ่มต้น
- ใช้รายการช่องแบบ `"*"` เพื่อใช้ค่าเริ่มต้นกับทุกช่อง; รายการช่องที่ระบุชัดจะทับค่า wildcard
- เธรดจะสืบทอดคอนฟิกจากช่องแม่ (รายการอนุญาต, `requireMention`, skills, พรอมป์ต์ ฯลฯ) เว้นแต่คุณจะเพิ่มidช่องเธรดโดยตรง 46. เว้นแต่คุณจะเพิ่ม thread channel id อย่างชัดเจน
- คำใบ้เจ้าของ: เมื่อรายการอนุญาต `users` ระดับกิลด์หรือระดับช่องตรงกับผู้ส่ง OpenClawจะถือว่าผู้ส่งนั้นเป็นเจ้าของในsystem prompt สำหรับเจ้าของแบบส่วนกลางข้ามช่อง ให้ตั้งค่า `commands.ownerAllowFrom` 47. สำหรับ owner แบบ global ข้ามทุกช่องทาง ให้ตั้งค่า `commands.ownerAllowFrom`
- ข้อความที่บอตเป็นผู้เขียนจะถูกละเว้นโดยค่าเริ่มต้น; ตั้งค่า `channels.discord.allowBots=true` เพื่ออนุญาต (ข้อความของตนเองยังคงถูกกรอง)
- คำเตือน: หากคุณอนุญาตให้ตอบบอตอื่น (`channels.discord.allowBots=true`) ให้ป้องกันลูปบอตต่อบอตด้วยรายการอนุญาต `requireMention`, `channels.discord.guilds.*.channels.<id>.users` และ/หรือเคลียร์การ์ดเรลใน `AGENTS.md` และ `SOUL.md`

### 6. ตรวจสอบว่าใช้งานได้

1. เริ่มGateway
2. ในช่องเซิร์ฟเวอร์ของคุณ ส่ง: `@Krill hello` (หรือชื่อบอตของคุณ)
3. หากไม่เกิดอะไรขึ้น: ตรวจสอบ **Troubleshooting** ด้านล่าง

### Troubleshooting

- ขั้นแรก: รัน `openclaw doctor` และ `openclaw channels status --probe` (คำเตือนที่ลงมือทำได้ + การตรวจสอบอย่างรวดเร็ว)
- **“Used disallowed intents”**: เปิด **Message Content Intent** (และมักจะต้อง **Server Members Intent**) ในDeveloper Portal จากนั้นรีสตาร์ตGateway
- **บอตเชื่อมต่อได้แต่ไม่ตอบในช่องกิลด์**:
  - ขาด **Message Content Intent** หรือ
  - บอตไม่มีสิทธิ์ของช่อง (View/Send/Read History) หรือ
  - คอนฟิกกำหนดให้ต้องกล่าวถึงแต่คุณไม่ได้กล่าวถึง หรือ
  - รายการอนุญาตกิลด์/ช่องปฏิเสธช่อง/ผู้ใช้
- **`requireMention: false` แต่ยังไม่ตอบ**:
- `channels.discord.groupPolicy` ค่าเริ่มต้นเป็น **allowlist**; ตั้งค่าเป็น `"open"` หรือเพิ่มรายการกิลด์ภายใต้ `channels.discord.guilds` (อาจระบุช่องภายใต้ `channels.discord.guilds.<id>.channels` เพื่อจำกัด)
  - หากคุณตั้งค่าเฉพาะ `DISCORD_BOT_TOKEN` และไม่เคยสร้างส่วน `channels.discord` ระบบรันไทม์จะตั้งค่าเริ่มต้น `groupPolicy` เป็น `open`. เพิ่ม `channels.discord.groupPolicy`, `channels.defaults.groupPolicy`, หรือรายการอนุญาตกิลด์/ช่องเพื่อจำกัด
- `requireMention` ต้องอยู่ภายใต้ `channels.discord.guilds` (หรือช่องเฉพาะ) `channels.discord.requireMention` ที่ระดับบนสุดจะถูกละเว้น 48. `channels.discord.requireMention` ที่ระดับบนสุดจะถูกละเลย
- 49. **การตรวจสอบสิทธิ์** (`channels status --probe`) จะตรวจสอบเฉพาะ channel ID แบบตัวเลขเท่านั้น **การตรวจสอบสิทธิ์** (`channels status --probe`) ตรวจสอบเฉพาะidช่องตัวเลข หากคุณใช้slug/ชื่อเป็นคีย์ `channels.discord.guilds.*.channels` การตรวจสอบจะยืนยันสิทธิ์ไม่ได้
- **DMไม่ทำงาน**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, หรือคุณยังไม่ได้รับการอนุมัติ (`channels.discord.dm.policy="pairing"`)
- **การอนุมัติการรันคำสั่งในDiscord**: Discordรองรับ **UIปุ่ม** สำหรับการอนุมัติในDM (Allow once / Always allow / Deny) `/approve <id> ...` ใช้สำหรับการส่งต่อการอนุมัติเท่านั้นและจะไม่แก้ไขพรอมป์ต์ปุ่มของDiscord หากคุณเห็น `❌ Failed to submit approval: Error: unknown approval id` หรือUIไม่แสดง ตรวจสอบ: 50. `/approve <id> ...` ใช้สำหรับการอนุมัติที่ถูกส่งต่อเท่านั้น และจะไม่ resolve ปุ่มยืนยันของ Discord 1. หากคุณเห็น `❌ Failed to submit approval: Error: unknown approval id` หรือ UI ไม่แสดงขึ้นมา ให้ตรวจสอบ:
  - `channels.discord.execApprovals.enabled: true` ในคอนฟิกของคุณ
  - idผู้ใช้Discordของคุณอยู่ใน `channels.discord.execApprovals.approvers` (UIจะส่งให้ผู้อนุมัติเท่านั้น)
  - ใช้ปุ่มในพรอมป์ต์DM (**Allow once**, **Always allow**, **Deny**)
  - ดู [Exec approvals](/tools/exec-approvals) และ [Slash commands](/tools/slash-commands) สำหรับโฟลว์การอนุมัติและคำสั่งโดยรวม

## Capabilities & limits

- DMและช่องข้อความกิลด์ (เธรดถือเป็นช่องแยก; ไม่รองรับเสียง)
- ตัวบ่งชี้การพิมพ์ส่งแบบพยายามดีที่สุด; การแบ่งข้อความใช้ `channels.discord.textChunkLimit` (ค่าเริ่มต้น 2000) และแบ่งคำตอบยาวตามจำนวนบรรทัด (`channels.discord.maxLinesPerMessage`, ค่าเริ่มต้น 17)
- การแบ่งบรรทัดใหม่แบบตัวเลือก: ตั้งค่า `channels.discord.chunkMode="newline"` เพื่อแบ่งตามบรรทัดว่าง (ขอบเขตย่อหน้า) ก่อนการแบ่งตามความยาว
- รองรับการอัปโหลดไฟล์สูงสุดตาม `channels.discord.mediaMaxMb` ที่กำหนด (ค่าเริ่มต้น 8 MB)
- 2. การตอบกลับในกิลด์จะถูกจำกัดด้วยการกล่าวถึง (mention-gated) ตามค่าเริ่มต้น เพื่อหลีกเลี่ยงบ็อตที่ส่งเสียงรบกวน
- แทรกบริบทการตอบเมื่อข้อความอ้างอิงข้อความอื่น (เนื้อหาที่อ้าง + ids)
- การทำเธรดการตอบแบบเนทีฟ **ปิดโดยค่าเริ่มต้น**; เปิดด้วย `channels.discord.replyToMode` และแท็กการตอบ

## Retry policy

การเรียกDiscord APIขาออกจะรีทรายเมื่อถูกจำกัดอัตรา (429) โดยใช้ `retry_after` ของDiscordเมื่อมี พร้อมการถอยหลังแบบเอ็กซ์โปเนนเชียลและjitter กำหนดค่าผ่าน `channels.discord.retry` ดู [Retry policy](/concepts/retry) 3. กำหนดค่าผ่าน `channels.discord.retry` 4. ดู [Retry policy](/concepts/retry)

## Config

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

รีแอคชันยืนยัน(Ack)ถูกควบคุมทั่วทั้งระบบผ่าน `messages.ackReaction` +
`messages.ackReactionScope`. ใช้ `messages.removeAckAfterReply` เพื่อล้างรีแอคชันยืนยันหลังบอตตอบ

- `dm.enabled`: ตั้งค่า `false` เพื่อเพิกเฉยDMทั้งหมด (ค่าเริ่มต้น `true`)
- `dm.policy`: การควบคุมการเข้าถึงDM (`pairing` แนะนำ) `"open"` ต้องใช้ `dm.allowFrom=["*"]` 5. `"open"` ต้องการ `dm.allowFrom=["*"]`
- 6. `dm.allowFrom`: รายการอนุญาต DM (user id หรือชื่อผู้ใช้) 7. ใช้โดย `dm.policy="allowlist"` และสำหรับการตรวจสอบ `dm.policy="open"` 8. วิซาร์ดรับชื่อผู้ใช้และแปลงเป็น id เมื่อบ็อตสามารถค้นหาสมาชิกได้
- `dm.groupEnabled`: เปิดใช้งานgroup DM (ค่าเริ่มต้น `false`)
- `dm.groupChannels`: รายการอนุญาตเสริมสำหรับidหรือslugของช่องgroup DM
- `groupPolicy`: ควบคุมการจัดการช่องกิลด์ (`open|disabled|allowlist`) `allowlist` ต้องใช้รายการอนุญาตช่อง
- `guilds`: กฎรายกิลด์โดยคีย์เป็นguild id (แนะนำ) หรือslug
- `guilds."*"`: การตั้งค่ารายกิลด์ค่าเริ่มต้นเมื่อไม่มีรายการระบุชัด
- `guilds.<id>.slug`: slugที่เป็นมิตรต่อผู้ใช้สำหรับการแสดงผล (ไม่บังคับ)
- `guilds.<id>.users`: รายการอนุญาตผู้ใช้รายกิลด์ (idsหรือชื่อ) แบบตัวเลือก
- `guilds.<id>.tools`: การแทนที่นโยบายเครื่องมือรายกิลด์แบบตัวเลือก (`allow`/`deny`/`alsoAllow`) ใช้เมื่อไม่มีการแทนที่ระดับช่อง
- `guilds.<id>.toolsBySender`: การแทนที่นโยบายเครื่องมือรายผู้ส่งระดับกิลด์ (ใช้เมื่อไม่มีการแทนที่ระดับช่อง; รองรับ wildcard `"*"`)
- `guilds.<id>.channels.<channel>.allow`: อนุญาต/ปฏิเสธช่องเมื่อ `groupPolicy="allowlist"`
- `guilds.<id>.channels.<channel>.requireMention`: การบังคับกล่าวถึงสำหรับช่อง
- `guilds.<id>.channels.<channel>.tools`: การแทนที่นโยบายเครื่องมือรายช่องแบบตัวเลือก (`allow`/`deny`/`alsoAllow`)
- `guilds.<id>.channels.<channel>.toolsBySender`: การแทนที่นโยบายเครื่องมือรายผู้ส่งภายในช่องแบบตัวเลือก (รองรับ wildcard `"*"`)
- `guilds.<id>.channels.<channel>.users`: รายการอนุญาตผู้ใช้รายช่องแบบตัวเลือก
- `guilds.<id>.channels.<channel>.skills`: ตัวกรองskill (ละเว้น = ทุกskill, ว่าง = ไม่มี)
- `guilds.<id>.channels.<channel>9. `.systemPrompt\`: system prompt เพิ่มเติมสำหรับช่อง 10. หัวข้อช่องของ Discord จะถูกแทรกเป็นบริบท **ที่ไม่น่าเชื่อถือ** (ไม่ใช่ system prompt)
- `guilds.<id>.channels.<channel>.enabled`: ตั้งค่า `false` เพื่อปิดใช้งานช่อง
- `guilds.<id>.channels`: กฎช่อง (คีย์เป็นslugหรือidช่อง)
- `guilds.<id>.requireMention`: ข้อกำหนดการกล่าวถึงรายกิลด์ (แทนที่ได้รายช่อง)
- `guilds.<id>.reactionNotifications`: โหมดอีเวนต์ของระบบรีแอคชัน (`off`, `own`, `all`, `allowlist`)
- `textChunkLimit`: ขนาดการแบ่งข้อความขาออก (อักขระ) ค่าเริ่มต้น: 2000 11. ค่าเริ่มต้น: 2000
- `chunkMode`: `length` (ค่าเริ่มต้น) จะแบ่งเฉพาะเมื่อเกิน `textChunkLimit`; `newline` จะแบ่งตามบรรทัดว่างก่อนการแบ่งตามความยาว
- `maxLinesPerMessage`: จำนวนบรรทัดสูงสุดแบบนุ่มต่อข้อความ ค่าเริ่มต้น: 17 12. ค่าเริ่มต้น: 17
- `mediaMaxMb`: จำกัดสื่อขาเข้าที่บันทึกลงดิสก์
- `historyLimit`: จำนวนข้อความกิลด์ล่าสุดที่รวมเป็นบริบทเมื่อโต้ตอบการกล่าวถึง (ค่าเริ่มต้น 20; ถอยกลับไปที่ `messages.groupChat.historyLimit`; `0` ปิดใช้งาน)
- 13. `dmHistoryLimit`: ขีดจำกัดประวัติ DM ในจำนวนเทิร์นของผู้ใช้ `dmHistoryLimit`: ขีดจำกัดประวัติDMเป็นจำนวนเทิร์นผู้ใช้ การแทนที่รายผู้ใช้: `dms["<user_id>"].historyLimit`
- `retry`: นโยบายรีทรายสำหรับการเรียกDiscord APIขาออก (attempts, minDelayMs, maxDelayMs, jitter)
- `pluralkit`: แก้ไขข้อความที่ถูกพร็อกซีโดยPluralKitให้สมาชิกระบบปรากฏเป็นผู้ส่งที่แตกต่างกัน
- `actions`: ประตูเครื่องมือต่อการกระทำ; ละเว้นเพื่ออนุญาตทั้งหมด (ตั้งค่า `false` เพื่อปิดใช้งาน)
  - `reactions` (ครอบคลุม react + read reactions)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (สร้าง/แก้ไข/ลบช่อง + หมวดหมู่ + สิทธิ์)
  - `roles` (เพิ่ม/ลบบทบาท ค่าเริ่มต้น `false`)
  - `moderation` (timeout/kick/ban ค่าเริ่มต้น `false`)
  - `presence` (สถานะ/กิจกรรมบอต ค่าเริ่มต้น `false`)
- `execApprovals`: DMการอนุมัติการรันคำสั่งเฉพาะDiscord (UIปุ่ม) รองรับ `enabled`, `approvers`, `agentFilter`, `sessionFilter` 14. รองรับ `enabled`, `approvers`, `agentFilter`, `sessionFilter`

การแจ้งเตือนรีแอคชันใช้ `guilds.<id>.reactionNotifications`:

- `off`: ไม่มีอีเวนต์รีแอคชัน
- `own`: รีแอคชันบนข้อความของบอตเอง (ค่าเริ่มต้น)
- `all`: รีแอคชันทั้งหมดบนทุกข้อความ
- `allowlist`: รีแอคชันจาก `guilds.<id>.users` บนทุกข้อความ (รายการว่างจะปิดใช้งาน)

### PluralKit (PK) support

15. เปิดใช้งานการค้นหา PK เพื่อให้ข้อความที่ถูก proxy แก้ไขเป็นระบบ + สมาชิกตัวจริง
    เปิดใช้งานการค้นหาPKเพื่อให้ข้อความที่ถูกพร็อกซีถูกแก้ไขไปยังระบบ+สมาชิกที่แท้จริง
    เมื่อเปิดใช้งาน OpenClawจะใช้ตัวตนของสมาชิกสำหรับรายการอนุญาตและติดป้ายผู้ส่งเป็น
    `Member (PK:System)` เพื่อหลีกเลี่ยงการping Discordโดยไม่ตั้งใจ

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

หมายเหตุรายการอนุญาต (เมื่อเปิดPK):

- ใช้ `pk:<memberId>` ใน `dm.allowFrom`, `guilds.<id>.users`, หรือ `users` ระดับช่อง
- ชื่อแสดงของสมาชิกจะถูกจับคู่ตามชื่อ/slugด้วย
- การค้นหาใช้ **idข้อความDiscordดั้งเดิม** (ข้อความก่อนพร็อกซี) ดังนั้น APIของPKจะแก้ไขได้เฉพาะภายในหน้าต่าง 30 นาที
- หากการค้นหาPKล้มเหลว (เช่น ระบบส่วนตัวไม่มีโทเคน) ข้อความที่ถูกพร็อกซีจะถูกมองเป็นข้อความบอตและจะถูกทิ้ง เว้นแต่ `channels.discord.allowBots=true`

### Tool action defaults

| Action group   | Default  | Notes                                             |
| -------------- | -------- | ------------------------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList                |
| stickers       | enabled  | ส่งสติกเกอร์                                      |
| emojiUploads   | enabled  | 16. อัปโหลดอีโมจิ          |
| stickerUploads | enabled  | อัปโหลดสติกเกอร์                                  |
| polls          | enabled  | สร้างโพล                                          |
| permissions    | enabled  | สแน็ปช็อตสิทธิ์ช่อง                               |
| messages       | enabled  | อ่าน/ส่ง/แก้ไข/ลบ                                 |
| threads        | enabled  | สร้าง/แสดงรายการ/ตอบกลับ                          |
| pins           | enabled  | ปักหมุด/ยกเลิก/แสดงรายการ                         |
| search         | enabled  | ค้นหาข้อความ (ฟีเจอร์พรีวิว)   |
| memberInfo     | enabled  | ข้อมูลสมาชิก                                      |
| roleInfo       | enabled  | รายการบทบาท                                       |
| channelInfo    | enabled  | ข้อมูลช่อง + รายการ                               |
| channels       | enabled  | จัดการช่อง/หมวดหมู่                               |
| voiceStatus    | enabled  | ตรวจสอบสถานะเสียง                                 |
| events         | enabled  | แสดงรายการ/สร้างอีเวนต์ที่ตั้งเวลา                |
| roles          | disabled | เพิ่ม/ลบบทบาท                                     |
| moderation     | disabled | Timeout/kick/ban                                  |
| presence       | disabled | สถานะ/กิจกรรมบอต (setPresence) |

- `replyToMode`: `off` (ค่าเริ่มต้น), `first`, หรือ `all`. ใช้เฉพาะเมื่อโมเดลมีแท็กการตอบกลับ

## Reply tags

เพื่อขอการตอบแบบเธรด โมเดลสามารถใส่แท็กหนึ่งรายการในเอาต์พุตได้:

- `[[reply_to_current]]` — ตอบกลับข้อความDiscordที่เป็นตัวกระตุ้น
- `[[reply_to:<id>]]` — ตอบกลับข้อความตามidที่ระบุจากบริบท/ประวัติ
  idข้อความปัจจุบันจะถูกต่อท้ายพรอมป์ต์เป็น `[message_id: …]`; รายการประวัติมีidอยู่แล้ว
  17. id ของข้อความปัจจุบันจะถูกต่อท้ายใน prompt เป็น `[message_id: …]`; รายการประวัติมี id รวมอยู่แล้ว

พฤติกรรมถูกควบคุมโดย `channels.discord.replyToMode`:

- `off`: เพิกเฉยแท็ก
- `first`: เฉพาะชิ้นเอาต์พุต/ไฟล์แนบแรกเป็นการตอบกลับ
- `all`: ทุกชิ้นเอาต์พุต/ไฟล์แนบเป็นการตอบกลับ

หมายเหตุการจับคู่รายการอนุญาต:

- `allowFrom`/`users`/`groupChannels` รับid ชื่อ แท็ก หรือการกล่าวถึงเช่น `<@id>`
- รองรับคำนำหน้าเช่น `discord:`/`user:` (ผู้ใช้) และ `channel:` (group DM)
- ใช้ `*` เพื่ออนุญาตผู้ส่ง/ช่องใดก็ได้
- เมื่อมี `guilds.<id>.channels` ช่องที่ไม่อยู่ในรายการจะถูกปฏิเสธโดยค่าเริ่มต้น
- เมื่อไม่ระบุ `guilds.<id>.channels` ช่องทั้งหมดในกิลด์ที่อยู่ในรายการอนุญาตจะได้รับอนุญาต
- หากต้องการอนุญาต **ไม่มีช่องใดเลย** ให้ตั้งค่า `channels.discord.groupPolicy: "disabled"` (หรือคงรายการอนุญาตว่าง)
- ตัวช่วยตั้งค่ารับชื่อ `Guild/Channel` (สาธารณะ + ส่วนตัว) และแปลงเป็นIDเมื่อเป็นไปได้
- เมื่อเริ่มต้น OpenClawจะแปลงชื่อช่อง/ผู้ใช้ในรายการอนุญาตเป็นID (เมื่อบอตค้นหาสมาชิกได้) และบันทึกการแม็ป รายการที่แปลงไม่ได้จะคงไว้ตามที่พิมพ์

หมายเหตุคำสั่งเนทีฟ:

- คำสั่งที่ลงทะเบียนสะท้อนคำสั่งแชตของOpenClaw
- คำสั่งเนทีฟเคารพรายการอนุญาตเดียวกับDM/ข้อความกิลด์ (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, กฎรายช่อง)
- Slash commands อาจยังมองเห็นได้ในUIของDiscordสำหรับผู้ใช้ที่ไม่ได้อยู่ในรายการอนุญาต; OpenClawจะบังคับใช้รายการอนุญาตเมื่อรันและตอบว่า “not authorized”

## Tool actions

เอเจนต์สามารถเรียก `discord` ด้วยการกระทำเช่น:

- `react` / `reactions` (เพิ่มหรือแสดงรายการรีแอคชัน)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- เพย์โหลดเครื่องมืออ่าน/ค้นหา/ปักหมุดจะรวม `timestampMs` (UTC epoch ms) และ `timestampUtc` ที่ถูกทำให้เป็นมาตรฐาน ควบคู่กับ `timestamp` ของDiscordแบบดิบ
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (กิจกรรมบอตและสถานะออนไลน์)

idข้อความDiscordจะถูกเปิดเผยในบริบทที่แทรก (`[discord message id: …]` และบรรทัดประวัติ) เพื่อให้เอเจนต์กำหนดเป้าหมายได้
อีโมจิสามารถเป็นยูนิโค้ด (เช่น `✅`) หรือไวยากรณ์อีโมจิแบบกำหนดเองเช่น `<:party_blob:1234567890>`.
18. อีโมจิอาจเป็นยูนิโค้ด (เช่น `✅`) หรือไวยากรณ์อีโมจิแบบกำหนดเอง เช่น `<:party_blob:1234567890>`

## Safety & ops

- ปฏิบัติต่อโทเคนบอตเหมือนรหัสผ่าน; แนะนำให้ใช้env var `DISCORD_BOT_TOKEN` บนโฮสต์ที่มีการดูแล หรือจำกัดสิทธิ์ไฟล์คอนฟิก
- ให้สิทธิ์บอตเท่าที่จำเป็นเท่านั้น (โดยทั่วไปคือ Read/Send Messages)
- หากบอตค้างหรือถูกจำกัดอัตรา ให้รีสตาร์ตGateway (`openclaw gateway --force`) หลังยืนยันว่าไม่มีโปรเซสอื่นครอบครองเซสชันDiscord
