---
summary: "การกำหนดเส้นทางแบบหลายเอเจนต์: เอเจนต์ที่แยกจากกัน บัญชีช่องทาง และการผูก"
title: การกำหนดเส้นทางแบบหลายเอเจนต์
read_when: "คุณต้องการเอเจนต์ที่แยกจากกันหลายตัว(เวิร์กสเปซ+การยืนยันตัวตน)ภายในกระบวนการGatewayเดียว"
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:25Z
---

# การกำหนดเส้นทางแบบหลายเอเจนต์

เป้าหมาย: มีเอเจนต์ที่ _แยกจากกัน_ หลายตัว(เวิร์กสเปซ+`agentDir`+เซสชันแยก)พร้อมบัญชีช่องทางหลายบัญชี(เช่น WhatsApp สองบัญชี)ภายในGatewayที่กำลังรันหนึ่งตัว ขาเข้าจะถูกกำหนดเส้นทางไปยังเอเจนต์ผ่านการผูก(binding)

## “หนึ่งเอเจนต์”คืออะไร?

**เอเจนต์**คือสมองที่มีขอบเขตครบถ้วนพร้อมของตัวเอง ได้แก่:

- **เวิร์กสเปซ**(ไฟล์, AGENTS.md/SOUL.md/USER.md, โน้ตภายในเครื่อง, กฎบุคลิก)
- **ไดเรกทอรีสถานะ**(`agentDir`)สำหรับโปรไฟล์การยืนยันตัวตน รีจิสทรีโมเดล และคอนฟิกต่อเอเจนต์
- **ที่เก็บเซสชัน**(ประวัติแชต+สถานะการกำหนดเส้นทาง)ภายใต้`~/.openclaw/agents/<agentId>/sessions`

โปรไฟล์การยืนยันตัวตนเป็นแบบ**ต่อเอเจนต์** เอเจนต์แต่ละตัวจะอ่านจากของตัวเอง:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

ข้อมูลรับรองของเอเจนต์หลักจะ**ไม่**ถูกแชร์โดยอัตโนมัติ ห้ามนำ`agentDir`มาใช้ซ้ำ
ข้ามเอเจนต์(จะทำให้การยืนยันตัวตน/เซสชันชนกัน) หากต้องการแชร์ข้อมูลรับรอง
ให้คัดลอก`auth-profiles.json`ไปยัง`agentDir`ของเอเจนต์อื่น

Skills เป็นแบบต่อเอเจนต์ผ่านโฟลเดอร์`skills/`ของแต่ละเวิร์กสเปซ โดยมี Skills ที่ใช้ร่วมกันได้จาก`~/.openclaw/skills` ดู[Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills)

Gatewayสามารถโฮสต์**เอเจนต์เดียว**(ค่าเริ่มต้น)หรือ**หลายเอเจนต์**แบบขนานกันได้

**หมายเหตุเวิร์กสเปซ:** เวิร์กสเปซของแต่ละเอเจนต์เป็น**cwd ค่าเริ่มต้น**ไม่ใช่sandboxแบบเข้มงวด เส้นทางสัมพัทธ์จะอ้างอิงภายในเวิร์กสเปซ แต่เส้นทางสัมบูรณ์สามารถเข้าถึงตำแหน่งอื่นของโฮสต์ได้ เว้นแต่จะเปิดsandboxing ดู[Sandboxing](/gateway/sandboxing)

## เส้นทาง(แผนที่ย่อ)

- คอนฟิก: `~/.openclaw/openclaw.json`(หรือ`OPENCLAW_CONFIG_PATH`)
- ไดเรกทอรีสถานะ: `~/.openclaw`(หรือ`OPENCLAW_STATE_DIR`)
- เวิร์กสเปซ: `~/.openclaw/workspace`(หรือ`~/.openclaw/workspace-<agentId>`)
- ไดเรกทอรีเอเจนต์: `~/.openclaw/agents/<agentId>/agent`(หรือ`agents.list[].agentDir`)
- เซสชัน: `~/.openclaw/agents/<agentId>/sessions`

### โหมดเอเจนต์เดียว(ค่าเริ่มต้น)

หากไม่ทำอะไร OpenClawจะรันเอเจนต์เดียว:

- `agentId`ค่าเริ่มต้นเป็น**`main`**
- เซสชันถูกคีย์เป็น`agent:main:<mainKey>`
- เวิร์กสเปซค่าเริ่มต้นเป็น`~/.openclaw/workspace`(หรือ`~/.openclaw/workspace-<profile>`เมื่อมีการตั้งค่า`OPENCLAW_PROFILE`)
- สถานะค่าเริ่มต้นเป็น`~/.openclaw/agents/main/agent`

## ตัวช่วยเอเจนต์

ใช้วิซาร์ดเอเจนต์เพื่อเพิ่มเอเจนต์ที่แยกจากกันใหม่:

```bash
openclaw agents add work
```

จากนั้นเพิ่ม`bindings`(หรือให้วิซาร์ดทำให้)เพื่อกำหนดเส้นทางข้อความขาเข้า

ตรวจสอบด้วย:

```bash
openclaw agents list --bindings
```

## หลายเอเจนต์=หลายคน หลายบุคลิก

เมื่อมี**หลายเอเจนต์** `agentId`แต่ละตัวจะกลายเป็น**บุคลิกที่แยกจากกันอย่างสมบูรณ์**:

- **หมายเลขโทรศัพท์/บัญชีต่างกัน**(ต่อช่องทาง`accountId`)
- **บุคลิกต่างกัน**(ไฟล์เวิร์กสเปซต่อเอเจนต์เช่น`AGENTS.md`และ`SOUL.md`)
- **การยืนยันตัวตน+เซสชันแยกกัน**(ไม่มีการปะปน เว้นแต่จะเปิดโดยตั้งใจ)

สิ่งนี้ทำให้**หลายคน**สามารถแชร์เซิร์ฟเวอร์Gatewayเดียวกันได้ โดยคงการแยกสมองAIและข้อมูลอย่างชัดเจน

## หมายเลขWhatsAppเดียว หลายคน(DM split)

คุณสามารถกำหนดเส้นทาง**DMของWhatsAppที่ต่างกัน**ไปยังเอเจนต์ต่างกันได้ ขณะใช้**บัญชีWhatsAppเดียว** จับคู่ตามผู้ส่งแบบE.164(เช่น`+15551234567`)ด้วย`peer.kind: "dm"` การตอบกลับยังคงมาจากหมายเลขWhatsAppเดียวกัน(ไม่มีตัวตนผู้ส่งต่อเอเจนต์)

รายละเอียดสำคัญ: แชตตรงจะถูกรวมไปยัง**คีย์เซสชันหลัก**ของเอเจนต์ ดังนั้นการแยกอย่างแท้จริงต้องใช้**หนึ่งเอเจนต์ต่อหนึ่งคน**

ตัวอย่าง:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

หมายเหตุ:

- การควบคุมการเข้าถึงDMเป็นแบบ**ส่วนกลางต่อบัญชีWhatsApp**(การจับคู่/allowlist)ไม่ใช่ต่อเอเจนต์
- สำหรับกลุ่มที่ใช้ร่วมกัน ให้ผูกกลุ่มกับเอเจนต์เดียวหรือใช้[Broadcast groups](/channels/broadcast-groups)

## กฎการกำหนดเส้นทาง(ข้อความเลือกเอเจนต์อย่างไร)

การผูกเป็นแบบ**กำหนดแน่นอน**และ**เฉพาะเจาะจงที่สุดชนะ**:

1. จับคู่`peer`(DM/กลุ่ม/รหัสช่องทางแบบตรง)
2. `guildId`(Discord)
3. `teamId`(Slack)
4. จับคู่`accountId`สำหรับช่องทาง
5. การจับคู่ระดับช่องทาง(`accountId: "*"`)
6. ย้อนกลับไปยังเอเจนต์เริ่มต้น(`agents.list[].default`หรือรายการแรก ค่าเริ่มต้น:`main`)

## หลายบัญชี/หลายหมายเลขโทรศัพท์

ช่องทางที่รองรับ**หลายบัญชี**(เช่น WhatsApp)จะใช้`accountId`เพื่อระบุการล็อกอินแต่ละครั้ง `accountId`แต่ละตัวสามารถกำหนดเส้นทางไปยังเอเจนต์ต่างกันได้ ทำให้เซิร์ฟเวอร์เดียวโฮสต์หลายหมายเลขได้โดยไม่ปะปนเซสชัน

## แนวคิด

- `agentId`: “สมอง”หนึ่งตัว(เวิร์กสเปซ การยืนยันตัวตนต่อเอเจนต์ ที่เก็บเซสชันต่อเอเจนต์)
- `accountId`: อินสแตนซ์บัญชีช่องทางหนึ่งตัว(เช่นบัญชีWhatsApp `"personal"`เทียบกับ`"biz"`)
- `binding`: กำหนดเส้นทางข้อความขาเข้าไปยัง`agentId`ด้วย`(channel, accountId, peer)`และอาจรวมถึงรหัสกิลด์/ทีม
- แชตตรงจะถูกรวมไปยัง`agent:<agentId>:<mainKey>`(“หลัก”ต่อเอเจนต์; `session.mainKey`)

## ตัวอย่าง: WhatsAppสองบัญชี→เอเจนต์สองตัว

`~/.openclaw/openclaw.json`(JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## ตัวอย่าง: WhatsAppคุยประจำวัน+Telegramทำงานลึก

แยกตามช่องทาง: กำหนดWhatsAppไปยังเอเจนต์เร็วสำหรับทุกวัน และTelegramไปยังเอเจนต์Opus

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

หมายเหตุ:

- หากมีหลายบัญชีสำหรับช่องทาง ให้เพิ่ม`accountId`ลงในการผูก(เช่น`{ channel: "whatsapp", accountId: "personal" }`)
- หากต้องการกำหนดDM/กลุ่มเดียวไปยังOpusขณะที่ที่เหลือยังคงเป็นแชต ให้เพิ่มการผูก`match.peer`สำหรับเพียร์นั้น การจับคู่เพียร์จะชนะกฎระดับช่องทางเสมอ

## ตัวอย่าง: ช่องทางเดียว เพียร์เดียวไปOpus

คงWhatsAppไว้ที่เอเจนต์เร็ว แต่กำหนดDMหนึ่งรายการไปยังOpus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

การผูกระดับเพียร์ชนะเสมอ ดังนั้นให้วางไว้เหนือกฎระดับช่องทาง

## เอเจนต์ครอบครัวผูกกับกลุ่มWhatsApp

ผูกเอเจนต์ครอบครัวเฉพาะกับกลุ่มWhatsAppเดียว พร้อมการควบคุมการกล่าวถึงและนโยบายเครื่องมือที่เข้มงวดกว่า:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

หมายเหตุ:

- รายการอนุญาต/ปฏิเสธเครื่องมือเป็น**เครื่องมือ**ไม่ใช่Skills หากSkillต้องรันไบนารี ให้แน่ใจว่าอนุญาต`exec`และมีไบนารีอยู่ในsandbox
- หากต้องการควบคุมที่เข้มงวดกว่า ให้ตั้งค่า`agents.list[].groupChat.mentionPatterns`และคงการเปิดใช้งานallowlistของกลุ่มสำหรับช่องทาง

## Sandboxและการกำหนดค่าเครื่องมือต่อเอเจนต์

ตั้งแต่v2026.1.6 เป็นต้นไป เอเจนต์แต่ละตัวสามารถมีsandboxและข้อจำกัดเครื่องมือของตัวเองได้:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

หมายเหตุ: `setupCommand`อยู่ภายใต้`sandbox.docker`และรันหนึ่งครั้งเมื่อสร้างคอนเทนเนอร์ การ override `sandbox.docker.*`ต่อเอเจนต์จะถูกละเลยเมื่อขอบเขตที่แก้ไขแล้วเป็น`"shared"`

**ประโยชน์:**

- **การแยกด้านความปลอดภัย**: จำกัดเครื่องมือสำหรับเอเจนต์ที่ไม่น่าเชื่อถือ
- **การควบคุมทรัพยากร**: ทำsandboxเฉพาะเอเจนต์ ขณะคงเอเจนต์อื่นบนโฮสต์
- **นโยบายยืดหยุ่น**: สิทธิ์ต่างกันต่อเอเจนต์

หมายเหตุ: `tools.elevated`เป็นแบบ**ส่วนกลาง**และอิงผู้ส่ง ไม่สามารถตั้งค่าต่อเอเจนต์ได้ หากต้องการขอบเขตต่อเอเจนต์ ให้ใช้`agents.list[].tools`เพื่อปฏิเสธ`exec` สำหรับการกำหนดเป้าหมายกลุ่ม ให้ใช้`agents.list[].groupChat.mentionPatterns`เพื่อให้@mentionแมปไปยังเอเจนต์ที่ตั้งใจได้อย่างชัดเจน

ดู[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)สำหรับตัวอย่างโดยละเอียด
