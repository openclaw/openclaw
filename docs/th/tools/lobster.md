---
title: Lobster
summary: "รันไทม์เวิร์กโฟลว์แบบมีชนิดสำหรับ OpenClaw พร้อมเกตการอนุมัติที่สามารถกลับมาทำต่อได้"
description: รันไทม์เวิร์กโฟลว์แบบมีชนิดสำหรับ OpenClaw — ไปป์ไลน์ที่ประกอบกันได้พร้อมเกตการอนุมัติ
read_when:
  - คุณต้องการเวิร์กโฟลว์หลายขั้นตอนที่กำหนดผลลัพธ์ได้แน่นอนพร้อมการอนุมัติที่ชัดเจน
  - คุณต้องการกลับมาทำเวิร์กโฟลว์ต่อโดยไม่ต้องรันขั้นตอนก่อนหน้าใหม่
---

# Lobster

Lobster คือเชลล์เวิร์กโฟลว์ที่ทำให้ OpenClaw สามารถรันลำดับเครื่องมือหลายขั้นตอนเป็นการทำงานเดียวที่กำหนดผลลัพธ์ได้แน่นอน พร้อมจุดตรวจการอนุมัติที่ชัดเจน

## Hook

Your assistant can build the tools that manage itself. Ask for a workflow, and 30 minutes later you have a CLI plus pipelines that run as one call. Lobster is the missing piece: deterministic pipelines, explicit approvals, and resumable state.

## Why

Today, complex workflows require many back-and-forth tool calls. Each call costs tokens, and the LLM has to orchestrate every step. Lobster moves that orchestration into a typed runtime:

- **หนึ่งการเรียกแทนหลายครั้ง**: OpenClaw เรียกเครื่องมือ Lobster เพียงครั้งเดียวและได้ผลลัพธ์ที่มีโครงสร้าง
- **มีการอนุมัติในตัว**: ผลข้างเคียง (ส่งอีเมล โพสต์คอมเมนต์) จะหยุดเวิร์กโฟลว์จนกว่าจะได้รับการอนุมัติอย่างชัดเจน
- **กลับมาทำต่อได้**: เวิร์กโฟลว์ที่หยุดจะคืนโทเคน อนุมัติแล้วกลับมาทำต่อได้โดยไม่ต้องรันทุกอย่างใหม่

## Why a DSL instead of plain programs?

Lobster is intentionally small. Lobster ถูกออกแบบให้เล็กโดยตั้งใจ เป้าหมายไม่ใช่ “ภาษาใหม่” แต่เป็นสเปกไปป์ไลน์ที่คาดเดาได้ เป็นมิตรกับ AI และมีการอนุมัติและโทเคนสำหรับทำต่อเป็นองค์ประกอบชั้นหนึ่ง

- **การอนุมัติ/ทำต่อมีมาให้ในตัว**: โปรแกรมทั่วไปอาจขอให้มนุษย์ยืนยันได้ แต่ไม่สามารถ _หยุดและกลับมาทำต่อ_ ด้วยโทเคนถาวรได้หากคุณไม่สร้างรันไทม์นั้นเอง
- **กำหนดผลลัพธ์ได้แน่นอน + ตรวจสอบย้อนหลังได้**: ไปป์ไลน์เป็นข้อมูล จึงบันทึก เปรียบเทียบ เล่นซ้ำ และรีวิวได้ง่าย
- **พื้นที่ผิวจำกัดสำหรับ AI**: ไวยากรณ์ขนาดเล็ก + การส่งผ่าน JSON ลดเส้นทางโค้ดที่ “สร้างสรรค์เกินไป” และทำให้การตรวจสอบทำได้จริง
- **นโยบายความปลอดภัยฝังในตัว**: การตั้งค่า timeout ขีดจำกัดเอาต์พุต การตรวจ sandbox และ allowlist ถูกบังคับใช้โดยรันไทม์ ไม่ใช่แต่ละสคริปต์
- **ยังเขียนโปรแกรมได้**: แต่ละขั้นสามารถเรียก CLI หรือสคริปต์ใดก็ได้ หากต้องการ JS/TS ให้สร้างไฟล์ `.lobster` จากโค้ด If you want JS/TS, generate `.lobster` files from code.

## How it works

OpenClaw เรียกใช้ CLI `lobster` ภายในเครื่องใน **tool mode** และพาร์สซองจดหมาย JSON จาก stdout
หากไปป์ไลน์หยุดเพื่อรอการอนุมัติ เครื่องมือจะคืนค่า `resumeToken` เพื่อให้คุณกลับมาทำต่อภายหลัง
If the pipeline pauses for approval, the tool returns a `resumeToken` so you can continue later.

## Pattern: small CLI + JSON pipes + approvals

สร้างคำสั่งเล็กๆ ที่สื่อสารด้วย JSON แล้วเชื่อมต่อเป็นการเรียก Lobster ครั้งเดียว (ชื่อตัวอย่างด้านล่าง — เปลี่ยนเป็นของคุณได้) (Example command names below — swap in your own.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

หากไปป์ไลน์ร้องขอการอนุมัติ ให้ทำต่อด้วยโทเคน:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI triggers the workflow; Lobster executes the steps. Approval gates keep side effects explicit and auditable.

ตัวอย่าง: แมปอินพุตเป็นรายการเรียกเครื่องมือ:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

สำหรับเวิร์กโฟลว์ที่ต้องการ **ขั้นตอน LLM แบบมีโครงสร้าง** ให้เปิดใช้เครื่องมือปลั๊กอินเสริม
`llm-task` แล้วเรียกจาก Lobster วิธีนี้ทำให้เวิร์กโฟลว์ยังคงกำหนดผลลัพธ์ได้แน่นอน ขณะเดียวกันก็ยังจัดประเภท/สรุป/ร่างด้วยโมเดลได้ This keeps the workflow
deterministic while still letting you classify/summarize/draft with a model.

เปิดใช้เครื่องมือ:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

ใช้งานในไปป์ไลน์:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

ดูรายละเอียดและตัวเลือกการกำหนดค่าที่ [LLM Task](/tools/llm-task)

## Workflow files (.lobster)

Lobster สามารถรันไฟล์เวิร์กโฟลว์ YAML/JSON ที่มีฟิลด์ `name`, `args`, `steps`, `env`, `condition`, และ `approval` ในการเรียกเครื่องมือของ OpenClaw ให้ตั้งค่า `pipeline` เป็นพาธของไฟล์ In OpenClaw tool calls, set `pipeline` to the file path.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

หมายเหตุ:

- `stdin: $step.stdout` และ `stdin: $step.json` ส่งต่อเอาต์พุตของขั้นก่อนหน้า
- `condition` (หรือ `when`) สามารถใช้เป็นเกตขั้นตอนตาม `$step.approved`

## Install Lobster

ติดตั้ง Lobster CLI บน **โฮสต์เดียวกัน** กับที่รัน OpenClaw Gateway（เกตเวย์）(ดู [Lobster repo](https://github.com/openclaw/lobster)) และตรวจสอบให้แน่ใจว่า `lobster` อยู่ใน `PATH`
หากต้องการใช้ตำแหน่งไบนารีแบบกำหนดเอง ให้ส่ง `lobsterPath` แบบ **absolute** ในการเรียกเครื่องมือ
If you want to use a custom binary location, pass an **absolute** `lobsterPath` in the tool call.

## Enable the tool

Lobster เป็นเครื่องมือปลั๊กอินแบบ **ไม่บังคับ** (ปิดใช้งานเป็นค่าเริ่มต้น)

แนะนำ (เพิ่มแบบปลอดภัย):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

หรือแบบต่อเอเจนต์:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

หลีกเลี่ยงการใช้ `tools.allow: ["lobster"]` เว้นแต่คุณตั้งใจจะรันในโหมด allowlist ที่เข้มงวด

Note: allowlists are opt-in for optional plugins. หมายเหตุ: allowlist เป็นแบบ opt-in สำหรับปลั๊กอินเสริม หาก allowlist ของคุณระบุเฉพาะ
เครื่องมือปลั๊กอิน (เช่น `lobster`) OpenClaw จะยังคงเปิดใช้งานเครื่องมือแกนหลักไว้ หากต้องการจำกัดเครื่องมือแกนหลัก
ให้ใส่เครื่องมือหรือกลุ่มแกนหลักที่ต้องการลงใน allowlist ด้วย To restrict core
tools, include the core tools or groups you want in the allowlist too.

## Example: Email triage

หากไม่มี Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

เมื่อใช้ Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

คืนค่าเป็นซองจดหมาย JSON (ตัดทอน):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

ผู้ใช้อนุมัติ → ทำต่อ:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

One workflow. Deterministic. Safe.

## Tool parameters

### `run`

รันไปป์ไลน์ในโหมดเครื่องมือ

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

รันไฟล์เวิร์กโฟลว์พร้อมอาร์กิวเมนต์:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

ทำต่อเวิร์กโฟลว์ที่หยุดหลังการอนุมัติ

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: พาธแบบ absolute ไปยังไบนารี Lobster (เว้นไว้เพื่อใช้ `PATH`)
- `cwd`: ไดเรกทอรีทำงานสำหรับไปป์ไลน์ (ค่าเริ่มต้นคือไดเรกทอรีทำงานของโปรเซสปัจจุบัน)
- `timeoutMs`: ยุติโปรเซสย่อยหากเกินระยะเวลานี้ (ค่าเริ่มต้น: 20000)
- `maxStdoutBytes`: ยุติโปรเซสย่อยหาก stdout เกินขนาดนี้ (ค่าเริ่มต้น: 512000)
- `argsJson`: สตริง JSON ที่ส่งให้ `lobster run --args-json` (เฉพาะไฟล์เวิร์กโฟลว์)

## Output envelope

Lobster คืนค่าซองจดหมาย JSON ที่มีสถานะหนึ่งในสามแบบ:

- `ok` → เสร็จสิ้นสำเร็จ
- `needs_approval` → หยุดชั่วคราว; ต้องใช้ `requiresApproval.resumeToken` เพื่อทำต่อ
- `cancelled` → ถูกปฏิเสธหรือยกเลิกอย่างชัดเจน

เครื่องมือจะแสดงซองจดหมายทั้งใน `content` (JSON ที่อ่านง่าย) และ `details` (อ็อบเจ็กต์ดิบ)

## Approvals

หากมี `requiresApproval` ให้ตรวจสอบพรอมป์ต์และตัดสินใจ:

- `approve: true` → ทำต่อและดำเนินการผลข้างเคียง
- `approve: false` → ยกเลิกและปิดเวิร์กโฟลว์

ใช้ `approve --preview-from-stdin --limit N` เพื่อแนบตัวอย่าง JSON ไปกับคำขออนุมัติโดยไม่ต้องใช้ jq/heredoc แบบกำหนดเอง โทเคนสำหรับทำต่อมีขนาดเล็กลงแล้ว: Lobster เก็บสถานะการทำต่อของเวิร์กโฟลว์ไว้ใต้ไดเรกทอรีสถานะของตน และส่งคืนคีย์โทเคนขนาดเล็ก Resume tokens are now compact: Lobster stores workflow resume state under its state dir and hands back a small token key.

## OpenProse

OpenProse ทำงานคู่กับ Lobster ได้ดี: ใช้ `/prose` เพื่อจัดการเตรียมงานหลายเอเจนต์ จากนั้นรันไปป์ไลน์ Lobster เพื่อการอนุมัติที่กำหนดผลลัพธ์ได้แน่นอน หากโปรแกรม Prose ต้องใช้ Lobster ให้อนุญาตเครื่องมือ `lobster` สำหรับซับเอเจนต์ผ่าน `tools.subagents.tools` ดู [OpenProse](/prose) If a Prose program needs Lobster, allow the `lobster` tool for sub-agents via `tools.subagents.tools`. See [OpenProse](/prose).

## Safety

- **เฉพาะ subprocess ภายในเครื่อง** — ไม่มีการเรียกเครือข่ายจากปลั๊กอินเอง
- **ไม่มีความลับ** — Lobster ไม่จัดการ OAuth; มันเรียกใช้เครื่องมือ OpenClaw ที่ทำหน้าที่นั้น
- **รับรู้ sandbox** — ปิดใช้งานเมื่อบริบทเครื่องมืออยู่ใน sandbox
- **เสริมความแข็งแกร่ง** — `lobsterPath` ต้องเป็นพาธแบบ absolute หากระบุ; บังคับใช้ timeout และขีดจำกัดเอาต์พุต

## Troubleshooting

- **`lobster subprocess timed out`** → เพิ่ม `timeoutMs` หรือแยกไปป์ไลน์ที่ยาว
- **`lobster output exceeded maxStdoutBytes`** → เพิ่ม `maxStdoutBytes` หรือ ลดขนาดเอาต์พุต
- **`lobster returned invalid JSON`** → ตรวจสอบให้แน่ใจว่าไปป์ไลน์รันใน tool mode และพิมพ์เฉพาะ JSON
- **`lobster failed (code …)`** → รันไปป์ไลน์เดียวกันในเทอร์มินัลเพื่อดู stderr

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

One public example: a “second brain” CLI + Lobster pipelines that manage three Markdown vaults (personal, partner, shared). ตัวอย่างสาธารณะหนึ่ง: CLI “second brain” + ไปป์ไลน์ Lobster ที่จัดการคลัง Markdown สามชุด (ส่วนตัว พาร์ทเนอร์ และแชร์ร่วม) CLI ส่งออก JSON สำหรับสถิติ รายการกล่องขาเข้า และการสแกนรายการค้าง; Lobster เชื่อมคำสั่งเหล่านั้นเป็นเวิร์กโฟลว์อย่าง `weekly-review`, `inbox-triage`, `memory-consolidation`, และ `shared-task-sync` โดยแต่ละรายการมีเกตการอนุมัติ AI จัดการการตัดสินใจ (การจัดหมวดหมู่) เมื่อพร้อมใช้งาน และถอยกลับไปใช้กฎที่กำหนดผลลัพธ์ได้แน่นอนเมื่อไม่พร้อม AI handles judgment (categorization) when available and falls back to deterministic rules when not.

- กระทู้: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- รีโป: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
