---
summary: "แอปคู่หู OpenClaw บน macOS (แถบเมนู + ตัวกลาง Gateway)"
read_when:
  - การพัฒนาฟีเจอร์แอป macOS
  - การเปลี่ยนแปลงวงจรชีวิตของ Gateway หรือการเชื่อมต่อโหนดบน macOS
title: "แอป macOS"
---

# OpenClaw macOS Companion (แถบเมนู + ตัวกลาง Gateway)

แอป macOS เป็น **คู่หูบนแถบเมนู** สำหรับ OpenClaw แอป macOS คือ **แอปคู่หูบนแถบเมนู** สำหรับ OpenClaw ทำหน้าที่จัดการสิทธิ์,
ดูแล/เชื่อมต่อกับ Gateway ในเครื่อง (ผ่าน launchd หรือแบบแมนนวล) และเปิดเผย
ความสามารถเฉพาะของ macOS ให้เอเจนต์ใช้งานในรูปแบบโหนด

## ทำอะไรได้บ้าง

- แสดงการแจ้งเตือนแบบเนทีฟและสถานะในแถบเมนู
- จัดการคำขอ TCC (การแจ้งเตือน, การช่วยการเข้าถึง, การบันทึกหน้าจอ, ไมโครโฟน,
  การรู้จำเสียงพูด, Automation/AppleScript)
- รันหรือเชื่อมต่อกับ Gateway (ภายในเครื่องหรือระยะไกล)
- เปิดเผยเครื่องมือเฉพาะ macOS (Canvas, Camera, Screen Recording, `system.run`)
- เริ่มบริการโฮสต์โหนดภายในเครื่องในโหมด **remote** (launchd) และหยุดในโหมด **local**
- สามารถโฮสต์ **PeekabooBridge** สำหรับการทำ UI automation
- ติดตั้ง CLI แบบ global (`openclaw`) ผ่าน npm/pnpm ตามคำขอ (ไม่แนะนำ bun สำหรับรันไทม์ของ Gateway)

## โหมด Local กับ Remote

- **Local** (ค่าเริ่มต้น): แอปจะเชื่อมต่อกับ Gateway ภายในเครื่องที่กำลังรันอยู่ถ้ามี;
  หากไม่มีจะเปิดใช้บริการ launchd ผ่าน `openclaw gateway install`
- **Remote**: แอปจะเชื่อมต่อกับ Gateway ผ่าน SSH/Tailscale และจะไม่เริ่มโปรเซสภายในเครื่อง
  แอปจะเริ่ม **บริการโฮสต์โหนดภายในเครื่อง** เพื่อให้ Gateway ระยะไกลเข้าถึง Mac เครื่องนี้ได้
  แอปจะไม่สร้าง Gateway เป็นโปรเซสลูก
  แอปจะเริ่ม **node host service** ภายในเครื่อง เพื่อให้ Gateway ระยะไกลเข้าถึง Mac เครื่องนี้ได้
  แอปจะไม่สร้าง Gateway เป็น child process

## การควบคุม Launchd

แอปจัดการ LaunchAgent ต่อผู้ใช้หนึ่งรายการที่มีป้ายกำกับ `bot.molt.gateway`
(หรือ `bot.molt.<profile>` เมื่อใช้ `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` ยังสามารถ unload ได้)

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

แทนที่ label ด้วย `bot.molt.<profile>` เมื่อรันโปรไฟล์ที่ตั้งชื่อไว้

หากยังไม่ได้ติดตั้ง LaunchAgent ให้เปิดใช้งานจากแอปหรือรัน
`openclaw gateway install`

## ความสามารถของโหนด (mac)

แอป macOS จะแสดงตัวเองเป็นโหนด คำสั่งที่ใช้บ่อย: คำสั่งที่ใช้บ่อย:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

โหนดจะรายงานแผนที่ `permissions` เพื่อให้เอเจนต์ตัดสินใจว่าอะไรได้รับอนุญาต

บริการโหนด + IPC ของแอป:

- เมื่อบริการโฮสต์โหนดแบบ headless กำลังรันอยู่ (โหมด remote) จะเชื่อมต่อกับ Gateway WS ในฐานะโหนด
- `system.run` จะทำงานในแอป macOS (บริบท UI/TCC) ผ่าน Unix socket ภายในเครื่อง; คำขอและเอาต์พุตจะอยู่ภายในแอป

แผนภาพ (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## การอนุมัติการรันคำสั่ง (system.run)

`system.run` ถูกควบคุมด้วย **Exec approvals** ในแอป macOS (Settings → Exec approvals)
การตั้งค่าด้านความปลอดภัย + การถามยืนยัน + รายการอนุญาตจะถูกเก็บไว้ในเครื่อง Mac ที่:
ข้อมูล Security + ask + allowlist ถูกเก็บไว้ในเครื่อง Mac ที่:

```
~/.openclaw/exec-approvals.json
```

ตัวอย่าง:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

หมายเหตุ:

- รายการ `allowlist` เป็น glob pattern สำหรับพาธไบนารีที่ถูก resolve แล้ว
- การเลือก “Always Allow” ในพรอมป์ต์จะเพิ่มคำสั่งนั้นลงในรายการอนุญาต
- การ override ตัวแปรสภาพแวดล้อม `system.run` จะถูกกรอง (ตัด `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) แล้วจึงรวมกับสภาพแวดล้อมของแอป

## Deep links

แอปจะลงทะเบียน URL scheme `openclaw://` สำหรับการทำงานภายในเครื่อง

### `openclaw://agent`

ทริกเกอร์คำขอ Gateway `agent`

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

พารามิเตอร์ของ query:

- `message` (บังคับ)
- `sessionKey` (ไม่บังคับ)
- `thinking` (ไม่บังคับ)
- `deliver` / `to` / `channel` (ไม่บังคับ)
- `timeoutSeconds` (ไม่บังคับ)
- `key` (คีย์โหมด unattended ไม่บังคับ)

ความปลอดภัย:

- หากไม่มี `key` แอปจะขอการยืนยันก่อน
- หากมี `key` ที่ถูกต้อง การรันจะเป็นแบบ unattended (ออกแบบมาสำหรับอัตโนมัติส่วนบุคคล)

## ขั้นตอน Onboarding (โดยทั่วไป)

1. ติดตั้งและเปิด **OpenClaw.app**
2. ทำรายการตรวจสอบสิทธิ์ให้ครบ (คำขอ TCC)
3. ตรวจสอบให้แน่ใจว่าเปิดโหมด **Local** และ Gateway กำลังรันอยู่
4. ติดตั้ง CLI หากต้องการใช้งานผ่านเทอร์มินัล

## เวิร์กโฟลว์ Build & dev (เนทีฟ)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (หรือ Xcode)
- แพ็กเกจแอป: `scripts/package-mac-app.sh`

## ดีบักการเชื่อมต่อ Gateway (macOS CLI)

ใช้ debug CLI เพื่อทดสอบขั้นตอนการจับมือ WebSocket และตรรกะ Discovery ของ Gateway
แบบเดียวกับที่แอป macOS ใช้ โดยไม่ต้องเปิดแอป

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

ตัวเลือกการเชื่อมต่อ:

- `--url <ws://host:port>`: override คอนฟิก
- `--mode <local|remote>`: resolve จากคอนฟิก (ค่าเริ่มต้น: จากคอนฟิกหรือ local)
- `--probe`: บังคับตรวจสุขภาพใหม่
- `--timeout <ms>`: timeout ของคำขอ (ค่าเริ่มต้น: `15000`)
- `--json`: เอาต์พุตแบบมีโครงสร้างสำหรับการ diff

ตัวเลือก Discovery:

- `--include-local`: รวม Gateway ที่ปกติจะถูกกรองว่าเป็น “local”
- `--timeout <ms>`: ช่วงเวลา Discovery โดยรวม (ค่าเริ่มต้น: `2000`)
- `--json`: เอาต์พุตแบบมีโครงสร้างสำหรับการ diff

เคล็ดลับ: เปรียบเทียบกับ `openclaw gateway discover --json` เพื่อดูว่าพายป์ไลน์ Discovery ของแอป macOS
(NWBrowser + tailnet DNS‑SD fallback) แตกต่างจาก Discovery แบบ `dns-sd` ของ Node CLI หรือไม่

## โครงสร้างการเชื่อมต่อระยะไกล (อุโมงค์SSH)

เมื่อแอป macOS ทำงานในโหมด **Remote** จะเปิดอุโมงค์SSH เพื่อให้คอมโพเนนต์ UI ภายในเครื่อง
สื่อสารกับ Gateway ระยะไกลได้เสมือนอยู่บน localhost

### อุโมงค์ควบคุม (พอร์ต Gateway WebSocket)

- **วัตถุประสงค์:** การตรวจสุขภาพ, สถานะ, Web Chat, คอนฟิก และการเรียก control‑plane อื่นๆ
- **พอร์ตภายในเครื่อง:** พอร์ต Gateway (ค่าเริ่มต้น `18789`) คงที่เสมอ
- **พอร์ตระยะไกล:** พอร์ต Gateway เดียวกันบนโฮสต์ระยะไกล
- **พฤติกรรม:** ไม่มีพอร์ตสุ่มในเครื่อง; แอปจะใช้ซ้ำอุโมงค์ที่ยังใช้งานได้
  หรือรีสตาร์ทหากจำเป็น
- **รูปแบบ SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` พร้อมตัวเลือก BatchMode +
  ExitOnForwardFailure + keepalive
- **การรายงาน IP:** อุโมงค์SSH ใช้ loopback ดังนั้น Gateway จะเห็น IP ของโหนดเป็น
  `127.0.0.1` หากต้องการให้แสดง IP ไคลเอนต์จริง ให้ใช้ทรานสปอร์ต **Direct (ws/wss)**
  (ดู [macOS remote access](/platforms/mac/remote)) ใช้การขนส่งแบบ **Direct (ws/wss)** หากต้องการให้ IP ของไคลเอนต์จริงปรากฏ (ดู [macOS remote access](/platforms/mac/remote))

ขั้นตอนการตั้งค่า ดูที่ [macOS remote access](/platforms/mac/remote)
รายละเอียดโปรโตคอล ดูที่ [Gateway protocol](/gateway/protocol) สำหรับรายละเอียดโปรโตคอล ดูที่ [Gateway protocol](/gateway/protocol)

## เอกสารที่เกี่ยวข้อง

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
