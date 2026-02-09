---
summary: "แผนรีแฟกเตอร์: การกำหนดเส้นทางexec host, การอนุมัติโหนด และ runner แบบ headless"
read_when:
  - การออกแบบการกำหนดเส้นทางexec hostหรือการอนุมัติexec
  - การทำ node runner + UI IPC
  - การเพิ่มโหมดความปลอดภัยของexec hostและคำสั่งแบบ slash
title: "การรีแฟกเตอร์Exec Host"
---

# แผนการรีแฟกเตอร์Exec host

## เป้าหมาย

- เพิ่ม `exec.host` + `exec.security` เพื่อกำหนดเส้นทางการรันข้าม **sandbox**, **gateway** และ **node**
- คงค่าเริ่มต้นให้ **ปลอดภัย**: ไม่มีการรันข้ามโฮสต์ เว้นแต่จะเปิดใช้งานอย่างชัดเจน
- แยกการรันออกเป็น **บริการrunnerแบบ headless** พร้อม UI เสริม (แอปmacOS) ผ่าน IPC ภายในเครื่อง
- รองรับนโยบาย **ต่อเอเจนต์**, allowlist, โหมด ask และการผูกกับโหนด
- รองรับ **โหมด ask** ที่ทำงานได้ทั้ง _มี_ หรือ _ไม่มี_ allowlist
- ข้ามแพลตฟอร์ม: Unix socket + การยืนยันตัวตนด้วยโทเคน (macOS/Linux/Windows เท่าเทียมกัน)

## สิ่งที่ไม่อยู่ในขอบเขต

- ไม่มีการย้าย allowlist แบบเดิมหรือรองรับสคีมาแบบเดิม
- ไม่มี PTY/สตรีมมิงสำหรับ node exec (เฉพาะเอาต์พุตแบบรวม)
- ไม่มีเลเยอร์เครือข่ายใหม่ นอกเหนือจาก Bridge + Gateway ที่มีอยู่

## การตัดสินใจ (ล็อกแล้ว)

- **คีย์คอนฟิก:** `exec.host` + `exec.security` (อนุญาตให้ override ต่อเอเจนต์)
- **Elevation:** คง `/elevated` เป็น alias สำหรับการเข้าถึง Gateway เต็มรูปแบบ
- **ค่าเริ่มต้นของ ask:** `on-miss`
- **ที่เก็บการอนุมัติ:** `~/.openclaw/exec-approvals.json` (JSON ไม่มีการย้ายของเดิม)
- **Runner:** บริการระบบแบบ headless; แอป UI โฮสต์ Unix socket สำหรับการอนุมัติ
- **ตัวตนโหนด:** ใช้ `nodeId` ที่มีอยู่
- **การยืนยันตัวตนของซ็อกเก็ต:** Unix socket + โทเคน (ข้ามแพลตฟอร์ม); แยกภายหลังหากจำเป็น
- **สถานะโฮสต์โหนด:** `~/.openclaw/node.json` (node id + pairing token)
- **exec host บน macOS:** รัน `system.run` ภายในแอปmacOS; บริการโฮสต์โหนดส่งต่อคำขอผ่าน IPC ภายในเครื่อง
- **ไม่มี XPC helper:** ใช้ Unix socket + โทเคน + การตรวจสอบเพียร์

## แนวคิดหลัก

### โฮสต์

- `sandbox`: Docker exec (พฤติกรรมปัจจุบัน)
- `gateway`: exec บนโฮสต์ Gateway
- `node`: exec บน node runner ผ่าน Bridge (`system.run`)

### โหมดความปลอดภัย

- `deny`: บล็อกเสมอ
- `allowlist`: อนุญาตเฉพาะที่ตรงเงื่อนไข
- `full`: อนุญาตทั้งหมด (เทียบเท่าโหมดยกระดับ)

### โหมด ask

- `off`: ไม่ถาม
- `on-miss`: ถามเฉพาะเมื่อ allowlist ไม่ตรง
- `always`: ถามทุกครั้ง

Ask **เป็นอิสระ**จาก allowlist; allowlist สามารถใช้ร่วมกับ `always` หรือ `on-miss` ได้

### การแก้นโยบาย (ต่อการ exec หนึ่งครั้ง)

1. แก้ค่า `exec.host` (พารามิเตอร์ของเครื่องมือ → override ต่อเอเจนต์ → ค่าเริ่มต้นส่วนกลาง)
2. แก้ค่า `exec.security` และ `exec.ask` (ลำดับความสำคัญเดียวกัน)
3. หากโฮสต์เป็น `sandbox` ให้ดำเนินการ exec ใน sandbox ภายในเครื่อง
4. หากโฮสต์เป็น `gateway` หรือ `node` ให้ใช้นโยบายความปลอดภัย + ask บนโฮสต์นั้น

## ความปลอดภัยค่าเริ่มต้น

- ค่าเริ่มต้น `exec.host = sandbox`
- ค่าเริ่มต้น `exec.security = deny` สำหรับ `gateway` และ `node`
- ค่าเริ่มต้น `exec.ask = on-miss` (เกี่ยวข้องเฉพาะเมื่อความปลอดภัยอนุญาต)
- หากไม่ได้ตั้งการผูกกับโหนด **เอเจนต์อาจเลือกโหนดใดก็ได้** แต่เฉพาะเมื่อ นโยบายอนุญาต

## พื้นผิวการคอนฟิก

### พารามิเตอร์ของเครื่องมือ

- `exec.host` (ไม่บังคับ): `sandbox | gateway | node`
- `exec.security` (ไม่บังคับ): `deny | allowlist | full`
- `exec.ask` (ไม่บังคับ): `off | on-miss | always`
- `exec.node` (ไม่บังคับ): node id/name ที่ใช้เมื่อ `host=node`

### คีย์คอนฟิก (ส่วนกลาง)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (การผูกโหนดค่าเริ่มต้น)

### คีย์คอนฟิก (ต่อเอเจนต์)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = ตั้งค่า `tools.exec.host=gateway`, `tools.exec.security=full` สำหรับเซสชันของเอเจนต์
- `/elevated off` = คืนค่าการตั้งค่า exec ก่อนหน้าสำหรับเซสชันของเอเจนต์

## ที่เก็บการอนุมัติ (JSON)

พาธ: `~/.openclaw/exec-approvals.json`

วัตถุประสงค์:

- นโยบายภายในเครื่อง + allowlist สำหรับ **execution host** (Gateway หรือ node runner)
- fallback ของ ask เมื่อไม่มี UI
- ข้อมูลรับรอง IPC สำหรับไคลเอนต์ UI

สคีมาที่เสนอ (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

หมายเหตุ:

- ไม่มีรูปแบบ allowlist แบบเดิม
- `askFallback` ใช้เฉพาะเมื่อจำเป็นต้องมี `ask` และไม่สามารถเข้าถึง UI ได้
- สิทธิ์ไฟล์: `0600`

## บริการRunner (headless)

### บทบาท

- บังคับใช้ `exec.security` + `exec.ask` ภายในเครื่อง
- รันคำสั่งระบบและส่งคืนเอาต์พุต
- ส่งอีเวนต์ Bridge สำหรับวงจรชีวิตของ exec (ไม่บังคับแต่แนะนำ)

### วงจรชีวิตของบริการ

- Launchd/daemon บน macOS; บริการระบบบน Linux/Windows
- JSON การอนุมัติอยู่ภายใน execution host
- UI โฮสต์ Unix socket ภายในเครื่อง; runner เชื่อมต่อเมื่อจำเป็น

## การผสานรวม UI (แอปmacOS)

### IPC

- Unix socket ที่ `~/.openclaw/exec-approvals.sock` (0600)
- โทเคนเก็บที่ `exec-approvals.json` (0600)
- การตรวจสอบเพียร์: UID เดียวกันเท่านั้น
- Challenge/response: nonce + HMAC(token, request-hash) เพื่อป้องกันการ replay
- TTL สั้น (เช่น 10s) + จำกัดขนาด payload + จำกัดอัตรา

### โฟลว์ ask (exec host ในแอปmacOS)

1. บริการโหนดรับ `system.run` จาก Gateway
2. บริการโหนดเชื่อมต่อซ็อกเก็ตภายในเครื่องและส่งคำขอ prompt/exec
3. แอปตรวจสอบเพียร์ + โทเคน + HMAC + TTL จากนั้นแสดงไดอะล็อกหากจำเป็น
4. แอปรันคำสั่งในบริบท UI และส่งคืนเอาต์พุต
5. บริการโหนดส่งเอาต์พุตกลับไปที่ Gateway

หากไม่มี UI:

- ใช้ `askFallback` (`deny|allowlist|full`)

### แผนภาพ (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## ตัวตนโหนด + การผูก

- ใช้ `nodeId` ที่มีอยู่จากการจับคู่ Bridge
- โมเดลการผูก:
  - `tools.exec.node` จำกัดเอเจนต์ให้ใช้โหนดเฉพาะ
  - หากไม่ตั้งค่า เอเจนต์สามารถเลือกโหนดใดก็ได้ (นโยบายยังคงบังคับใช้ค่าเริ่มต้น)
- การแก้การเลือกโหนด:
  - `nodeId` ตรงทั้งหมด
  - `displayName` (ปรับรูปแบบ)
  - `remoteIp`
  - `nodeId` พรีฟิกซ์ (>= 6 ตัวอักษร)

## การส่งอีเวนต์

### ใครเห็นอีเวนต์

- อีเวนต์ระบบเป็นแบบ **ต่อเซสชัน** และจะแสดงให้เอเจนต์เห็นในพรอมป์ถัดไป
- เก็บไว้ในคิวหน่วยความจำของ Gateway (`enqueueSystemEvent`)

### ข้อความอีเวนต์

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + เอาต์พุตส่วนท้าย (ไม่บังคับ)
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### ทรานสปอร์ต

ตัวเลือก A (แนะนำ):

- Runner ส่งเฟรม Bridge `event` แบบ `exec.started` / `exec.finished`
- Gateway `handleBridgeEvent` แปลงเป็น `enqueueSystemEvent`

ตัวเลือก B:

- เครื่องมือ `exec` บน Gateway จัดการวงจรชีวิตโดยตรง (เฉพาะ synchronous)

## โฟลว์การ Exec

### โฮสต์ Sandbox

- พฤติกรรม `exec` เดิม (Docker หรือโฮสต์เมื่อไม่ใช้ sandbox)
- รองรับ PTY เฉพาะโหมดไม่ใช้ sandbox เท่านั้น

### โฮสต์ Gateway

- โพรเซส Gateway รันบนเครื่องของตนเอง
- บังคับใช้นโยบาย `exec-approvals.json` ภายในเครื่อง (ความปลอดภัย/ask/allowlist)

### โฮสต์ Node

- Gateway เรียก `node.invoke` พร้อม `system.run`
- Runner บังคับการอนุมัติในเครื่อง
- Runner ส่งคืน stdout/stderr แบบรวม
- อีเวนต์ Bridge สำหรับเริ่ม/จบ/ปฏิเสธ (ไม่บังคับ)

## จำกัดผลลัพธ์

- จำกัด stdout+stderr รวมที่ **200k**; เก็บ **tail 20k** สำหรับอีเวนต์
- ตัดทอนพร้อม suffix ที่ชัดเจน (เช่น `"… (truncated)"`)

## คำสั่ง Slash

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- override ต่อเอเจนต์ ต่อเซสชัน; ไม่ถาวร เว้นแต่บันทึกผ่านคอนฟิก
- `/elevated on|off|ask|full` ยังคงเป็นทางลัดของ `host=gateway security=full` (โดย `full` จะข้ามการอนุมัติ)

## เรื่องข้ามแพลตฟอร์ม

- บริการ runner คือเป้าหมายการรันแบบพกพา
- UI เป็นตัวเลือก; หากไม่มี ให้ใช้ `askFallback`
- Windows/Linux รองรับ JSON การอนุมัติและโปรโตคอลซ็อกเก็ตเดียวกัน

## เฟสการนำไปใช้

### เฟส 1: คอนฟิก + การกำหนดเส้นทาง exec

- เพิ่มสคีมาคอนฟิกสำหรับ `exec.host`, `exec.security`, `exec.ask`, `exec.node`
- อัปเดต plumbing ของเครื่องมือให้เคารพ `exec.host`
- เพิ่มคำสั่ง slash `/exec` และคง alias `/elevated`

### เฟส 2: ที่เก็บการอนุมัติ + การบังคับใช้บน Gateway

- ทำตัวอ่าน/เขียน `exec-approvals.json`
- บังคับใช้ allowlist + โหมด ask สำหรับโฮสต์ `gateway`
- เพิ่มขีดจำกัดเอาต์พุต

### เฟส 3: การบังคับใช้บน node runner

- อัปเดต node runner ให้บังคับใช้ allowlist + ask
- เพิ่มสะพาน Unix socket prompt ไปยัง UI แอปmacOS
- เชื่อมต่อ `askFallback`

### เฟส 4: อีเวนต์

- เพิ่มอีเวนต์ Bridge จาก node → Gateway สำหรับวงจรชีวิต exec
- แมปเป็น `enqueueSystemEvent` สำหรับพรอมป์เอเจนต์

### เฟส 5: ปรับปรุง UI

- แอป Mac: ตัวแก้ไข allowlist, ตัวสลับต่อเอเจนต์, UI นโยบาย ask
- การควบคุมการผูกโหนด (ไม่บังคับ)

## แผนการทดสอบ

- Unit tests: การจับคู่ allowlist (glob + ไม่สนตัวพิมพ์เล็กใหญ่)
- Unit tests: ลำดับความสำคัญการแก้นโยบาย (พารามิเตอร์เครื่องมือ → override ต่อเอเจนต์ → ส่วนกลาง)
- Integration tests: โฟลว์ deny/allow/ask ของ node runner
- การทดสอบอีเวนต์ Bridge: อีเวนต์จาก node → การกำหนดเส้นทางอีเวนต์ระบบ

## ความเสี่ยงที่ยังเปิดอยู่

- UI ไม่พร้อมใช้งาน: ต้องมั่นใจว่าเคารพ `askFallback`
- คำสั่งที่รันนาน: พึ่งพา timeout + ขีดจำกัดเอาต์พุต
- ความกำกวมหลายโหนด: ให้เกิดข้อผิดพลาด เว้นแต่มีการผูกโหนดหรือระบุพารามิเตอร์โหนดอย่างชัดเจน

## เอกสารที่เกี่ยวข้อง

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
