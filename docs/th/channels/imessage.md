---
summary: "รองรับ iMessage แบบเดิมผ่าน imsg (JSON-RPC ผ่าน stdio) การตั้งค่าใหม่ควรใช้ BlueBubbles การตั้งค่าใหม่ควรใช้ BlueBubbles"
read_when:
  - การตั้งค่าการรองรับ iMessage
  - การดีบักการส่ง/รับ iMessage
title: iMessage
---

# iMessage (legacy: imsg)

> **แนะนำ:** ใช้ [BlueBubbles](/channels/bluebubbles) สำหรับการตั้งค่า iMessage ใหม่
>
> ช่องทาง `imsg` เป็นการผสานรวม CLI ภายนอกแบบเดิม และอาจถูกนำออกในรีลีสอนาคต

สถานะ: การผสานรวม CLI ภายนอกแบบเดิม สถานะ: การผสานรวม CLI ภายนอกแบบเดิม Gateway สร้าง `imsg rpc` (JSON-RPC ผ่าน stdio)

## Quick setup (beginner)

1. ตรวจสอบให้แน่ใจว่า Messages ได้ลงชื่อเข้าใช้บน Mac เครื่องนี้แล้ว
2. ติดตั้ง `imsg`:
   - `brew install steipete/tap/imsg`
3. กำหนดค่า OpenClaw ด้วย `channels.imessage.cliPath` และ `channels.imessage.dbPath`
4. เริ่มต้น Gateway และอนุมัติพรอมป์ของ macOS ทั้งหมด (Automation + Full Disk Access)

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## What it is

- ช่องทาง iMessage ที่ทำงานบน `imsg` บน macOS
- การกำหนดเส้นทางแบบกำหนดแน่นอน: การตอบกลับจะกลับไปที่ iMessage เสมอ
- DMs ใช้เซสชันหลักของเอเจนต์ร่วมกัน; กลุ่มจะแยกออก (`agent:<agentId>:imessage:group:<chat_id>`)
- หากเธรดที่มีผู้เข้าร่วมหลายคนเข้ามาพร้อมกับ `is_group=false` คุณยังสามารถแยกได้โดย `chat_id` ด้วยการใช้ `channels.imessage.groups` (ดู “Group-ish threads” ด้านล่าง)

## Config writes

โดยค่าเริ่มต้น iMessage ได้รับอนุญาตให้เขียนการอัปเดตคอนฟิกที่ถูกกระตุ้นโดย `/config set|unset` (ต้องใช้ `commands.config: true`)

ปิดใช้งานด้วย:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Requirements

- macOS ที่ลงชื่อเข้าใช้ Messages แล้ว
- Full Disk Access สำหรับ OpenClaw + `imsg` (การเข้าถึงฐานข้อมูล Messages)
- สิทธิ์ Automation เมื่อส่งข้อความ
- `channels.imessage.cliPath` สามารถชี้ไปยังคำสั่งใดก็ได้ที่พร็อกซี stdin/stdout (เช่น สคริปต์ wrapper ที่ SSH ไปยัง Mac เครื่องอื่นและรัน `imsg rpc`)

## Troubleshooting macOS Privacy and Security TCC

หากการส่ง/รับล้มเหลว (เช่น `imsg rpc` ออกด้วยโค้ดไม่เป็นศูนย์ หมดเวลา หรือ Gateway ดูเหมือนค้าง) สาเหตุที่พบบ่อยคือพรอมป์สิทธิ์ของ macOS ที่ไม่เคยได้รับการอนุมัติ

macOS ให้สิทธิ์ TCC ตามบริบทของแอป/โปรเซส macOS ให้สิทธิ์ TCC ต่อแอป/บริบทของโปรเซส อนุมัติพรอมป์ในบริบทเดียวกับที่รัน `imsg` (เช่น Terminal/iTerm เซสชัน LaunchAgent หรือโปรเซสที่เรียกผ่าน SSH)

เช็กลิสต์:

- **Full Disk Access**: อนุญาตให้เข้าถึงสำหรับโปรเซสที่รัน OpenClaw (และ wrapper shell/SSH ใดๆ ที่เรียก `imsg`) จำเป็นสำหรับการอ่านฐานข้อมูล Messages (`chat.db`) สิ่งนี้จำเป็นสำหรับการอ่านฐานข้อมูล Messages (`chat.db`)
- **Automation → Messages**: อนุญาตให้โปรเซสที่รัน OpenClaw (และ/หรือเทอร์มินัลของคุณ) ควบคุม **Messages.app** สำหรับการส่งออก
- **`imsg` CLI health**: ตรวจสอบว่าได้ติดตั้ง `imsg` แล้วและรองรับ RPC (`imsg rpc --help`)

เคล็ดลับ: หาก OpenClaw รันแบบไม่มีหน้าจอ (LaunchAgent/systemd/SSH) พรอมป์ของ macOS อาจมองไม่เห็น ให้รันคำสั่งเชิงโต้ตอบหนึ่งครั้งในเทอร์มินัลแบบ GUI เพื่อบังคับให้ขึ้นพรอมป์ จากนั้นลองใหม่: Run a one-time interactive command in a GUI terminal to force the prompt, then retry:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

โฟลเดอร์สิทธิ์ที่เกี่ยวข้องของ macOS (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions)

## Setup (fast path)

1. ตรวจสอบให้แน่ใจว่า Messages ได้ลงชื่อเข้าใช้บน Mac เครื่องนี้แล้ว
2. กำหนดค่า iMessage และเริ่มต้น Gateway

### Dedicated bot macOS user (for isolated identity)

หากต้องการให้บอตส่งจาก **ตัวตน iMessage แยกต่างหาก** (และทำให้ Messages ส่วนตัวของคุณสะอาด) ให้ใช้ Apple ID เฉพาะ + ผู้ใช้ macOS เฉพาะ

1. สร้าง Apple ID เฉพาะ (ตัวอย่าง: `my-cool-bot@icloud.com`)
   - Apple อาจต้องการหมายเลขโทรศัพท์สำหรับการยืนยัน/2FA
2. สร้างผู้ใช้ macOS (ตัวอย่าง: `openclawhome`) และลงชื่อเข้าใช้
3. เปิด Messages ในผู้ใช้ macOS นั้นและลงชื่อเข้าใช้ iMessage ด้วย Apple ID ของบอต
4. เปิดใช้งาน Remote Login (System Settings → General → Sharing → Remote Login)
5. ติดตั้ง `imsg`:
   - `brew install steipete/tap/imsg`
6. ตั้งค่า SSH ให้ `ssh <bot-macos-user>@localhost true` ทำงานได้โดยไม่ต้องใช้รหัสผ่าน
7. ชี้ `channels.imessage.accounts.bot.cliPath` ไปยัง wrapper SSH ที่รัน `imsg` ในฐานะผู้ใช้บอต

First-run note: sending/receiving may require GUI approvals (Automation + Full Disk Access) in the _bot macOS user_. หาก `imsg rpc` ดูเหมือนค้างหรือออก ให้ล็อกอินเป็นผู้ใช้นั้น (การแชร์หน้าจอช่วยได้) รันคำสั่งครั้งเดียว `imsg chats --limit 1` / `imsg send ...` อนุมัติพรอมต์ แล้วลองใหม่ ดู [Troubleshooting macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc)

ตัวอย่าง wrapper (`chmod +x`) ตัวอย่าง wrapper (`chmod +x`) แทนที่ `<bot-macos-user>` ด้วยชื่อผู้ใช้ macOS จริงของคุณ:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

ตัวอย่างคอนฟิก:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

สำหรับการตั้งค่าแบบบัญชีเดียว ให้ใช้ตัวเลือกแบบแบน (`channels.imessage.cliPath`, `channels.imessage.dbPath`) แทนแผนที่ `accounts`

### Remote/SSH variant (optional)

หากต้องการ iMessage บน Mac เครื่องอื่น ให้ตั้งค่า `channels.imessage.cliPath` ไปยัง wrapper ที่รัน `imsg` บนโฮสต์ macOS ระยะไกลผ่าน SSH OpenClaw ต้องการเพียง stdio เท่านั้น OpenClaw ต้องการเพียง stdio

ตัวอย่าง wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**ไฟล์แนบระยะไกล:** เมื่อ `cliPath` ชี้ไปยังโฮสต์ระยะไกลผ่าน SSH พาธไฟล์แนบในฐานข้อมูล Messages จะอ้างอิงไฟล์บนเครื่องระยะไกล OpenClaw สามารถดึงไฟล์เหล่านี้ผ่าน SCP อัตโนมัติได้โดยตั้งค่า `channels.imessage.remoteHost`: OpenClaw สามารถดึงข้อมูลเหล่านี้โดยอัตโนมัติผ่าน SCP ได้โดยตั้งค่า `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

หากไม่ได้ตั้งค่า `remoteHost` OpenClaw จะพยายามตรวจจับอัตโนมัติโดยการพาร์สคำสั่ง SSH ในสคริปต์ wrapper ของคุณ แนะนำให้กำหนดค่าแบบชัดเจนเพื่อความเสถียร แนะนำให้กำหนดค่าชัดเจนเพื่อความเชื่อถือได้

#### Remote Mac via Tailscale (example)

หาก Gateway รันบนโฮสต์/VM Linux แต่ iMessage ต้องรันบน Mac, Tailscale เป็นสะพานที่ง่ายที่สุด: Gateway ติดต่อ Mac ผ่าน tailnet รัน `imsg` ผ่าน SSH และ SCP ไฟล์แนบกลับมา

สถาปัตยกรรม:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

ตัวอย่างคอนฟิกแบบเป็นรูปธรรม (ชื่อโฮสต์ Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

ตัวอย่าง wrapper (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

หมายเหตุ:

- ตรวจสอบให้แน่ใจว่า Mac ลงชื่อเข้าใช้ Messages แล้ว และเปิดใช้งาน Remote Login
- ใช้คีย์ SSH เพื่อให้ `ssh bot@mac-mini.tailnet-1234.ts.net` ทำงานได้โดยไม่มีพรอมป์
- `remoteHost` ควรตรงกับเป้าหมาย SSH เพื่อให้ SCP ดึงไฟล์แนบได้

การรองรับหลายบัญชี: ใช้ `channels.imessage.accounts` พร้อมคอนฟิกต่อบัญชีและ `name` แบบไม่บังคับ ดู [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) สำหรับรูปแบบร่วมกัน อย่าคอมมิต `~/.openclaw/openclaw.json` (มักมีโทเคน) รองรับหลายบัญชี: ใช้ `channels.telegram.accounts` พร้อมโทเคนต่อบัญชี และ `name` (ไม่บังคับ) ดู [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) สำหรับรูปแบบที่ใช้ร่วมกัน อย่าคอมมิต `~/.openclaw/openclaw.json` (มักมีโทเคนอยู่)

## Access control (DMs + groups)

DMs:

- ค่าเริ่มต้น: `channels.imessage.dmPolicy = "pairing"`
- ผู้ส่งที่ไม่รู้จักจะได้รับโค้ดจับคู่; ข้อความจะถูกละเลยจนกว่าจะอนุมัติ (โค้ดหมดอายุภายใน 1 ชั่วโมง)
- อนุมัติผ่าน:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- การจับคู่เป็นการแลกเปลี่ยนโทเคนเริ่มต้นสำหรับ iMessage DMs รายละเอียด: [Pairing](/channels/pairing) การจับคู่เป็นการแลกเปลี่ยนโทเคนเริ่มต้น รายละเอียด: [Pairing](/channels/pairing)

Groups:

- `channels.imessage.groupPolicy = open | allowlist | disabled`
- `channels.imessage.groupAllowFrom` ควบคุมว่าใครสามารถกระตุ้นในกลุ่มเมื่อมีการตั้งค่า `allowlist`
- การกำหนดเงื่อนไขด้วยการกล่าวถึงใช้ `agents.list[].groupChat.mentionPatterns` (หรือ `messages.groupChat.mentionPatterns`) เนื่องจาก iMessage ไม่มีเมตาดาทาการกล่าวถึงแบบเนทีฟ
- การแทนที่แบบหลายเอเจนต์: ตั้งค่าแพตเทิร์นต่อเอเจนต์บน `agents.list[].groupChat.mentionPatterns`

## How it works (behavior)

- `imsg` สตรีมอีเวนต์ข้อความ; Gateway จะปรับให้เป็นซองข้อมูลช่องทางที่ใช้ร่วมกัน
- การตอบกลับจะถูกส่งกลับไปยัง chat id หรือ handle เดิมเสมอ

## Group-ish threads (`is_group=false`)

เธรด iMessage บางรายการอาจมีผู้เข้าร่วมหลายคน แต่ยังคงเข้ามาพร้อมกับ `is_group=false` ทั้งนี้ขึ้นอยู่กับวิธีที่ Messages จัดเก็บตัวระบุแชต

หากคุณกำหนดค่า `chat_id` ภายใต้ `channels.imessage.groups` อย่างชัดเจน OpenClaw จะปฏิบัติต่อเธรดนั้นเป็น “กลุ่ม” สำหรับ:

- การแยกเซสชัน (คีย์เซสชัน `agent:<agentId>:imessage:group:<chat_id>` แยกต่างหาก)
- พฤติกรรม allowlist ของกลุ่ม / การกำหนดเงื่อนไขด้วยการกล่าวถึง

ตัวอย่าง:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

มีประโยชน์เมื่อคุณต้องการบุคลิก/โมเดลที่แยกสำหรับเธรดเฉพาะ (ดู [Multi-agent routing](/concepts/multi-agent)) สำหรับการแยกระบบไฟล์ ดู [Sandboxing](/gateway/sandboxing) สำหรับการแยกระบบไฟล์ ดู [Sandboxing](/gateway/sandboxing)

## Media + limits

- การนำเข้าไฟล์แนบแบบไม่บังคับผ่าน `channels.imessage.includeAttachments`
- เพดานสื่อผ่าน `channels.imessage.mediaMaxMb`

## Limits

- ข้อความขาออกถูกแบ่งเป็นชิ้นตาม `channels.imessage.textChunkLimit` (ค่าเริ่มต้น 4000)
- การแบ่งตามบรรทัดใหม่แบบไม่บังคับ: ตั้งค่า `channels.imessage.chunkMode="newline"` เพื่อแบ่งตามบรรทัดว่าง (ขอบเขตย่อหน้า) ก่อนการแบ่งตามความยาว
- การอัปโหลดสื่อถูกจำกัดโดย `channels.imessage.mediaMaxMb` (ค่าเริ่มต้น 16)

## Addressing / delivery targets

ควรใช้ `chat_id` เพื่อการกำหนดเส้นทางที่เสถียร:

- `chat_id:123` (แนะนำ)
- `chat_guid:...`
- `chat_identifier:...`
- แฮนเดิลโดยตรง: `imessage:+1555` / `sms:+1555` / `user@example.com`

แสดงรายการแชต:

```
imsg chats --limit 20
```

## Configuration reference (iMessage)

คอนฟิกเต็มรูปแบบ: [Configuration](/gateway/configuration)

ตัวเลือกผู้ให้บริการ:

- `channels.imessage.enabled`: เปิด/ปิดการเริ่มต้นช่องทาง
- `channels.imessage.cliPath`: พาธไปยัง `imsg`
- `channels.imessage.dbPath`: พาธฐานข้อมูล Messages
- `channels.imessage.remoteHost`: โฮสต์ SSH สำหรับการถ่ายโอนไฟล์แนบผ่าน SCP เมื่อ `cliPath` ชี้ไปยัง Mac ระยะไกล (เช่น `user@gateway-host`) ตรวจจับอัตโนมัติจาก wrapper SSH หากไม่ตั้งค่า Auto-detected from SSH wrapper if not set.
- `channels.imessage.service`: `imessage | sms | auto`
- `channels.imessage.region`: ภูมิภาค SMS
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (ค่าเริ่มต้น: pairing)
- `channels.imessage.allowFrom`: allowlist สำหรับ DM (แฮนเดิล อีเมล หมายเลข E.164 หรือ `chat_id:*`) `open` ต้องใช้ `"*"` iMessage ไม่มีชื่อผู้ใช้ ให้ใช้แฮนเดิลหรือเป้าหมายแชต `open` ต้องใช้ `"*"`. iMessage has no usernames; use handles or chat targets.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (ค่าเริ่มต้น: allowlist)
- `channels.imessage.groupAllowFrom`: allowlist ผู้ส่งในกลุ่ม
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: จำนวนข้อความกลุ่มสูงสุดที่จะรวมเป็นบริบท (ตั้งค่า 0 เพื่อปิด)
- `channels.imessage.dmHistoryLimit`: ขีดจำกัดประวัติ DM เป็นจำนวนเทิร์นของผู้ใช้ การแทนที่ต่อผู้ใช้: `channels.imessage.dms["<handle>"].historyLimit` `channels.signal.dmHistoryLimit`: ขีดจำกัดประวัติ DM ในรอบผู้ใช้ การเขียนทับต่อผู้ใช้: `channels.imessage.dms["<handle>"].historyLimit`
- `channels.imessage.groups`: ค่าเริ่มต้นต่อกลุ่ม + allowlist (ใช้ `"*"` สำหรับค่าเริ่มต้นส่วนกลาง)
- `channels.imessage.includeAttachments`: นำไฟล์แนบเข้าสู่บริบท
- `channels.imessage.mediaMaxMb`: เพดานสื่อขาเข้า/ขาออก (MB)
- `channels.imessage.textChunkLimit`: ขนาดการแบ่งข้อความขาออก (อักขระ)
- `channels.imessage.chunkMode`: `length` (ค่าเริ่มต้น) หรือ `newline` เพื่อแบ่งตามบรรทัดว่าง (ขอบเขตย่อหน้า) ก่อนการแบ่งตามความยาว

ตัวเลือกส่วนกลางที่เกี่ยวข้อง:

- `agents.list[].groupChat.mentionPatterns` (หรือ `messages.groupChat.mentionPatterns`)
- `messages.responsePrefix`
