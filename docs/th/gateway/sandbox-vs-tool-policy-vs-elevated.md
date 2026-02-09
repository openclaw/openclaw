---
title: Sandbox เทียบกับ Tool Policy เทียบกับ Elevated
summary: "เหตุผลที่เครื่องมือถูกบล็อก: runtime ของ sandbox, นโยบายอนุญาต/ปฏิเสธเครื่องมือ, และเกตการรันแบบ elevated"
read_when: "เมื่อคุณเจอ 'sandbox jail' หรือเห็นการปฏิเสธ tool/elevated และต้องการคีย์คอนฟิกที่ต้องแก้ไขอย่างชัดเจน"
status: active
---

# Sandbox เทียบกับ Tool Policy เทียบกับ Elevated

OpenClaw มีการควบคุมที่เกี่ยวข้องกันสามอย่าง (แต่แตกต่างกัน):

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) ตัดสินใจว่า **เครื่องมือรันที่ไหน** (Docker เทียบกับ โฮสต์)
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) ตัดสินใจว่า **มี/อนุญาตเครื่องมือใดบ้าง**
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) คือ **ช่องทางหนีสำหรับ exec เท่านั้น** เพื่อรันบนโฮสต์เมื่อคุณอยู่ใน sandbox

## ดีบักอย่างรวดเร็ว

ใช้ inspector เพื่อดูว่า OpenClaw _กำลังทำอะไรจริง ๆ_:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

มันจะแสดง:

- โหมด/ขอบเขต sandbox และการเข้าถึงเวิร์กสเปซที่มีผลจริง
- ว่าเซสชันปัจจุบันอยู่ใน sandbox หรือไม่ (main เทียบกับ non-main)
- การอนุญาต/ปฏิเสธเครื่องมือของ sandbox ที่มีผลจริง (และมาจาก agent/global/default หรือไม่)
- เกตของ elevated และพาธคีย์สำหรับแก้ไข

## Sandbox: เครื่องมือรันที่ไหน

การทำ sandboxing ควบคุมด้วย `agents.defaults.sandbox.mode`:

- `"off"`: ทุกอย่างรันบนโฮสต์
- `"non-main"`: เฉพาะเซสชันที่ไม่ใช่ main เท่านั้นที่ถูก sandbox (มักทำให้ “เซอร์ไพรส์” ในกลุ่ม/ช่องทาง)
- `"all"`: ทุกอย่างถูก sandbox

ดู [Sandboxing](/gateway/sandboxing) สำหรับเมทริกซ์ทั้งหมด (ขอบเขต, การเมานต์เวิร์กสเปซ, อิมเมจ)

### Bind mounts (เช็กความปลอดภัยแบบเร็ว)

- `docker.binds` _ทะลุ_ ระบบไฟล์ของ sandbox: สิ่งที่คุณเมานต์จะมองเห็นได้ภายในคอนเทนเนอร์ตามโหมดที่ตั้งไว้ (`:ro` หรือ `:rw`)
- ค่าเริ่มต้นคืออ่าน-เขียน หากไม่ระบุโหมด; ควรใช้ `:ro` สำหรับซอร์ส/ความลับ
- `scope: "shared"` จะไม่สนใจ bind ต่อเอเจนต์ (ใช้เฉพาะ bind แบบ global)
- การ bind `/var/run/docker.sock` เท่ากับมอบการควบคุมโฮสต์ให้ sandbox; ควรทำเฉพาะเมื่อเจตนาชัดเจน
- การเข้าถึงเวิร์กสเปซ (`workspaceAccess: "ro"`/`"rw"`) แยกอิสระจากโหมด bind

## Tool policy: เครื่องมือใดมีอยู่/เรียกใช้ได้

มีสองชั้นที่สำคัญ:

- **Tool profile**: `tools.profile` และ `agents.list[].tools.profile` (รายการอนุญาตพื้นฐาน)
- **Provider tool profile**: `tools.byProvider[provider].profile` และ `agents.list[].tools.byProvider[provider].profile`
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` และ `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` และ `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox tool policy** (ใช้เฉพาะเมื่ออยู่ใน sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` และ `agents.list[].tools.sandbox.tools.*`

กฎโดยสรุป:

- `deny` ชนะเสมอ
- หาก `allow` ไม่ว่าง ทุกอย่างอื่นจะถือว่าถูกบล็อก
- Tool policy คือจุดหยุดแบบเด็ดขาด: `/exec` ไม่สามารถแทนที่เครื่องมือ `exec` ที่ถูกปฏิเสธได้
- `/exec` เปลี่ยนค่าเริ่มต้นของเซสชันสำหรับผู้ส่งที่ได้รับอนุญาตเท่านั้น ไม่ได้ให้สิทธิ์เข้าถึงเครื่องมือ
  คีย์เครื่องมือของ provider รองรับทั้ง `provider` (เช่น `google-antigravity`) หรือ `provider/model` (เช่น `openai/gpt-5.2`)
  คีย์เครื่องมือของผู้ให้บริการรองรับทั้ง `provider` (เช่น `google-antigravity`) หรือ `provider/model` (เช่น `openai/gpt-5.2`)

### Tool groups (ตัวย่อ)

นโยบายเครื่องมือ (global, agent, sandbox) รองรับรายการ `group:*` ที่ขยายเป็นหลายเครื่องมือ:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

กลุ่มที่มีให้:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: เครื่องมือ OpenClaw แบบบิลต์อินทั้งหมด (ไม่รวมปลั๊กอินของ provider)

## Elevated: “รันบนโฮสต์” สำหรับ exec เท่านั้น

Elevated **ไม่ได้**ให้เครื่องมือเพิ่ม; ส่งผลเฉพาะกับ `exec` เท่านั้น

- หากคุณอยู่ใน sandbox, `/elevated on` (หรือ `exec` พร้อม `elevated: true`) จะรันบนโฮสต์ (อาจยังต้องมีการอนุมัติ)
- ใช้ `/elevated full` เพื่อข้ามการอนุมัติการรันคำสั่งสำหรับเซสชัน
- หากคุณรันแบบ direct อยู่แล้ว elevated จะเทียบเท่ากับไม่ทำอะไร (ยังถูกคุมเกตอยู่)
- Elevated **ไม่**ผูกกับ Skills และ **ไม่**แทนที่การอนุญาต/ปฏิเสธเครื่องมือ
- `/exec` แยกจาก elevated `/exec` แยกจาก elevated โดยจะปรับค่าเริ่มต้นการ exec ต่อเซสชันสำหรับผู้ส่งที่ได้รับอนุญาตเท่านั้น

เกต:

- การเปิดใช้งาน: `tools.elevated.enabled` (และอาจมี `agents.list[].tools.elevated.enabled`)
- รายการอนุญาตผู้ส่ง: `tools.elevated.allowFrom.<provider>` (และอาจมี `agents.list[].tools.elevated.allowFrom.<provider>`)

ดู [Elevated Mode](/tools/elevated)

## วิธีแก้ “sandbox jail” ที่พบบ่อย

### “เครื่องมือ X ถูกบล็อกโดย sandbox tool policy”

คีย์สำหรับแก้ไข (เลือกอย่างใดอย่างหนึ่ง):

- ปิด sandbox: `agents.defaults.sandbox.mode=off` (หรือแบบต่อเอเจนต์ `agents.list[].sandbox.mode=off`)
- อนุญาตเครื่องมือภายใน sandbox:
  - ลบออกจาก `tools.sandbox.tools.deny` (หรือแบบต่อเอเจนต์ `agents.list[].tools.sandbox.tools.deny`)
  - หรือเพิ่มเข้า `tools.sandbox.tools.allow` (หรือรายการอนุญาตแบบต่อเอเจนต์)

### “คิดว่านี่คือ main ทำไมถึงถูก sandbox?”

ในโหมด `"non-main"` คีย์กลุ่ม/แชนเนลจะ _ไม่_ เป็น main ในโหมด `"non-main"` คีย์ของกลุ่ม/ช่องทางจะ _ไม่_ใช่ main ใช้คีย์เซสชัน main (แสดงโดย `sandbox explain`) หรือสลับโหมดเป็น `"off"`
