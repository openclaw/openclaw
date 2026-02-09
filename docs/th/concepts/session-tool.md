---
summary: "เครื่องมือเซสชันของเอเจนต์สำหรับการแสดงรายการเซสชัน การดึงประวัติ และการส่งข้อความข้ามเซสชัน"
read_when:
  - การเพิ่มหรือแก้ไขเครื่องมือเซสชัน
title: "เครื่องมือเซสชัน"
---

# เครื่องมือเซสชัน

เป้าหมาย: ชุดเครื่องมือขนาดเล็กที่ใช้งานผิดพลาดได้ยาก เพื่อให้เอเจนต์สามารถแสดงรายการเซสชัน ดึงประวัติ และส่งข้อความไปยังอีกเซสชันหนึ่งได้

## ชื่อเครื่องมือ

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## โมเดลคีย์

- บักเก็ตแชตตรงหลักจะเป็นคีย์ตัวอักษรตรงตัว `"main"` เสมอ (ถูกแปลงเป็นคีย์หลักของเอเจนต์ปัจจุบัน)
- แชตกลุ่มใช้ `agent:<agentId>:<channel>:group:<id>` หรือ `agent:<agentId>:<channel>:channel:<id>` (ส่งคีย์เต็ม)
- งาน Cron ใช้ `cron:<job.id>`
- Hooks ใช้ `hook:<uuid>` เว้นแต่จะตั้งค่าไว้ชัดเจน
- เซสชันของโหนดใช้ `node-<nodeId>` เว้นแต่จะตั้งค่าไว้ชัดเจน

37. `global` และ `unknown` เป็นค่าที่สงวนไว้และจะไม่ถูกแสดงรายการ `global` และ `unknown` เป็นค่าที่สงวนไว้และจะไม่ถูกแสดงรายการ หากเป็น `session.scope = "global"` เราจะทำการ alias เป็น `main` สำหรับทุกเครื่องมือ เพื่อให้ผู้เรียกไม่เห็น `global`

## sessions_list

แสดงรายการเซสชันเป็นอาร์เรย์ของแถว

พารามิเตอร์:

- ฟิลเตอร์ `kinds?: string[]`: ค่าใดค่าหนึ่งใน `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` จำนวนแถวสูงสุด (ค่าเริ่มต้น: ค่าเริ่มต้นของเซิร์ฟเวอร์ มีการ clamp เช่น 200)
- `activeMinutes?: number` เฉพาะเซสชันที่มีการอัปเดตภายใน N นาที
- `messageLimit?: number` 0 = ไม่มีข้อความ (ค่าเริ่มต้น 0); >0 = รวมข้อความล่าสุด N ข้อความ

พฤติกรรม:

- `messageLimit > 0` จะดึง `chat.history` ต่อเซสชันและรวมข้อความล่าสุด N ข้อความ
- ผลลัพธ์ของเครื่องมือจะถูกกรองออกจากเอาต์พุตรายการ ใช้ `sessions_history` สำหรับข้อความของเครื่องมือ
- เมื่อรันในเซสชันเอเจนต์ที่เป็น **sandboxed** เครื่องมือเซสชันจะตั้งค่าเริ่มต้นเป็น **การมองเห็นเฉพาะที่ spawn** (ดูด้านล่าง)

รูปแบบแถว (JSON):

- `key`: คีย์เซสชัน (สตริง)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (ป้ายแสดงผลกลุ่มหากมี)
- `updatedAt` (มิลลิวินาที)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (การ override เซสชันหากตั้งค่าไว้)
- `lastChannel`, `lastTo`
- `deliveryContext` (ค่า `{ channel, to, accountId }` ที่ถูก normalize เมื่อมี)
- `transcriptPath` (พาธแบบ best-effort ที่ได้จาก store dir + sessionId)
- `messages?` (เฉพาะเมื่อ `messageLimit > 0`)

## sessions_history

ดึงทรานสคริปต์ของหนึ่งเซสชัน

พารามิเตอร์:

- `sessionKey` (จำเป็น; รับคีย์เซสชันหรือ `sessionId` จาก `sessions_list`)
- `limit?: number` จำนวนข้อความสูงสุด (เซิร์ฟเวอร์ทำการ clamp)
- `includeTools?: boolean` (ค่าเริ่มต้น false)

พฤติกรรม:

- `includeTools=false` จะกรองข้อความ `role: "toolResult"`
- ส่งคืนอาร์เรย์ข้อความในรูปแบบทรานสคริปต์ดิบ
- เมื่อได้รับ `sessionId` OpenClaw จะแปลงเป็นคีย์เซสชันที่สอดคล้องกัน (หากไม่พบ id จะเกิดข้อผิดพลาด)

## sessions_send

ส่งข้อความเข้าไปยังอีกเซสชันหนึ่ง

พารามิเตอร์:

- `sessionKey` (จำเป็น; รับคีย์เซสชันหรือ `sessionId` จาก `sessions_list`)
- `message` (จำเป็น)
- `timeoutSeconds?: number` (ค่าเริ่มต้น >0; 0 = ส่งแบบ fire-and-forget)

พฤติกรรม:

- `timeoutSeconds = 0`: เข้าคิวและส่งคืน `{ runId, status: "accepted" }`
- `timeoutSeconds > 0`: รอสูงสุด N วินาทีจนเสร็จสิ้น จากนั้นส่งคืน `{ runId, status: "ok", reply }`
- หากหมดเวลารอ: `{ runId, status: "timeout", error }` การรันยังคงดำเนินต่อไป เรียก `sessions_history` ภายหลัง 38. การรันจะดำเนินต่อไป; เรียก `sessions_history` ภายหลัง
- หากการรันล้มเหลว: `{ runId, status: "error", error }`
- การประกาศการส่งหลังจากการรันหลักเสร็จสิ้นเป็นแบบ best-effort; `status: "ok"` ไม่รับประกันว่าการประกาศจะถูกส่งถึง
- การรอทำผ่าน Gateway `agent.wait` (ฝั่งเซิร์ฟเวอร์) เพื่อให้การเชื่อมต่อใหม่ไม่ทำให้การรอหลุด
- บริบทข้อความระหว่างเอเจนต์จะถูกฉีดสำหรับการรันหลัก
- หลังจากการรันหลักเสร็จสิ้น OpenClaw จะรัน **ลูปตอบกลับ**:
  - รอบที่ 2+ จะสลับระหว่างเอเจนต์ผู้ร้องขอและเอเจนต์เป้าหมาย
  - ตอบกลับเป็น `REPLY_SKIP` แบบตรงตัวเพื่อหยุดการ ping‑pong
  - จำนวนรอบสูงสุดคือ `session.agentToAgent.maxPingPongTurns` (0–5 ค่าเริ่มต้น 5)
- เมื่อจบลูป OpenClaw จะรัน **ขั้นตอนประกาศเอเจนต์‑ต่อ‑เอเจนต์** (เฉพาะเอเจนต์เป้าหมาย):
  - ตอบกลับเป็น `ANNOUNCE_SKIP` แบบตรงตัวเพื่อไม่ส่งเสียง
  - การตอบกลับอื่นใดจะถูกส่งไปยังช่องทางเป้าหมาย
  - ขั้นตอนประกาศรวมคำขอดั้งเดิม + การตอบกลับรอบที่ 1 + การตอบกลับ ping‑pong ล่าสุด

## ฟิลด์ Channel

- สำหรับกลุ่ม `channel` คือช่องทางที่บันทึกไว้ในรายการเซสชัน
- สำหรับแชตตรง `channel` จะแมปจาก `lastChannel`
- สำหรับ cron/hook/node `channel` คือ `internal`
- หากไม่มี `channel` จะเป็น `unknown`

## ความปลอดภัย / นโยบายการส่ง

การบล็อกตามนโยบายโดยอิงตามช่องทาง/ประเภทแชต (ไม่ใช่ต่อ session id)

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

การ override ขณะรัน (ต่อรายการเซสชัน):

- `sendPolicy: "allow" | "deny"` (unset = สืบทอดจากคอนฟิก)
- ตั้งค่าได้ผ่าน `sessions.patch` หรือ `/send on|off|inherit` เฉพาะเจ้าของ (ข้อความแบบสแตนด์อโลน)

จุดบังคับใช้:

- `chat.send` / `agent` (Gateway)
- ตรรกะการส่ง auto-reply

## sessions_spawn

สร้างการรันของซับเอเจนต์ในเซสชันที่แยกต่างหากและประกาศผลกลับไปยังช่องทางแชตของผู้ร้องขอ

พารามิเตอร์:

- `task` (จำเป็น)
- `label?` (ไม่บังคับ; ใช้สำหรับล็อก/UI)
- `agentId?` (ไม่บังคับ; สร้างภายใต้ agent id อื่นหากได้รับอนุญาต)
- `model?` (ไม่บังคับ; override โมเดลของซับเอเจนต์; ค่าที่ไม่ถูกต้องจะเกิดข้อผิดพลาด)
- `runTimeoutSeconds?` (ค่าเริ่มต้น 0; เมื่อกำหนด จะยกเลิกการรันซับเอเจนต์หลัง N วินาที)
- `cleanup?` (`delete|keep`, ค่าเริ่มต้น `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: รายการ agent id ที่อนุญาตผ่าน `agentId` (`["*"]` เพื่ออนุญาตทั้งหมด) ค่าเริ่มต้น: เฉพาะเอเจนต์ผู้ร้องขอ 39. ค่าเริ่มต้น: เฉพาะเอเจนต์ที่ร้องขอ

Discovery:

- ใช้ `agents_list` เพื่อค้นหาว่า agent id ใดได้รับอนุญาตสำหรับ `sessions_spawn`

พฤติกรรม:

- เริ่มเซสชัน `agent:<agentId>:subagent:<uuid>` ใหม่ด้วย `deliver: false`
- ซับเอเจนต์จะใช้ชุดเครื่องมือเต็ม **ยกเว้นเครื่องมือเซสชัน** เป็นค่าเริ่มต้น (ปรับได้ผ่าน `tools.subagents.tools`)
- ซับเอเจนต์ไม่อนุญาตให้เรียก `sessions_spawn` (ไม่มีการ spawn ซับเอเจนต์ → ซับเอเจนต์)
- ไม่บล็อกเสมอ: ส่งคืน `{ status: "accepted", runId, childSessionKey }` ทันที
- หลังจากเสร็จสิ้น OpenClaw จะรัน **ขั้นตอนประกาศ** ของซับเอเจนต์และโพสต์ผลไปยังช่องทางแชตของผู้ร้องขอ
- ตอบกลับเป็น `ANNOUNCE_SKIP` แบบตรงตัวระหว่างขั้นตอนประกาศเพื่อไม่ส่งเสียง
- การตอบกลับประกาศจะถูก normalize เป็น `Status`/`Result`/`Notes`; `Status` มาจากผลลัพธ์ขณะรัน (ไม่ใช่ข้อความจากโมเดล)
- เซสชันซับเอเจนต์จะถูกเก็บถาวรอัตโนมัติหลัง `agents.defaults.subagents.archiveAfterMinutes` (ค่าเริ่มต้น: 60)
- การตอบกลับประกาศรวมบรรทัดสถิติ (เวลาในการรัน โทเคน sessionKey/sessionId พาธทรานสคริปต์ และค่าใช้จ่ายถ้ามี)

## การมองเห็นเซสชันแบบ Sandbox

เซสชันที่เป็น sandboxed สามารถใช้เครื่องมือเซสชันได้ แต่ค่าเริ่มต้นจะเห็นเฉพาะเซสชันที่ตน spawn ผ่าน `sessions_spawn` เท่านั้น

คอนฟิก:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
