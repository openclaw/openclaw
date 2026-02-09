---
summary: "Models CLI: รายการ ตั้งค่า นามแฝง ฟอลแบ็ก สแกน สถานะ"
read_when:
  - การเพิ่มหรือแก้ไข Models CLI (models list/set/scan/aliases/fallbacks)
  - การเปลี่ยนพฤติกรรมฟอลแบ็กของโมเดลหรือ UX การเลือก
  - การอัปเดตโพรบการสแกนโมเดล (เครื่องมือ/รูปภาพ)
title: "Models CLI"
---

# Models CLI

ดู [/concepts/model-failover](/concepts/model-failover) สำหรับการหมุนเวียนโปรไฟล์การยืนยันตัวตน คูลดาวน์ และวิธีที่สิ่งเหล่านี้ทำงานร่วมกับฟอลแบ็ก
ภาพรวมผู้ให้บริการแบบย่อพร้อมตัวอย่าง: [/concepts/model-providers](/concepts/model-providers)
Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

## การเลือกโมเดลทำงานอย่างไร

OpenClaw เลือกโมเดลตามลำดับดังนี้:

1. **Primary** โมเดล (`agents.defaults.model.primary` หรือ `agents.defaults.model`).
2. **Fallbacks** ใน `agents.defaults.model.fallbacks` (ตามลำดับ).
3. **Provider auth failover** จะเกิดขึ้นภายในผู้ให้บริการก่อนจะย้ายไปยังโมเดลถัดไป

ที่เกี่ยวข้อง:

- `agents.defaults.models` คือ allowlist/แคตตาล็อกของโมเดลที่ OpenClaw ใช้ได้ (รวมถึงนามแฝง)
- `agents.defaults.imageModel` ใช้ **เฉพาะเมื่อ** primary โมเดลไม่รองรับรูปภาพ
- ค่าเริ่มต้นต่อเอเจนต์สามารถ override `agents.defaults.model` ผ่าน `agents.list[].model` พร้อม bindings (ดู [/concepts/multi-agent](/concepts/multi-agent))

## ตัวเลือกโมเดลด่วน (เชิงประสบการณ์)

- **GLM**: ดีกว่าเล็กน้อยสำหรับการเขียนโค้ด/เรียกใช้เครื่องมือ
- **MiniMax**: ดีกว่าสำหรับการเขียนและโทน/อารมณ์

## Setup wizard (แนะนำ)

หากไม่ต้องการแก้ไขคอนฟิกด้วยตนเอง ให้รันวิซาร์ดเริ่มต้นใช้งาน:

```bash
openclaw onboard
```

สามารถตั้งค่าโมเดล + การยืนยันตัวตนสำหรับผู้ให้บริการที่พบบ่อย รวมถึง **OpenAI Code (Codex)
subscription** (OAuth) และ **Anthropic** (แนะนำ API key; รองรับ `claude
setup-token` ด้วย)

## คีย์คอนฟิก (ภาพรวม)

- `agents.defaults.model.primary` และ `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` และ `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + นามแฝง + พารามิเตอร์ผู้ให้บริการ)
- `models.providers` (ผู้ให้บริการแบบกำหนดเองที่เขียนลงใน `models.json`)

Model refs are normalized to lowercase. อ้างอิงโมเดลจะถูก normalize เป็นตัวพิมพ์เล็ก นามแฝงผู้ให้บริการอย่าง `z.ai/*` จะ normalize
เป็น `zai/*`.

ตัวอย่างการกำหนดค่าผู้ให้บริการ (รวม OpenCode Zen) อยู่ที่
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)

## “Model is not allowed” (และเหตุผลที่การตอบกลับหยุด)

หากตั้งค่า `agents.defaults.models` จะกลายเป็น **allowlist** สำหรับ `/model` และสำหรับ
session overrides เมื่อผู้ใช้เลือกโมเดลที่ไม่อยู่ใน allowlist นั้น
OpenClaw จะส่งกลับ: When a user selects a model that isn’t in that allowlist,
OpenClaw returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

เหตุการณ์นี้เกิดขึ้น **ก่อน** การสร้างคำตอบตามปกติ ดังนั้นข้อความอาจดูเหมือน
“ไม่ตอบกลับ” วิธีแก้คืออย่างใดอย่างหนึ่ง: The fix is to either:

- เพิ่มโมเดลลงใน `agents.defaults.models`, หรือ
- ล้าง allowlist (ลบ `agents.defaults.models`), หรือ
- เลือกโมเดลจาก `/model list`.

ตัวอย่างคอนฟิก allowlist:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## การสลับโมเดลในแชต (`/model`)

คุณสามารถสลับโมเดลสำหรับเซสชันปัจจุบันได้โดยไม่ต้องรีสตาร์ต:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

หมายเหตุ:

- `/model` (และ `/model list`) เป็นตัวเลือกแบบย่อ มีหมายเลข (ตระกูลโมเดล + ผู้ให้บริการที่ใช้ได้)
- `/model <#>` เลือกจากตัวเลือกนั้น
- `/model status` เป็นมุมมองรายละเอียด (ผู้สมัครการยืนยันตัวตน และเมื่อกำหนดค่าแล้ว จุดปลายทางผู้ให้บริการ `baseUrl` + โหมด `api`)
- การอ้างอิงโมเดลจะถูกพาร์สโดยแยกที่ `/` **ครั้งแรก** ใช้ `provider/model` เมื่อพิมพ์ `/model <ref>` Use `provider/model` when typing `/model <ref>`.
- หาก ID โมเดลมี `/` อยู่แล้ว (สไตล์ OpenRouter) ต้องใส่คำนำหน้าผู้ให้บริการ (ตัวอย่าง: `/model openrouter/moonshotai/kimi-k2`)
- หากละคำนำหน้าผู้ให้บริการ OpenClaw จะมองอินพุตเป็นนามแฝงหรือโมเดลของ **ผู้ให้บริการเริ่มต้น** (ใช้ได้เฉพาะเมื่อไม่มี `/` ใน ID โมเดล)

พฤติกรรม/คอนฟิกของคำสั่งทั้งหมด: [Slash commands](/tools/slash-commands)

## คำสั่ง CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (ไม่มีซับคอมมานด์) เป็นทางลัดของ `models status`.

### `models list`

แสดงโมเดลที่กำหนดค่าไว้เป็นค่าเริ่มต้น แฟล็กที่มีประโยชน์: Useful flags:

- `--all`: แคตตาล็อกทั้งหมด
- `--local`: ผู้ให้บริการภายในเครื่องเท่านั้น
- `--provider <name>`: กรองตามผู้ให้บริการ
- `--plain`: หนึ่งโมเดลต่อหนึ่งบรรทัด
- `--json`: เอาต์พุตที่อ่านโดยเครื่องได้

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview
of configured providers. แสดง primary โมเดลที่ resolve แล้ว ฟอลแบ็ก โมเดลรูปภาพ และภาพรวมการยืนยันตัวตน
ของผู้ให้บริการที่กำหนดค่าไว้ นอกจากนี้ยังแสดงสถานะการหมดอายุ OAuth สำหรับโปรไฟล์ที่พบ
ในคลังการยืนยันตัวตน (เตือนล่วงหน้า 24 ชม. `--plain` prints only the
resolved primary model.
OAuth status is always shown (and included in `--json` output). If a configured
provider has no credentials, `models status` prints a **Missing auth** section.
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`
(effective auth per provider).
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).

การยืนยันตัวตน Anthropic ที่แนะนำคือ Claude Code CLI setup-token (รันได้ทุกที่; คัดลอกไปวางบนโฮสต์Gateway หากจำเป็น):

```bash
claude setup-token
openclaw models status
```

## การสแกน (โมเดลฟรีของ OpenRouter)

`openclaw models scan` ตรวจสอบ **แคตตาล็อกโมเดลฟรี** ของ OpenRouter และสามารถ
โพรบโมเดลเพื่อรองรับเครื่องมือและรูปภาพได้ตามตัวเลือก

แฟล็กสำคัญ:

- `--no-probe`: ข้ามการโพรบแบบสด (เฉพาะเมทาดาทา)
- `--min-params <b>`: ขนาดพารามิเตอร์ขั้นต่ำ (พันล้าน)
- `--max-age-days <days>`: ข้ามโมเดลเก่า
- `--provider <name>`: ตัวกรองคำนำหน้าผู้ให้บริการ
- `--max-candidates <n>`: ขนาดรายการฟอลแบ็ก
- `--set-default`: ตั้งค่า `agents.defaults.model.primary` เป็นตัวเลือกแรก
- `--set-image`: ตั้งค่า `agents.defaults.imageModel.primary` เป็นตัวเลือกรูปภาพแรก

การโพรบต้องใช้ OpenRouter API key (จากโปรไฟล์การยืนยันตัวตนหรือ
`OPENROUTER_API_KEY`) หากไม่มีคีย์ ให้ใช้ `--no-probe` เพื่อแสดงเฉพาะผู้สมัคร Without a key, use `--no-probe` to list candidates only.

ผลการสแกนจะถูกจัดอันดับตาม:

1. รองรับรูปภาพ
2. เวลาแฝงของเครื่องมือ
3. ขนาดคอนเท็กซ์
4. จำนวนพารามิเตอร์

อินพุต

- รายการ OpenRouter `/models` (กรอง `:free`)
- ต้องใช้ OpenRouter API key จากโปรไฟล์การยืนยันตัวตนหรือ `OPENROUTER_API_KEY` (ดู [/environment](/help/environment))
- ตัวกรองเสริม: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- การควบคุมการโพรบ: `--timeout`, `--concurrency`

เมื่อรันใน TTY คุณสามารถเลือกฟอลแบ็กแบบโต้ตอบได้ ในโหมดไม่โต้ตอบ
ให้ส่ง `--yes` เพื่อยอมรับค่าเริ่มต้น In non‑interactive
mode, pass `--yes` to accept defaults.

## ทะเบียนโมเดล (`models.json`)

ผู้ให้บริการแบบกำหนดเองใน `models.providers` จะถูกเขียนลงใน `models.json` ภายใต้
ไดเรกทอรีเอเจนต์ (ค่าเริ่มต้น `~/.openclaw/agents/<agentId>/models.json`) ไฟล์นี้
จะถูกรวมโดยค่าเริ่มต้น เว้นแต่ตั้งค่า `models.mode` เป็น `replace`. This file
is merged by default unless `models.mode` is set to `replace`.
