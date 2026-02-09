---
summary: "พฤติกรรมแชทกลุ่มข้ามแพลตฟอร์ม(WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - เปลี่ยนพฤติกรรมแชทกลุ่มหรือการกำหนดการทริกเกอร์ด้วยการกล่าวถึง
title: "กลุ่ม"
---

# กลุ่ม

OpenClaw จัดการแชทกลุ่มอย่างสม่ำเสมอข้ามแพลตฟอร์ม: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams

## บทนำสำหรับผู้เริ่มต้น(2นาที)

43. OpenClaw “อาศัยอยู่” บนบัญชีการส่งข้อความของคุณเอง 44. ไม่มีผู้ใช้บ็อต WhatsApp แยกต่างหาก
    OpenClaw “อาศัยอยู่”บนบัญชีแชทของคุณเอง ไม่มีผู้ใช้บอตWhatsAppแยกต่างหาก
    ถ้า**คุณ**อยู่ในกลุ่ม OpenClaw จะมองเห็นกลุ่มนั้นและตอบกลับได้

พฤติกรรมค่าเริ่มต้น:

- กลุ่มถูกจำกัด(`groupPolicy: "allowlist"`)
- การตอบกลับต้องมีการกล่าวถึง เว้นแต่คุณจะปิดการกำหนดการทริกเกอร์ด้วยการกล่าวถึงอย่างชัดเจน

แปลความหมาย: ผู้ส่งที่อยู่ในรายการอนุญาตสามารถทริกเกอร์OpenClawได้โดยการกล่าวถึงมัน

> TL;DR
>
> - **การเข้าถึงDM**ถูกควบคุมโดย`*.allowFrom`
> - **การเข้าถึงกลุ่ม**ถูกควบคุมโดย`*.groupPolicy`+รายการอนุญาต(`*.groups`,`*.groupAllowFrom`)
> - **การทริกเกอร์การตอบกลับ**ถูกควบคุมโดยการกำหนดการทริกเกอร์ด้วยการกล่าวถึง(`requireMention`,`/activation`)

ลำดับอย่างย่อ(เกิดอะไรขึ้นกับข้อความกลุ่ม):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

ถ้าคุณต้องการ...

| เป้าหมาย                                               | ต้องตั้งค่าอะไร                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| อนุญาตทุกกลุ่มแต่ตอบเฉพาะเมื่อมี@mentions | `groups: { "*": { requireMention: true } }`                            |
| ปิดการตอบกลับของกลุ่มทั้งหมด                           | `groupPolicy: "disabled"`                                              |
| เฉพาะกลุ่มที่ระบุ                                      | `groups: { "<group-id>": { ... } }`(ไม่มีคีย์`"*"`) |
| มีเพียงคุณที่ทริกเกอร์ได้ในกลุ่ม                       | `groupPolicy: "allowlist"`,`groupAllowFrom: ["+1555..."]`              |

## คีย์เซสชัน

- เซสชันของกลุ่มใช้คีย์เซสชัน`agent:<agentId>:<channel>:group:<id>`(ห้อง/ช่องทางใช้`agent:<agentId>:<channel>:channel:<id>`)
- หัวข้อฟอรัมของTelegramจะเพิ่ม`:topic:<threadId>`ไปยังIDกลุ่มเพื่อให้แต่ละหัวข้อมีเซสชันของตัวเอง
- แชทโดยตรงใช้เซสชันหลัก(หรือแบบต่อผู้ส่งหากตั้งค่าไว้)
- ข้ามฮาร์ตบีตสำหรับเซสชันกลุ่ม

## รูปแบบ: DMส่วนตัว+กลุ่มสาธารณะ(เอเจนต์เดียว)

ได้—รูปแบบนี้ทำงานได้ดีหากทราฟฟิก“ส่วนตัว”ของคุณเป็น**DMs**และทราฟฟิก“สาธารณะ”เป็น**กลุ่ม**

เหตุผล: ในโหมดเอเจนต์เดียว DMมักจะไปที่คีย์เซสชัน**หลัก**(`agent:main:main`)ขณะที่กลุ่มจะใช้คีย์เซสชัน**ที่ไม่ใช่หลัก**เสมอ(`agent:main:<channel>:group:<id>`)หากคุณเปิดsandboxingด้วย`mode: "non-main"`เซสชันกลุ่มเหล่านั้นจะรันในDockerขณะที่เซสชันDMหลักยังคงอยู่บนโฮสต์ 45. หากคุณเปิดใช้ sandbox ด้วย `mode: "non-main"` เซสชันกลุ่มเหล่านั้นจะรันใน Docker ขณะที่เซสชัน DM หลักของคุณยังคงรันบนโฮสต์

สิ่งนี้ทำให้คุณมี“สมอง”เอเจนต์เดียว(เวิร์กสเปซ+หน่วยความจำร่วมกัน)แต่มีท่าทางการรันสองแบบ:

- **DMs**: เครื่องมือเต็มรูปแบบ(โฮสต์)
- **กลุ่ม**: sandbox+เครื่องมือที่ถูกจำกัด(Docker)

> หากคุณต้องการแยกเวิร์กสเปซ/บุคลิกอย่างแท้จริง(“ส่วนตัว”และ“สาธารณะ”ต้องไม่ปะปนกัน)ให้ใช้เอเจนต์ที่สอง+การผูกมัด ดู[Multi-Agent Routing](/concepts/multi-agent) 46. ดู [Multi-Agent Routing](/concepts/multi-agent)

ตัวอย่าง(DMบนโฮสต์ กลุ่มอยู่ในsandbox+เครื่องมือด้านการส่งข้อความเท่านั้น):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

ต้องการให้“กลุ่มเห็นได้เฉพาะโฟลเดอร์X”แทน“ไม่มีการเข้าถึงโฮสต์”หรือไม่?คงค่า`workspaceAccess: "none"`ไว้และเมานต์เฉพาะพาธที่อยู่ในรายการอนุญาตเข้าไปในsandbox: 47. คงค่า `workspaceAccess: "none"` และเมานต์เฉพาะพาธที่อยู่ใน allowlist เข้าไปใน sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

ที่เกี่ยวข้อง:

- คีย์การกำหนดค่าและค่าเริ่มต้น: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- การดีบักสาเหตุที่เครื่องมือถูกบล็อก: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- รายละเอียดBind mounts: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## ป้ายกำกับการแสดงผล

- ป้ายกำกับUIใช้`displayName`เมื่อมี พร้อมรูปแบบเป็น`<channel>:<token>`
- `#room`สงวนไว้สำหรับห้อง/ช่องทาง; แชทกลุ่มใช้`g-<slug>`(ตัวพิมพ์เล็ก เว้นวรรค->`-` คง`#@+._-`)

## นโยบายกลุ่ม

ควบคุมวิธีจัดการข้อความกลุ่ม/ห้องต่อช่องทาง:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| นโยบาย        | พฤติกรรม                                                           |
| ------------- | ------------------------------------------------------------------ |
| `"open"`      | กลุ่มข้ามรายการอนุญาต; การกำหนดการทริกเกอร์ด้วยการกล่าวถึงยังคงใช้ |
| `"disabled"`  | บล็อกข้อความกลุ่มทั้งหมด                                           |
| `"allowlist"` | อนุญาตเฉพาะกลุ่ม/ห้องที่ตรงกับรายการอนุญาตที่ตั้งค่าไว้            |

หมายเหตุ:

- `groupPolicy`แยกจากการกำหนดการทริกเกอร์ด้วยการกล่าวถึง(ซึ่งต้องมี@mentions)
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: ใช้`groupAllowFrom`(สำรอง: ระบุ`allowFrom`อย่างชัดเจน)
- Discord: รายการอนุญาตใช้`channels.discord.guilds.<id>.channels`
- Slack: รายการอนุญาตใช้`channels.slack.channels`
- Matrix: รายการอนุญาตใช้`channels.matrix.groups`(IDห้อง ชื่อแฝง หรือชื่อ)ใช้`channels.matrix.groupAllowFrom`เพื่อจำกัดผู้ส่ง; รองรับรายการอนุญาตแบบต่อห้อง`users`ด้วย 48. ใช้ `channels.matrix.groupAllowFrom` เพื่อจำกัดผู้ส่ง; รองรับ allowlist ต่อห้องใน `users` ด้วย
- DMแบบกลุ่มถูกควบคุมแยกต่างหาก(`channels.discord.dm.*`,`channels.slack.dm.*`)
- รายการอนุญาตของTelegramสามารถแมตช์IDผู้ใช้(`"123456789"`,`"telegram:123456789"`,`"tg:123456789"`)หรือชื่อผู้ใช้(`"@alice"`หรือ`"alice"`)คำนำหน้าไม่แยกตัวพิมพ์
- ค่าเริ่มต้นคือ`groupPolicy: "allowlist"`; หากรายการอนุญาตกลุ่มของคุณว่าง ข้อความกลุ่มจะถูกบล็อก

โมเดลความคิดอย่างย่อ(ลำดับการประเมินสำหรับข้อความกลุ่ม):

1. `groupPolicy`(เปิด/ปิด/รายการอนุญาต)
2. รายการอนุญาตกลุ่ม(`*.groups`,`*.groupAllowFrom`,รายการอนุญาตเฉพาะช่องทาง)
3. การกำหนดการทริกเกอร์ด้วยการกล่าวถึง(`requireMention`,`/activation`)

## 49) การจำกัดด้วยการกล่าวถึง (ค่าเริ่มต้น)

ข้อความกลุ่มต้องมีการกล่าวถึง เว้นแต่จะถูกแทนที่เป็นรายกลุ่ม ค่าเริ่มต้นอยู่ต่อซับซิสเต็มภายใต้`*.groups."*"` 50. ค่าเริ่มต้นอยู่แยกตามซับซิสเต็มภายใต้ `*.groups."*"`

การตอบกลับข้อความจากบอทถือเป็นการกล่าวถึงโดยปริยาย (เมื่อช่องรองรับเมทาดาทาการตอบกลับ) การตอบกลับข้อความของบอตนับเป็นการกล่าวถึงโดยปริยาย(เมื่อช่องทางรองรับเมตาดาทาการตอบกลับ)ใช้กับTelegram, WhatsApp, Slack, Discord และMicrosoft Teams

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

หมายเหตุ:

- `mentionPatterns`เป็นregexไม่แยกตัวพิมพ์
- พื้นผิวที่ให้การกล่าวถึงแบบชัดเจนยังคงผ่านได้; รูปแบบเป็นทางเลือกสำรอง
- การแทนที่แบบต่อเอเจนต์: `agents.list[].groupChat.mentionPatterns`(มีประโยชน์เมื่อหลายเอเจนต์แชร์กลุ่มเดียวกัน)
- การกำหนดการทริกเกอร์ด้วยการกล่าวถึงจะถูกบังคับใช้เฉพาะเมื่อสามารถตรวจจับการกล่าวถึงได้(การกล่าวถึงแบบเนทีฟหรือมีการตั้งค่า`mentionPatterns`)
- ค่าเริ่มต้นของDiscordอยู่ใน`channels.discord.guilds."*"`(แทนที่ได้ต่อกิลด์/ช่อง)
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit`(หรือ`channels.<channel>.accounts.*.historyLimit`)สำหรับการแทนที่ ตั้งค่า`0`เพื่อปิดใช้งาน ตั้งค่า `0` เพื่อปิดการใช้งาน

## ข้อจำกัดเครื่องมือของกลุ่ม/ช่องทาง(ไม่บังคับ)

คอนฟิกของบางช่องทางรองรับการจำกัดว่าเครื่องมือใดบ้างที่ใช้ได้**ภายในกลุ่ม/ห้อง/ช่องทางเฉพาะ**

- `tools`: อนุญาต/ปฏิเสธเครื่องมือสำหรับทั้งกลุ่ม
- `toolsBySender`: การแทนที่แบบต่อผู้ส่งภายในกลุ่ม(คีย์คือIDผู้ส่ง/ชื่อผู้ใช้/อีเมล/หมายเลขโทรศัพท์ตามช่องทาง)ใช้`"*"`เป็นไวลด์การ์ด ใช้ `"*"` เป็นไวลด์การ์ด

ลำดับการตัดสิน(เฉพาะเจาะจงที่สุดชนะ):

1. การแมตช์`toolsBySender`ของกลุ่ม/ช่อง
2. `tools`ของกลุ่ม/ช่อง
3. ค่าเริ่มต้น(`"*"`)การแมตช์`toolsBySender`
4. ค่าเริ่มต้น(`"*"`)`tools`

ตัวอย่าง(Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

หมายเหตุ:

- ข้อจำกัดเครื่องมือของกลุ่ม/ช่องถูกนำไปใช้เพิ่มเติมจากนโยบายเครื่องมือระดับโลก/เอเจนต์(การปฏิเสธยังคงชนะ)
- บางช่องทางใช้โครงซ้อนต่างกันสำหรับห้อง/ช่อง(เช่น Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`)

## รายการอนุญาตกลุ่ม

เมื่อมีการตั้งค่า`channels.whatsapp.groups`,`channels.telegram.groups`หรือ`channels.imessage.groups`คีย์เหล่านี้จะทำหน้าที่เป็นรายการอนุญาตกลุ่ม ใช้`"*"`เพื่ออนุญาตทุกกลุ่มขณะยังตั้งค่าพฤติกรรมการกล่าวถึงค่าเริ่มต้นได้ ใช้ `"*"` เพื่ออนุญาตทุกกลุ่ม ขณะเดียวกันยังตั้งค่าพฤติกรรมการกล่าวถึงเริ่มต้น

เจตนาที่พบบ่อย(คัดลอก/วาง):

1. ปิดการตอบกลับของกลุ่มทั้งหมด

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. อนุญาตเฉพาะกลุ่มที่ระบุ(WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. อนุญาตทุกกลุ่มแต่ต้องมีการกล่าวถึง(แบบชัดเจน)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. มีเพียงเจ้าของเท่านั้นที่ทริกเกอร์ได้ในกลุ่ม(WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## การเปิดใช้งาน(เฉพาะเจ้าของ)

เจ้าของกลุ่มสามารถสลับการเปิดใช้งานเป็นรายกลุ่มได้:

- `/activation mention`
- `/activation always`

เจ้าของถูกกำหนดโดย`channels.whatsapp.allowFrom`(หรือE.164ของบอตเองเมื่อไม่ได้ตั้งค่า)ส่งคำสั่งเป็นข้อความเดี่ยว แพลตฟอร์มอื่นๆปัจจุบันจะไม่สนใจ`/activation` Send the command as a standalone message. พื้นผิวอื่น ๆ ในปัจจุบันจะเพิกเฉยต่อ `/activation`

## ฟิลด์บริบท

เพย์โหลดขาเข้าของกลุ่มตั้งค่า:

- `ChatType=group`
- `GroupSubject`(หากทราบ)
- `GroupMembers`(หากทราบ)
- `WasMentioned`(ผลการกำหนดการทริกเกอร์ด้วยการกล่าวถึง)
- หัวข้อฟอรัมของTelegramจะมี`MessageThreadId`และ`IsForum`เพิ่มเติม

พรอมต์ระบบของเอเจนต์จะรวมบทนำกลุ่มในเทิร์นแรกของเซสชันกลุ่มใหม่ พรอมป์ระบบของเอเจนต์จะรวมบทนำกลุ่มในเทิร์นแรกของเซสชันกลุ่มใหม่ เตือนโมเดลให้ตอบเหมือนมนุษย์ หลีกเลี่ยงตารางMarkdown และหลีกเลี่ยงการพิมพ์ลำดับ`\n`ตามตัวอักษร

## รายละเอียดเฉพาะของiMessage

- ควรใช้`chat_id:<id>`เมื่อทำการรูตหรือทำรายการอนุญาต
- แสดงรายการแชท: `imsg chats --limit 20`
- การตอบกลับของกลุ่มจะส่งกลับไปยัง`chat_id`เดิมเสมอ

## รายละเอียดเฉพาะของWhatsApp

ดู[Group messages](/channels/group-messages)สำหรับพฤติกรรมเฉพาะของWhatsApp(การฉีดประวัติ รายละเอียดการจัดการการกล่าวถึง)
