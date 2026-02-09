---
summary: "การตั้งค่า Slack สำหรับโหมด Socket หรือ HTTP webhook"
read_when: "การตั้งค่า Slack หรือการดีบักโหมด Socket/HTTP ของ Slack"
title: "Slack"
---

# Slack

## โหมด Socket (ค่าเริ่มต้น)

### ตั้งค่าอย่างรวดเร็ว(ผู้เริ่มต้น)

1. สร้างแอป Slack และเปิดใช้งาน **Socket Mode**
2. สร้าง **App Token** (`xapp-...`) และ **Bot Token** (`xoxb-...`)
3. ตั้งค่าโทเคนสำหรับ OpenClaw และเริ่ม Gateway

คอนฟิกขั้นต่ำ:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### การตั้งค่า

1. สร้างแอป Slack (From scratch) ที่ [https://api.slack.com/apps](https://api.slack.com/apps)
2. **Socket Mode** → เปิดใช้งาน **Socket Mode** → เปิดสวิตช์ จากนั้นไปที่ **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** พร้อมสโคป `connections:write` คัดลอก **App Token** (`xapp-...`) คัดลอก **App Token** (`xapp-...`)
3. **OAuth & Permissions** → เพิ่ม bot token scopes (ใช้แมนิฟेस्टด้านล่าง) คลิก **Install to Workspace** คัดลอก **Bot User OAuth Token** (`xoxb-...`) คลิก **Install to Workspace** 1. คัดลอก **Bot User OAuth Token** (`xoxb-...`).
4. ไม่บังคับ: **OAuth & Permissions** → เพิ่ม **User Token Scopes** (ดูรายการอ่านอย่างเดียวด้านล่าง) ติดตั้งแอปใหม่และคัดลอก **User OAuth Token** (`xoxp-...`) 2. ติดตั้งแอปใหม่และคัดลอก **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → เปิดใช้งานอีเวนต์และสมัครรับ:
   - `message.*` (รวมการแก้ไข/ลบ/การกระจายเธรด)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. เชิญบอตเข้าไปในช่องที่ต้องการให้บอตอ่าน
7. 3. Slash Commands → สร้าง `/openclaw` หากคุณใช้ `channels.slack.slashCommand`. 4. หากคุณเปิดใช้คำสั่งแบบเนทีฟ ให้เพิ่ม slash command หนึ่งรายการต่อคำสั่งที่มีมาให้ (ใช้ชื่อเดียวกับ `/help`). Slash Commands → สร้าง `/openclaw` หากใช้ `channels.slack.slashCommand` หากเปิดใช้คำสั่งแบบเนทีฟ ให้เพิ่มหนึ่ง slash command ต่อคำสั่งที่มีมาให้ (ใช้ชื่อเดียวกับ `/help`) ค่าเริ่มต้นของเนทีฟสำหรับ Slack คือปิด เว้นแต่จะตั้งค่า `channels.slack.commands.native: true` (ค่า `commands.native` ระดับ global คือ `"auto"` ซึ่งจะปิด Slack)
8. App Home → เปิด **Messages Tab** เพื่อให้ผู้ใช้ส่ง DM ถึงบอตได้

ใช้แมนิฟেস্টด้านล่างเพื่อให้สโคปและอีเวนต์สอดคล้องกัน

รองรับหลายบัญชี: ใช้ `channels.slack.accounts` พร้อมโทเคนต่อบัญชีและ `name` (ไม่บังคับ) รองรับหลายบัญชี: ใช้ `channels.slack.accounts` พร้อมโทเคนแยกต่อบัญชีและ `name` (ไม่บังคับ) ดู [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) สำหรับรูปแบบร่วมกัน

### คอนฟิก OpenClaw (โหมด Socket)

5. ตั้งค่าโทเคนผ่านตัวแปรสภาพแวดล้อม (แนะนำ):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

หรือผ่านคอนฟิก:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### โทเคนผู้ใช้(ไม่บังคับ)

OpenClaw สามารถใช้ Slack user token (`xoxp-...`) สำหรับการอ่าน (ประวัติ,
พิน, รีแอ็กชัน, อีโมจิ, ข้อมูลสมาชิก) โดยค่าเริ่มต้นจะเป็นอ่านอย่างเดียว: การอ่านจะเลือกใช้ user token เมื่อมี และการเขียนยังคงใช้ bot token เว้นแต่คุณจะเลือกเปิดใช้อย่างชัดเจน แม้จะตั้งค่า `userTokenReadOnly: false` แล้ว bot token ก็ยังคงเป็นตัวเลือกหลักสำหรับการเขียนเมื่อมีให้ใช้ 6. ค่าเริ่มต้นจะเป็นแบบอ่านอย่างเดียว: อ่าน
จะเลือกใช้ user token เมื่อมีอยู่ และการเขียนจะยังใช้ bot token เว้นแต่
คุณจะเลือกเปิดใช้อย่างชัดเจน. 7. แม้ตั้งค่า `userTokenReadOnly: false` แล้ว bot token ก็ยังคง
ถูกเลือกใช้เป็นหลักสำหรับการเขียนเมื่อมีให้ใช้งาน.

8. user token ถูกกำหนดค่าในไฟล์คอนฟิก (ไม่รองรับ env var). โทเคนผู้ใช้ตั้งค่าในไฟล์คอนฟิก(ไม่รองรับ env var) สำหรับหลายบัญชี ให้ตั้งค่า `channels.slack.accounts.<id>.userToken`

ตัวอย่างที่มี bot + app + user tokens:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

ตัวอย่างที่ตั้งค่า userTokenReadOnly อย่างชัดเจน(อนุญาตให้ user token เขียน):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### การใช้งานโทเคน

- การอ่าน (ประวัติ, รายการรีแอ็กชัน, รายการพิน, รายการอีโมจิ, ข้อมูลสมาชิก,
  การค้นหา) จะเลือกใช้ user token เมื่อมีคอนฟิก มิฉะนั้นใช้ bot token
- 9. การดำเนินการเขียน (ส่ง/แก้ไข/ลบข้อความ, เพิ่ม/ลบรีแอคชัน, ปักหมุด/ยกเลิกปักหมุด,
     อัปโหลดไฟล์) จะใช้ bot token โดยค่าเริ่มต้น. การเขียน (ส่ง/แก้ไข/ลบข้อความ, เพิ่ม/ลบรีแอ็กชัน, ปักหมุด/ยกเลิก, อัปโหลดไฟล์) ใช้ bot token เป็นค่าเริ่มต้น หากตั้งค่า `userTokenReadOnly: false` และ
     ไม่มี bot token ให้ใช้ OpenClaw จะสลับไปใช้ user token

### บริบทประวัติ

- `channels.slack.historyLimit` (หรือ `channels.slack.accounts.*.historyLimit`) ควบคุมจำนวนข้อความล่าสุดของช่อง/กลุ่มที่จะถูกรวมเข้าในพรอมป์ต์
- จะย้อนกลับไปใช้ `messages.groupChat.historyLimit` ตั้งค่า `0` เพื่อปิดการใช้งาน (ค่าเริ่มต้น 50) ตั้งค่า `0` เพื่อปิด (ค่าเริ่มต้น 50)

## โหมด HTTP (Events API)

ใช้โหมด HTTP webhook เมื่อ Gateway ของคุณเข้าถึงได้โดย Slack ผ่าน HTTPS (มักใช้กับการติดตั้งบนเซิร์ฟเวอร์)
โหมด HTTP ใช้ Events API + Interactivity + Slash Commands โดยใช้ URL คำขอร่วมกัน
10. โหมด HTTP ใช้ Events API + Interactivity + Slash Commands โดยใช้ URL คำขอร่วมกัน.

### การตั้งค่า(โหมด HTTP)

1. สร้างแอป Slack และ **ปิด Socket Mode** (ไม่บังคับ หากใช้เฉพาะ HTTP)
2. **Basic Information** → คัดลอก **Signing Secret**
3. **OAuth & Permissions** → ติดตั้งแอปและคัดลอก **Bot User OAuth Token** (`xoxb-...`)
4. **Event Subscriptions** → เปิดใช้งานอีเวนต์และตั้งค่า **Request URL** เป็นพาธ webhook ของ Gateway (ค่าเริ่มต้น `/slack/events`)
5. **Interactivity & Shortcuts** → เปิดใช้งานและตั้งค่า **Request URL** เดียวกัน
6. **Slash Commands** → ตั้งค่า **Request URL** เดียวกันสำหรับคำสั่งของคุณ

ตัวอย่าง Request URL:
`https://gateway-host/slack/events`

### คอนฟิก OpenClaw (ขั้นต่ำ)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

โหมด HTTP หลายบัญชี: ตั้งค่า `channels.slack.accounts.<id>.mode = "http"` และกำหนด
`webhookPath` ที่ไม่ซ้ำกันต่อบัญชี เพื่อให้แต่ละแอป Slack ชี้ไปยัง URL ของตนเอง

### 11. Manifest (ตัวเลือก)

ใช้แมนิฟেস্টแอป Slack นี้เพื่อสร้างแอปอย่างรวดเร็ว(ปรับชื่อ/คำสั่งได้ตามต้องการ) รวม
user scopes หากคุณวางแผนจะตั้งค่า user token 12. รวม
user scopes หากคุณวางแผนจะกำหนดค่า user token.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

หากเปิดใช้คำสั่งเนทีฟ ให้เพิ่มรายการ `slash_commands` หนึ่งรายการต่อคำสั่งที่ต้องการเผยแพร่(ต้องตรงกับรายการ `/help`) สามารถเขียนทับด้วย `channels.slack.commands.native` 13. เขียนทับด้วย `channels.slack.commands.native`.

## สโคป(ปัจจุบันเทียบกับไม่บังคับ)

Conversations API ของ Slack เป็นแบบจำกัดตามชนิด: คุณต้องการเฉพาะสโคปสำหรับ
ชนิดการสนทนาที่คุณใช้งานจริง(ช่อง, กลุ่ม, im, mpim) ดูภาพรวมที่
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) 14. ดู
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) สำหรับภาพรวม.

### สโคป bot token(จำเป็น)

- `chat:write` (ส่ง/อัปเดต/ลบข้อความผ่าน `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (เปิด DM ผ่าน `conversations.open` สำหรับ DM ผู้ใช้)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (ค้นหาผู้ใช้)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (อัปโหลดผ่าน `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### สโคป user token(ไม่บังคับ, ค่าเริ่มต้นอ่านอย่างเดียว)

เพิ่มรายการเหล่านี้ใต้ **User Token Scopes** หากตั้งค่า `channels.slack.userToken`

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### ยังไม่จำเป็นในตอนนี้(แต่มีแนวโน้มในอนาคต)

- `mpim:write` (เฉพาะเมื่อเพิ่มการเปิด group-DM/เริ่ม DM ผ่าน `conversations.open`)
- `groups:write` (เฉพาะเมื่อเพิ่มการจัดการช่องส่วนตัว: สร้าง/เปลี่ยนชื่อ/เชิญ/เก็บถาวร)
- `chat:write.public` (เฉพาะเมื่ออยากโพสต์ไปยังช่องที่บอตไม่ได้อยู่)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (เฉพาะเมื่อจำเป็นต้องใช้ฟิลด์อีเมลจาก `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (เฉพาะเมื่อเริ่มแสดง/อ่านเมทาดาทาไฟล์)

## คอนฟิก

Slack ใช้โหมด Socket เท่านั้น(ไม่มีเซิร์ฟเวอร์ HTTP webhook) ต้องระบุทั้งสองโทเคน: 15. จัดเตรียมโทเคนทั้งสอง:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

สามารถส่งโทเคนผ่าน env vars ได้เช่นกัน:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

รีแอคชันยืนยัน(Ack)ถูกควบคุมทั่วทั้งระบบผ่าน `messages.ackReaction` +
`messages.ackReactionScope`. การตอบรับด้วยรีแอ็กชัน(ack) ควบคุมแบบ global ผ่าน `messages.ackReaction` +
`messages.ackReactionScope` ใช้ `messages.removeAckAfterReply` เพื่อล้าง
รีแอ็กชัน ack หลังจากบอตตอบกลับ

## ข้อจำกัด

- ข้อความขาออกถูกแบ่งเป็นชิ้นที่ `channels.slack.textChunkLimit` (ค่าเริ่มต้น 4000)
- การแบ่งตามบรรทัดใหม่แบบไม่บังคับ: ตั้งค่า `channels.slack.chunkMode="newline"` เพื่อแยกตามบรรทัดว่าง(ขอบเขตย่อหน้า)ก่อนการแบ่งตามความยาว
- การอัปโหลดสื่อจำกัดโดย `channels.slack.mediaMaxMb` (ค่าเริ่มต้น 20)

## การตอบกลับแบบเธรด

16. โดยค่าเริ่มต้น OpenClaw จะตอบกลับในช่องหลัก. โดยค่าเริ่มต้น OpenClaw จะตอบในช่องหลัก ใช้ `channels.slack.replyToMode` เพื่อควบคุมการทำเธรดอัตโนมัติ:

| Mode    | Behavior                                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **ค่าเริ่มต้น** ตอบในช่องหลัก จะทำเธรดก็ต่อเมื่อข้อความที่กระตุ้นอยู่ในเธรดอยู่แล้ว 17. จะตอบในเธรดก็ต่อเมื่อข้อความที่ทริกเกอร์อยู่ในเธรดอยู่แล้ว.                                                |
| `first` | คำตอบแรกไปที่เธรด(ใต้ข้อความที่กระตุ้น) คำตอบถัดไปไปที่ช่องหลัก เหมาะสำหรับรักษาบริบทและลดความรกของเธรด 18. มีประโยชน์ในการรักษาบริบทให้มองเห็นได้พร้อมหลีกเลี่ยงความรกของเธรด. |
| `all`   | 19. การตอบกลับทั้งหมดไปที่เธรด. คำตอบทั้งหมดไปที่เธรด ช่วยให้การสนทนาอยู่เป็นที่เดียวแต่การมองเห็นอาจลดลง                                                                                   |

โหมดนี้ใช้กับทั้งการตอบกลับอัตโนมัติและการเรียกเครื่องมือของเอเจนต์ (`slack sendMessage`)

### การทำเธรดแยกตามชนิดแชต

คุณสามารถกำหนดพฤติกรรมการทำเธรดต่างกันตามชนิดแชตได้โดยตั้งค่า `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

ชนิดแชตที่รองรับ:

- `direct`: DM แบบ 1:1 (Slack `im`)
- `group`: DM กลุ่ม / MPIMs (Slack `mpim`)
- `channel`: ช่องมาตรฐาน(สาธารณะ/ส่วนตัว)

ลำดับความสำคัญ:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. ค่าเริ่มต้นของผู้ให้บริการ (`off`)

ค่าเดิม `channels.slack.dm.replyToMode` ยังยอมรับเป็นทางเลือกสำรองสำหรับ `direct` เมื่อไม่มีการตั้งค่าแยกตามชนิดแชต

ตัวอย่าง:

ทำเธรดเฉพาะ DM:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

ทำเธรดใน DM กลุ่ม แต่คงช่องไว้ที่ราก:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

ทำเธรดในช่อง แต่คง DM ไว้ที่ราก:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### แท็กการทำเธรดด้วยตนเอง

เพื่อการควบคุมที่ละเอียด ใช้แท็กเหล่านี้ในคำตอบของเอเจนต์:

- `[[reply_to_current]]` — ตอบกลับข้อความที่กระตุ้น(เริ่ม/ต่อเธรด)
- `[[reply_to:<id>]]` — ตอบกลับไปยังข้อความที่มี message id ระบุ

## เซสชัน + การกำหนดเส้นทาง

- DM ใช้เซสชัน `main` ร่วมกัน(เช่น WhatsApp/Telegram)
- ช่องแมปเป็นเซสชัน `agent:<agentId>:slack:channel:<channelId>`
- Slash commands ใช้เซสชัน `agent:<agentId>:slack:slash:<userId>` (ตั้งค่าพรีฟิกซ์ได้ผ่าน `channels.slack.slashCommand.sessionPrefix`)
- หาก Slack ไม่ให้ `channel_type` มา OpenClaw จะอนุมานจากพรีฟิกซ์ของ channel ID (`D`, `C`, `G`) และตั้งค่าเริ่มต้นเป็น `channel` เพื่อให้คีย์เซสชันคงที่
- การลงทะเบียนคำสั่งเนทีฟใช้ `commands.native` (ค่าเริ่มต้นระดับ global คือ `"auto"` → ปิด Slack) และสามารถเขียนทับต่อเวิร์กสเปซด้วย `channels.slack.commands.native` คำสั่งแบบข้อความต้องเป็นข้อความ `/...` แบบสแตนด์อโลน และสามารถปิดได้ด้วย `commands.text: false` Slack slash commands จัดการในแอป Slack และจะไม่ถูกลบอัตโนมัติ ใช้ `commands.useAccessGroups: false` เพื่อข้ามการตรวจสอบกลุ่มการเข้าถึงสำหรับคำสั่ง 20. คำสั่งแบบข้อความต้องเป็นข้อความ `/...` แบบเดี่ยว และสามารถปิดได้ด้วย `commands.text: false`. Slack slash commands are managed in the Slack app and are not removed automatically. 22. ใช้ `commands.useAccessGroups: false` เพื่อข้ามการตรวจสอบ access-group สำหรับคำสั่ง.
- รายการคำสั่งทั้งหมด + คอนฟิก: [Slash commands](/tools/slash-commands)

## ความปลอดภัย DM(การจับคู่)

- ค่าเริ่มต้น: `channels.slack.dm.policy="pairing"` — ผู้ส่ง DM ที่ไม่รู้จักจะได้รับโค้ดจับคู่(หมดอายุภายใน 1 ชั่วโมง)
- อนุมัติผ่าน: `openclaw pairing approve slack <code>`
- เพื่ออนุญาตทุกคน: ตั้งค่า `channels.slack.dm.policy="open"` และ `channels.slack.dm.allowFrom=["*"]`
- `channels.slack.dm.allowFrom` รับ user IDs, @handles หรืออีเมล(แก้เป็น ID ตอนเริ่มระบบเมื่อโทเคนอนุญาต) ตัวช่วยตั้งค่ารับชื่อผู้ใช้และจะแปลงเป็น id ระหว่างการตั้งค่าเมื่อโทเคนอนุญาต 23. ตัวช่วยตั้งค่ารองรับชื่อผู้ใช้และจะแปลงเป็น id ระหว่างการตั้งค่าเมื่อโทเคนอนุญาต.

## นโยบายกลุ่ม

- `channels.slack.groupPolicy` ควบคุมการจัดการช่อง (`open|disabled|allowlist`)
- `allowlist` กำหนดให้ช่องต้องอยู่ในรายการ `channels.slack.channels`
- หากคุณตั้งค่าเพียง `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` และไม่เคยสร้างส่วน `channels.slack`,
  ค่าเริ่มต้นขณะรันจะตั้ง `groupPolicy` เป็น `open` เพิ่ม `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` หรือรายการอนุญาตช่องเพื่อจำกัดให้แน่นขึ้น 24. เพิ่ม `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` หรือ allowlist ของช่องเพื่อจำกัดการใช้งาน.
- ตัวช่วยตั้งค่ารับชื่อ `#channel` และจะแปลงเป็น ID เมื่อเป็นไปได้
  (สาธารณะ+ส่วนตัว); หากมีหลายรายการที่ตรงกัน จะเลือกช่องที่ยังใช้งานอยู่
- ตอนเริ่มระบบ OpenClaw จะแปลงชื่อช่อง/ผู้ใช้ในรายการอนุญาตเป็น ID(เมื่อโทเคนอนุญาต)
  และบันทึกการแมป; รายการที่แปลงไม่ได้จะคงไว้ตามที่พิมพ์
- เพื่อ **ไม่อนุญาตช่องใดเลย** ให้ตั้งค่า `channels.slack.groupPolicy: "disabled"` (หรือคงรายการอนุญาตว่างไว้)

ตัวเลือกช่อง (`channels.slack.channels.<id>` หรือ `channels.slack.channels.<name>`):

- `allow`: อนุญาต/ปฏิเสธช่องเมื่อ `groupPolicy="allowlist"`
- `requireMention`: การควบคุมด้วยการกล่าวถึงสำหรับช่อง
- `tools`: การเขียนทับนโยบายเครื่องมือรายช่อง(ไม่บังคับ) (`allow`/`deny`/`alsoAllow`)
- `toolsBySender`: การเขียนทับนโยบายเครื่องมือต่อผู้ส่งภายในช่อง(ไม่บังคับ) (คีย์คือ sender ids/@handles/อีเมล; รองรับไวลด์การ์ด `"*"`)
- `allowBots`: อนุญาตข้อความที่บอตเป็นผู้เขียนในช่องนี้(ค่าเริ่มต้น: false)
- `users`: รายการอนุญาตผู้ใช้รายช่อง(ไม่บังคับ)
- `skills`: ตัวกรองสกิล(ไม่ระบุ = ทุกสกิล, ว่าง = ไม่มี)
- `systemPrompt`: system prompt เพิ่มเติมสำหรับช่อง(รวมกับหัวข้อ/วัตถุประสงค์)
- `enabled`: ตั้งค่า `false` เพื่อปิดใช้งานช่อง

## เป้าหมายการส่งมอบ

ใช้ร่วมกับการส่งผ่าน cron/CLI:

- `user:<id>` สำหรับ DM
- `channel:<id>` สำหรับช่อง

## การกระทำของเครื่องมือ

การกระทำของเครื่องมือ Slack สามารถจำกัดได้ด้วย `channels.slack.actions.*`:

| Action group | Default | Notes                                                 |
| ------------ | ------- | ----------------------------------------------------- |
| reactions    | enabled | 25. รีแอค + แสดงรายการรีแอคชัน |
| messages     | enabled | อ่าน/ส่ง/แก้ไข/ลบ                                     |
| pins         | enabled | ปักหมุด/ยกเลิก/แสดงรายการ                             |
| memberInfo   | enabled | ข้อมูลสมาชิก                                          |
| emojiList    | enabled | รายการอีโมจิแบบกำหนดเอง                               |

## หมายเหตุด้านความปลอดภัย

- การเขียนจะใช้ bot token เป็นค่าเริ่มต้น เพื่อให้การเปลี่ยนแปลงสถานะอยู่ภายใต้
  สิทธิ์และตัวตนของบอตของแอป
- การตั้งค่า `userTokenReadOnly: false` อนุญาตให้ใช้ user token สำหรับการเขียน
  เมื่อไม่มี bot token ซึ่งหมายความว่าการกระทำจะรันด้วยสิทธิ์ของผู้ติดตั้ง
  ควรปฏิบัติต่อ user token ว่ามีสิทธิ์สูงมาก และตั้งค่าประตูการกระทำและรายการอนุญาตให้รัดกุม 26. ปฏิบัติต่อ user token เสมือนมีสิทธิ์สูงมาก และควรตั้ง
  กลไกป้องกันการกระทำและ allowlist ให้รัดกุม.
- หากเปิดใช้การเขียนด้วย user token ตรวจสอบให้แน่ใจว่า user token มีสโคปการเขียนที่ต้องการ
  (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) มิฉะนั้นการทำงานจะล้มเหลว

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
openclaw pairing list slack
```

ความล้มเหลวที่พบบ่อย:

- เชื่อมต่อแล้วแต่ไม่ตอบในช่อง: ช่องถูกบล็อกโดย `groupPolicy` หรือไม่อยู่ในรายการอนุญาต `channels.slack.channels`
- DM ถูกละเลย: ผู้ส่งยังไม่ได้รับอนุมัติเมื่อ `channels.slack.dm.policy="pairing"`
- ข้อผิดพลาด API (`missing_scope`, `not_in_channel`, การยืนยันตัวตนล้มเหลว): โทเคนบอต/แอปหรือสโคป Slack ไม่ครบถ้วน

โฟลว์สำหรับการไตรอาจ: [/channels/troubleshooting](/channels/troubleshooting)

## Notes

- การควบคุมด้วยการกล่าวถึงตั้งค่าผ่าน `channels.slack.channels` (ตั้งค่า `requireMention` เป็น `true`); `agents.list[].groupChat.mentionPatterns` (หรือ `messages.groupChat.mentionPatterns`) นับเป็นการกล่าวถึงเช่นกัน
- การเขียนทับหลายเอเจนต์: ตั้งค่ารูปแบบต่อเอเจนต์ที่ `agents.list[].groupChat.mentionPatterns`
- การแจ้งเตือนรีแอ็กชันเป็นไปตาม `channels.slack.reactionNotifications` (ใช้ `reactionAllowlist` กับโหมด `allowlist`)
- ข้อความที่บอตเป็นผู้เขียนจะถูกละเลยเป็นค่าเริ่มต้น; เปิดใช้งานผ่าน `channels.slack.allowBots` หรือ `channels.slack.channels.<id>.allowBots`
- คำเตือน: หากอนุญาตให้ตอบบอตอื่น (`channels.slack.allowBots=true` หรือ `channels.slack.channels.<id>.allowBots=true`) ให้ป้องกันลูปบอตต่อบอตด้วยรายการอนุญาต `requireMention`, `channels.slack.channels.<id>.users` และ/หรือเคลียร์การ์ดเรลใน `AGENTS.md` และ `SOUL.md`
- สำหรับเครื่องมือ Slack ความหมายของการลบรีแอ็กชันอยู่ที่ [/tools/reactions](/tools/reactions)
- ไฟล์แนบจะถูกดาวน์โหลดไปยังคลังสื่อเมื่อได้รับอนุญาตและมีขนาดไม่เกินขีดจำกัด
