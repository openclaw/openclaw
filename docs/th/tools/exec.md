---
summary: "การใช้งานเครื่องมือ Exec, โหมด stdin และการรองรับ TTY"
read_when:
  - การใช้งานหรือปรับแก้เครื่องมือ exec
  - การดีบักพฤติกรรม stdin หรือ TTY
title: "เครื่องมือ Exec"
---

# เครื่องมือ Exec

รันคำสั่งเชลล์ในเวิร์กสเปซ รองรับการรันแบบโฟร์กราวด์และแบ็กกราวด์ผ่าน `process`. Supports foreground + background execution via `process`.
หาก `process` ไม่ได้รับอนุญาต `exec` จะรันแบบซิงโครนัสและเพิกเฉยต่อ `yieldMs`/`background`.
เซสชันแบ็กกราวด์ถูกจำกัดขอบเขตต่อเอเจนต์; `process` จะเห็นเฉพาะเซสชันจากเอเจนต์เดียวกันเท่านั้น.

## พารามิเตอร์

- `command` (จำเป็น)
- `workdir` (ค่าเริ่มต้นคือ cwd)
- `env` (การแทนที่แบบคีย์/ค่า)
- `yieldMs` (ค่าเริ่มต้น 10000): เปลี่ยนเป็นแบ็กกราวด์อัตโนมัติหลังดีเลย์
- `background` (บูลีน): เข้าสู่แบ็กกราวด์ทันที
- `timeout` (วินาที, ค่าเริ่มต้น 1800): ฆ่ากระบวนการเมื่อหมดอายุ
- `pty` (บูลีน): รันใน pseudo-terminal เมื่อมี (CLI ที่ต้องใช้ TTY, เอเจนต์โค้ดดิ้ง, UI แบบเทอร์มินัล)
- `host` (`sandbox | gateway | node`): ตำแหน่งที่จะรัน
- `security` (`deny | allowlist | full`): โหมดบังคับใช้สำหรับ `gateway`/`node`
- `ask` (`off | on-miss | always`): พรอมป์ตการอนุมัติสำหรับ `gateway`/`node`
- `node` (สตริง): node id/name สำหรับ `host=node`
- `elevated` (บูลีน): ขอใช้โหมดสิทธิ์สูง (gateway host); `security=full` จะถูกบังคับใช้เฉพาะเมื่อการยกระดับแก้ไขเป็น `full`

หมายเหตุ:

- `host` มีค่าเริ่มต้นเป็น `sandbox`.
- `elevated` จะถูกเพิกเฉยเมื่อ sandboxing ปิดอยู่ (exec รันบนโฮสต์อยู่แล้ว).
- การอนุมัติ `gateway`/`node` ถูกควบคุมโดย `~/.openclaw/exec-approvals.json`.
- `node` ต้องการโหนดที่จับคู่แล้ว (แอปคู่หูหรือโฮสต์โหนดแบบ headless).
- หากมีหลายโหนด ให้ตั้งค่า `exec.node` หรือ `tools.exec.node` เพื่อเลือกหนึ่งโหนด.
- บนโฮสต์ที่ไม่ใช่ Windows exec จะใช้ `SHELL` เมื่อมีการตั้งค่า; หาก `SHELL` เป็น `fish` จะให้ความสำคัญกับ `bash` (หรือ `sh`)
  จาก `PATH` เพื่อหลีกเลี่ยงสคริปต์ที่ไม่เข้ากันกับ fish จากนั้นจะถอยกลับไปใช้ `SHELL` หากไม่มีทั้งสอง.
- การรันบนโฮสต์ (`gateway`/`node`) จะปฏิเสธ `env.PATH` และการแทนที่ตัวโหลด (`LD_*`/`DYLD_*`) เพื่อ
  ป้องกันการไฮแจ็กไบนารีหรือการฉีดโค้ด.
- สำคัญ: sandboxing **ปิดเป็นค่าเริ่มต้น**. หาก sandboxing ปิดอยู่ `host=sandbox` จะรันโดยตรงบน
  โฮสต์Gateway (ไม่มีคอนเทนเนอร์) และ **ไม่ต้องขอการอนุมัติ**. หากต้องการบังคับให้ต้องขอการอนุมัติ ให้รันด้วย
  `host=gateway` และกำหนดค่าการอนุมัติ exec (หรือเปิดใช้งาน sandboxing).

## คอนฟิก

- `tools.exec.notifyOnExit` (ค่าเริ่มต้น: true): เมื่อเป็น true เซสชัน exec ที่ถูกส่งไปแบ็กกราวด์จะจัดคิวอีเวนต์ระบบและร้องขอฮาร์ตบีตเมื่อจบการทำงาน.
- `tools.exec.approvalRunningNoticeMs` (ค่าเริ่มต้น: 10000): ส่งการแจ้งเตือน “running” เพียงครั้งเดียวเมื่อ exec ที่ต้องผ่านการอนุมัติทำงานนานกว่าค่านี้ (0 คือปิดใช้งาน).
- `tools.exec.host` (ค่าเริ่มต้น: `sandbox`)
- `tools.exec.security` (ค่าเริ่มต้น: `deny` สำหรับ sandbox, `allowlist` สำหรับ gateway + node เมื่อไม่ได้ตั้งค่า)
- `tools.exec.ask` (ค่าเริ่มต้น: `on-miss`)
- `tools.exec.node` (ค่าเริ่มต้น: unset)
- `tools.exec.pathPrepend`: รายการไดเรกทอรีที่จะนำหน้า `PATH` สำหรับการรัน exec.
- `tools.exec.safeBins`: ไบนารีที่ปลอดภัยแบบ stdin-only ซึ่งสามารถรันได้โดยไม่ต้องมีรายการอนุญาตแบบชัดเจน.

ตัวอย่าง:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### การจัดการ PATH

- `host=gateway`: รวม `PATH` ของเชลล์ล็อกอินของคุณเข้ากับสภาพแวดล้อม exec. การแทนที่ `env.PATH`
  จะถูกปฏิเสธสำหรับการรันบนโฮสต์. ตัวเดมอนเองยังคงรันด้วย `PATH` แบบขั้นต่ำ:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: รัน `sh -lc` (เชลล์ล็อกอิน) ภายในคอนเทนเนอร์ ดังนั้น `/etc/profile` อาจรีเซ็ต `PATH`.
  OpenClaw จะนำหน้า `env.PATH` หลังจากโหลดโปรไฟล์ผ่านตัวแปรสภาพแวดล้อมภายใน (ไม่มีการอินเทอร์โพเลตของเชลล์);
  `tools.exec.pathPrepend` ใช้กับกรณีนี้ด้วย.
- `host=node`: จะส่งเฉพาะการแทนที่ env ที่ไม่ถูกบล็อกซึ่งคุณระบุไปยังโหนด. การแทนที่ `env.PATH`
  จะถูกปฏิเสธสำหรับการรันบนโฮสต์. โฮสต์โหนดแบบ headless จะยอมรับ `PATH` เฉพาะเมื่อเป็นการนำหน้า PATH ของโฮสต์โหนด
  (ไม่ใช่การแทนที่). โหนด macOS จะทิ้งการแทนที่ `PATH` ทั้งหมด.

การผูกโหนดต่อเอเจนต์ (ใช้ดัชนีรายชื่อเอเจนต์ในคอนฟิก):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

UI สำหรับควบคุม: แท็บ Nodes มีแผงเล็ก “Exec node binding” สำหรับการตั้งค่าเดียวกัน.

## การแทนที่ระดับเซสชัน (`/exec`)

ใช้ `/exec` เพื่อกำหนดค่าเริ่มต้น **ต่อเซสชัน** สำหรับ `host`, `security`, `ask` และ `node`.
ส่ง `/exec` โดยไม่ใส่อาร์กิวเมนต์เพื่อแสดงค่าปัจจุบัน.

ตัวอย่าง:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## โมเดลการให้สิทธิ์

`/exec` จะมีผลเฉพาะกับ **ผู้ส่งที่ได้รับอนุญาต** (allowlist ของช่องทาง/การจับคู่ พร้อม `commands.useAccessGroups`).
การตั้งค่านี้จะอัปเดต **เฉพาะสถานะเซสชัน** และไม่เขียนคอนฟิก. หากต้องการปิดใช้งาน exec แบบถาวร ให้ปฏิเสธผ่านนโยบายเครื่องมือ
(`tools.deny: ["exec"]` หรือระดับต่อเอเจนต์). การอนุมัติบนโฮสต์ยังคงมีผล เว้นแต่คุณจะตั้งค่า
`security=full` และ `ask=off` อย่างชัดเจน.

## การอนุมัติ Exec (แอปคู่หู / โฮสต์โหนด)

เอเจนต์ที่อยู่ใน sandbox สามารถกำหนดให้ต้องขอการอนุมัติต่อคำขอก่อนที่ `exec` จะรันบนโฮสต์Gatewayหรือโฮสต์โหนด.
ดู [Exec approvals](/tools/exec-approvals) สำหรับนโยบาย allowlist และโฟลว์ UI.

When approvals are required, the exec tool returns immediately with
`status: "approval-pending"` and an approval id. เมื่อจำเป็นต้องขอการอนุมัติ เครื่องมือ exec จะส่งกลับทันทีพร้อม
`status: "approval-pending"` และรหัสการอนุมัติ เมื่อได้รับการอนุมัติ (หรือถูกปฏิเสธ/หมดเวลา),
Gateway จะปล่อยอีเวนต์ระบบ (`Exec finished` / `Exec denied`). หากคำสั่งยังคง
ทำงานหลังจาก `tools.exec.approvalRunningNoticeMs` จะมีการแจ้งเตือน `Exec running` เพียงครั้งเดียว.

## Allowlist + safe bins

การบังคับใช้ allowlist จะจับคู่เฉพาะ **พาธไบนารีที่ถูก resolve แล้วเท่านั้น** (ไม่จับคู่จากชื่อฐาน). เมื่อ
`security=allowlist` คำสั่งเชลล์จะถูกอนุญาตอัตโนมัติเฉพาะเมื่อทุกส่วนของ pipeline อยู่ใน allowlist หรือเป็น safe bin. การเชื่อมคำสั่ง (`;`, `&&`, `||`) และการรีไดเร็กต์จะถูกปฏิเสธในโหมด allowlist.

## ตัวอย่าง

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

ส่งคีย์ (สไตล์ tmux):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

ส่ง (ส่ง CR เท่านั้น):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

วาง (มีวงเล็บครอบโดยค่าเริ่มต้น):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (ทดลอง)

`apply_patch` เป็นซับทูลของ `exec` สำหรับการแก้ไขหลายไฟล์แบบมีโครงสร้าง.
ต้องเปิดใช้งานอย่างชัดเจน:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

หมายเหตุ:

- ใช้ได้เฉพาะกับโมเดล OpenAI/OpenAI Codex เท่านั้น.
- นโยบายเครื่องมือยังคงมีผล; `allow: ["exec"]` อนุญาต `apply_patch` โดยปริยาย.
- คอนฟิกอยู่ภายใต้ `tools.exec.applyPatch`.
