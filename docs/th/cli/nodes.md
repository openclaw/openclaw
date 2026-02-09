---
summary: "เอกสารอ้างอิงCLIสำหรับ `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - คุณกำลังจัดการโหนดที่จับคู่แล้ว(กล้อง, หน้าจอ, แคนวาส)
  - คุณต้องอนุมัติคำขอหรือเรียกใช้คำสั่งของโหนด
title: "nodes"
---

# `openclaw nodes`

จัดการโหนดที่จับคู่แล้ว(อุปกรณ์)และเรียกใช้ความสามารถของโหนด

เกี่ยวข้อง:

- ภาพรวมโหนด: [Nodes](/nodes)
- กล้อง: [Camera nodes](/nodes/camera)
- รูปภาพ: [Image nodes](/nodes/images)

ตัวเลือกทั่วไป:

- `--url`, `--token`, `--timeout`, `--json`

## คำสั่งที่ใช้บ่อย

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` จะแสดงตารางที่รอการจับคู่/จับคู่แล้ว แถวที่จับคู่แล้วจะรวมอายุการเชื่อมต่อล่าสุด (Last Connect)
ใช้ `--connected` เพื่อแสดงเฉพาะโหนดที่เชื่อมต่ออยู่ในปัจจุบัน `nodes list` แสดงตารางโหนดที่รอการอนุมัติ/ที่จับคู่แล้ว แถวที่จับคู่แล้วจะแสดงอายุการเชื่อมต่อล่าสุด(Last Connect)
ใช้ `--connected` เพื่อแสดงเฉพาะโหนดที่เชื่อมต่ออยู่ในขณะนี้ ใช้ `--last-connected <duration>` เพื่อ
กรองเฉพาะโหนดที่เชื่อมต่อภายในช่วงเวลา(เช่น `24h`, `7d`)

## เรียกใช้/รัน

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

แฟล็กสำหรับการเรียกใช้:

- `--params <json>`: สตริงอ็อบเจ็กต์JSON(ค่าเริ่มต้น `{}`)
- `--invoke-timeout <ms>`: ระยะหมดเวลาการเรียกใช้โหนด(ค่าเริ่มต้น `15000`)
- `--idempotency-key <key>`: คีย์idempotency(ไม่บังคับ)

### ค่าเริ่มต้นแบบExec

`nodes run` สอดคล้องกับพฤติกรรมexecของโมเดล(ค่าเริ่มต้น+การอนุมัติ):

- อ่าน `tools.exec.*`(รวมถึงการแทนที่ด้วย `agents.list[].tools.exec.*`)
- ใช้การอนุมัติการรันคำสั่ง(`exec.approval.request`)ก่อนเรียกใช้ `system.run`
- สามารถละ `--node` ได้เมื่อมีการตั้งค่า `tools.exec.node`
- ต้องใช้โหนดที่ประกาศรองรับ `system.run`(แอปmacOSคู่หูหรือโฮสต์โหนดแบบไม่ใช้หน้าจอ)

แฟล็ก:

- `--cwd <path>`: ไดเรกทอรีทำงาน
- `--env <key=val>`: การแทนที่env(ระบุซ้ำได้)
- `--command-timeout <ms>`: ระยะหมดเวลาคำสั่ง
- `--invoke-timeout <ms>`: ระยะหมดเวลาการเรียกใช้โหนด(ค่าเริ่มต้น `30000`)
- `--needs-screen-recording`: ต้องการสิทธิ์การบันทึกหน้าจอ
- `--raw <command>`: รันสตริงเชลล์(`/bin/sh -lc` หรือ `cmd.exe /c`)
- `--agent <id>`: การอนุมัติ/รายการอนุญาตระดับเอเจนต์(ค่าเริ่มต้นตามเอเจนต์ที่กำหนดค่าไว้)
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: การแทนที่
