---
summary: "การกำหนดค่าและการตั้งค่าบอตแชท Twitch"
read_when:
  - การตั้งค่าการผสานรวมแชท Twitch สำหรับ OpenClaw
title: "Twitch"
---

# Twitch (ปลั๊กอิน)

Twitch chat support via IRC connection. รองรับแชท Twitch ผ่านการเชื่อมต่อ IRC โดย OpenClaw จะเชื่อมต่อในฐานะผู้ใช้ Twitch (บัญชีบอต) เพื่อรับและส่งข้อความในช่องทางต่างๆ

## Plugin required

Twitch ถูกจัดส่งมาในรูปแบบปลั๊กอินและไม่ได้รวมมากับการติดตั้งแกนหลัก

ติดตั้งผ่าน CLI (npm registry):

```bash
openclaw plugins install @openclaw/twitch
```

เช็คเอาต์แบบโลคอล (เมื่อรันจาก git repo):

```bash
openclaw plugins install ./extensions/twitch
```

รายละเอียด: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. สร้างบัญชี Twitch แยกสำหรับบอต (หรือใช้บัญชีที่มีอยู่)
2. สร้างข้อมูลรับรอง: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - เลือก **Bot Token**
   - ตรวจสอบว่าสcope `chat:read` และ `chat:write` ถูกเลือก
   - คัดลอก **Client ID** และ **Access Token**
3. ค้นหา Twitch user ID ของคุณ: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. กำหนดค่าโทเคน:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (เฉพาะบัญชีค่าเริ่มต้น)
   - หรือคอนฟิก: `channels.twitch.accessToken`
   - หากตั้งค่าทั้งสองแบบ คอนฟิกจะมีลำดับความสำคัญสูงกว่า (env ใช้เป็นค่า fallback สำหรับบัญชีค่าเริ่มต้นเท่านั้น)
5. เริ่มต้น Gateway

**⚠️ สำคัญ:** เพิ่มการควบคุมการเข้าถึง (`allowFrom` หรือ `allowedRoles`) เพื่อป้องกันผู้ใช้ที่ไม่ได้รับอนุญาตสั่งงานบอต ค่าเริ่มต้นของ `requireMention` คือ `true`. `requireMention` defaults to `true`.

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## What it is

- ช่องทาง Twitch ที่เป็นเจ้าของโดย Gateway
- การกำหนดเส้นทางแบบกำหนดแน่นอน: การตอบกลับจะกลับไปที่ Twitch เสมอ
- แต่ละบัญชีจะเชื่อมโยงกับคีย์เซสชันที่แยกจากกัน `agent:<agentId>:twitch:<accountName>`
- `username` คือบัญชีของบอต (ที่ใช้ยืนยันตัวตน) ส่วน `channel` คือห้องแชทที่จะเข้าร่วม

## Setup (detailed)

### Generate credentials

ใช้ [Twitch Token Generator](https://twitchtokengenerator.com/):

- เลือก **Bot Token**
- ตรวจสอบว่าสcope `chat:read` และ `chat:write` ถูกเลือก
- คัดลอก **Client ID** และ **Access Token**

No manual app registration needed. Tokens expire after several hours.

### Configure the bot

**Env var (เฉพาะบัญชีค่าเริ่มต้น):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**หรือคอนฟิก:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

หากตั้งค่าทั้ง env และคอนฟิก คอนฟิกจะมีลำดับความสำคัญสูงกว่า

### Access control (recommended)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefer `allowFrom` for a hard allowlist. แนะนำให้ใช้ `allowFrom` สำหรับ allowlist แบบเข้มงวด หากต้องการควบคุมการเข้าถึงตามบทบาท ให้ใช้ `allowedRoles` แทน

**บทบาทที่รองรับ:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**ทำไมต้องใช้ user ID?** ชื่อผู้ใช้สามารถเปลี่ยนได้ ทำให้เกิดการสวมรอยได้ แต่ user ID เป็นค่าถาวร User IDs are permanent.

ค้นหา Twitch user ID ของคุณ: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (แปลงชื่อผู้ใช้ Twitch เป็น ID)

## Token refresh (optional)

โทเคนจาก [Twitch Token Generator](https://twitchtokengenerator.com/) ไม่สามารถรีเฟรชอัตโนมัติได้ ต้องสร้างใหม่เมื่อหมดอายุ

หากต้องการรีเฟรชโทเคนอัตโนมัติ ให้สร้างแอป Twitch ของคุณเองที่ [Twitch Developer Console](https://dev.twitch.tv/console) และเพิ่มลงในคอนฟิก:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

บอตจะรีเฟรชโทเคนโดยอัตโนมัติก่อนหมดอายุ และบันทึกอีเวนต์การรีเฟรชลงในล็อก

## Multi-account support

Use `channels.twitch.accounts` with per-account tokens. ใช้ `channels.twitch.accounts` พร้อมโทเคนแยกต่อบัญชี ดู [`gateway/configuration`](/gateway/configuration) สำหรับรูปแบบที่ใช้ร่วมกัน

ตัวอย่าง (หนึ่งบัญชีบอตในสองช่องทาง):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**หมายเหตุ:** แต่ละบัญชีต้องมีโทเคนของตนเอง (หนึ่งโทเคนต่อหนึ่งช่องทาง)

## Access control

### Role-based restrictions

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Allowlist by User ID (most secure)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Role-based access (alternative)

`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
`allowFrom` เป็น allowlist แบบเข้มงวด เมื่อกำหนดค่าแล้ว จะอนุญาตเฉพาะ user ID เหล่านั้นเท่านั้น  
หากต้องการการเข้าถึงตามบทบาท ให้เว้น `allowFrom` ไว้ไม่ตั้งค่า และกำหนดค่า `allowedRoles` แทน:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Disable @mention requirement

โดยค่าเริ่มต้น `requireMention` คือ `true` หากต้องการปิดและให้ตอบทุกข้อความ: To disable and respond to all messages:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Troubleshooting

ก่อนอื่น ให้รันคำสั่งวินิจฉัย:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot doesn't respond to messages

**ตรวจสอบการควบคุมการเข้าถึง:** ตรวจสอบให้แน่ใจว่า user ID ของคุณอยู่ใน `allowFrom` หรือเอา `allowFrom` ออกชั่วคราวและตั้งค่า `allowedRoles: ["all"]` เพื่อทดสอบ

**ตรวจสอบว่าบอตอยู่ในช่องทางแล้ว:** บอตต้องเข้าร่วมช่องทางที่ระบุใน `channel`

### Token issues

**"Failed to connect" หรือข้อผิดพลาดในการยืนยันตัวตน:**

- ตรวจสอบว่า `accessToken` เป็นค่า OAuth access token (โดยทั่วไปจะขึ้นต้นด้วยพรีฟิกซ์ `oauth:`)
- ตรวจสอบว่าโทเคนมี scope `chat:read` และ `chat:write`
- หากใช้การรีเฟรชโทเคน ตรวจสอบว่า `clientSecret` และ `refreshToken` ถูกตั้งค่าแล้ว

### Token refresh not working

**ตรวจสอบล็อกสำหรับอีเวนต์การรีเฟรช:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

หากเห็นข้อความ "token refresh disabled (no refresh token)":

- ตรวจสอบให้แน่ใจว่าได้ระบุ `clientSecret`
- ตรวจสอบให้แน่ใจว่าได้ระบุ `refreshToken`

## Config

**Account config:**

- `username` - ชื่อผู้ใช้ของบอต
- `accessToken` - OAuth access token พร้อม scope `chat:read` และ `chat:write`
- `clientId` - Twitch Client ID (จาก Token Generator หรือจากแอปของคุณ)
- `channel` - ช่องทางที่จะเข้าร่วม (จำเป็น)
- `enabled` - เปิดใช้งานบัญชีนี้ (ค่าเริ่มต้น: `true`)
- `clientSecret` - ไม่บังคับ: สำหรับการรีเฟรชโทเคนอัตโนมัติ
- `refreshToken` - ไม่บังคับ: สำหรับการรีเฟรชโทเคนอัตโนมัติ
- `expiresIn` - อายุโทเคนเป็นวินาที
- `obtainmentTimestamp` - เวลาที่ได้รับโทเคน
- `allowFrom` - allowlist ของ user ID
- `allowedRoles` - การควบคุมการเข้าถึงตามบทบาท (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - ต้องการ @mention (ค่าเริ่มต้น: `true`)

**Provider options:**

- `channels.twitch.enabled` - เปิด/ปิดการเริ่มต้นช่องทาง
- `channels.twitch.username` - ชื่อผู้ใช้บอต (คอนฟิกแบบบัญชีเดียวอย่างง่าย)
- `channels.twitch.accessToken` - OAuth access token (คอนฟิกแบบบัญชีเดียวอย่างง่าย)
- `channels.twitch.clientId` - Twitch Client ID (คอนฟิกแบบบัญชีเดียวอย่างง่าย)
- `channels.twitch.channel` - ช่องทางที่จะเข้าร่วม (คอนฟิกแบบบัญชีเดียวอย่างง่าย)
- `channels.twitch.accounts.<accountName>` - คอนฟิกหลายบัญชี (รวมทุกฟิลด์บัญชีด้านบน)

ตัวอย่างแบบเต็ม:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Tool actions

เอเจนต์สามารถเรียก `twitch` พร้อมแอ็กชัน:

- `send` - ส่งข้อความไปยังช่องทาง

ตัวอย่าง:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Safety & ops

- **ปฏิบัติต่อโทเคนเหมือนรหัสผ่าน** - ห้ามคอมมิตโทเคนลง git
- **ใช้การรีเฟรชโทเคนอัตโนมัติ** สำหรับบอตที่ทำงานระยะยาว
- **ใช้ allowlist ของ user ID** แทนชื่อผู้ใช้เพื่อการควบคุมการเข้าถึง
- **เฝ้าติดตามล็อก** สำหรับอีเวนต์การรีเฟรชโทเคนและสถานะการเชื่อมต่อ
- **จำกัด scope ของโทเคนให้น้อยที่สุด** - ขอเฉพาะ `chat:read` และ `chat:write`
- **หากติดขัด**: รีสตาร์ท Gateway หลังจากยืนยันว่าไม่มีโปรเซสอื่นครอบครองเซสชันอยู่

## Limits

- **500 ตัวอักษร** ต่อข้อความ (แบ่งอัตโนมัติที่ขอบเขตคำ)
- Markdown จะถูกลบออกก่อนการแบ่งข้อความ
- ไม่มีการจำกัดอัตรา (ใช้การจำกัดอัตราที่มีอยู่ใน Twitch)
