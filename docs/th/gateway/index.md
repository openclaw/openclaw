---
summary: "คู่มือปฏิบัติงานสำหรับบริการ Gateway วงจรชีวิต และการดำเนินงาน"
read_when:
  - เมื่อรันหรือดีบักกระบวนการGateway
title: "Gateway Runbook"
---

# คู่มือปฏิบัติงานบริการGateway

อัปเดตล่าสุด: 2025-12-09

## คืออะไร

- กระบวนการที่ทำงานตลอดเวลาซึ่งเป็นเจ้าของการเชื่อมต่อ Baileys/Telegram เพียงหนึ่งเดียวและระนาบควบคุม/อีเวนต์
- Replaces the legacy `gateway` command. แทนที่คำสั่งเดิม `gateway` จุดเริ่มต้นCLI: `openclaw gateway`.
- ทำงานต่อเนื่องจนกว่าจะหยุด; ออกด้วยรหัสไม่เป็นศูนย์เมื่อเกิดข้อผิดพลาดร้ายแรงเพื่อให้ตัวควบคุมรีสตาร์ต

## วิธีรัน (ภายในเครื่อง)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- การรีโหลดคอนฟิกร้อนเฝ้าดู `~/.openclaw/openclaw.json` (หรือ `OPENCLAW_CONFIG_PATH`).
  - โหมดเริ่มต้น: `gateway.reload.mode="hybrid"` (ปรับใช้การเปลี่ยนแปลงที่ปลอดภัยแบบร้อน รีสตาร์ตเมื่อเป็นส่วนสำคัญ).
  - การรีโหลดร้อนใช้การรีสตาร์ตภายในโปรเซสผ่าน **SIGUSR1** เมื่อจำเป็น
  - ปิดใช้งานด้วย `gateway.reload.mode="off"`.
- ผูก WebSocket ระนาบควบคุมกับ `127.0.0.1:<port>` (ค่าเริ่มต้น 18789).
- พอร์ตเดียวกันนี้ให้บริการ HTTP ด้วย (UI ควบคุม, hooks, A2UI) การมัลติเพล็กซ์พอร์ตเดียว Single-port multiplex.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- เริ่มต้นเซิร์ฟเวอร์ไฟล์ Canvas ตามค่าเริ่มต้นที่ `canvasHost.port` (ค่าเริ่มต้น `18793`), ให้บริการ `http://<gateway-host>:18793/__openclaw__/canvas/` จาก `~/.openclaw/workspace/canvas`. ปิดด้วย `canvasHost.enabled=false` หรือ `OPENCLAW_SKIP_CANVAS_HOST=1`.
- บันทึกล็อกไปที่ stdout; ใช้ launchd/systemd เพื่อคงการทำงานและหมุนเวียนล็อก
- ส่ง `--verbose` เพื่อสะท้อนล็อกดีบัก (การจับมือ, req/res, อีเวนต์) จากไฟล์ล็อกเข้าสู่ stdio เมื่อแก้ปัญหา
- `--force` ใช้ `lsof` เพื่อค้นหาตัวรับฟังบนพอร์ตที่เลือก ส่ง SIGTERM บันทึกสิ่งที่ถูกฆ่า จากนั้นเริ่มGateway (ล้มเหลวทันทีหากไม่มี `lsof`).
- หากรันภายใต้ตัวควบคุม (launchd/systemd/โหมดโปรเซสย่อยของแอปmacOS) การหยุด/รีสตาร์ตมักส่ง **SIGTERM**; บิลด์เก่าอาจแสดงเป็น `pnpm` `ELIFECYCLE` รหัสออก **143** (SIGTERM) ซึ่งเป็นการปิดปกติไม่ใช่การแครช
- **SIGUSR1** กระตุ้นการรีสตาร์ตภายในโปรเซสเมื่อได้รับอนุญาต (เครื่องมือGateway/การปรับใช้คอนฟิก/อัปเดต หรือเปิดใช้ `commands.restart` สำหรับรีสตาร์ตด้วยตนเอง)
- ต้องมีการยืนยันตัวตนของGatewayโดยค่าเริ่มต้น: ตั้งค่า `gateway.auth.token` (หรือ `OPENCLAW_GATEWAY_TOKEN`) หรือ `gateway.auth.password`. ไคลเอนต์ต้องส่ง `connect.params.auth.token/password` เว้นแต่ใช้ตัวตน Tailscale Serve
- ตัวช่วยสร้างจะสร้างโทเคนโดยค่าเริ่มต้นแล้ว แม้บน loopback
- ลำดับความสำคัญพอร์ต: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > ค่าเริ่มต้น `18789`.

## การเข้าถึงระยะไกล

- แนะนำ Tailscale/VPN; มิฉะนั้นใช้อุโมงค์SSH:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- จากนั้นไคลเอนต์เชื่อมต่อไปยัง `ws://127.0.0.1:18789` ผ่านอุโมงค์

- หากตั้งค่าโทเคนไว้ ไคลเอนต์ต้องแนบใน `connect.params.auth.token` แม้ผ่านอุโมงค์

## หลายGateway (โฮสต์เดียวกัน)

โดยปกติไม่จำเป็น: Gatewayหนึ่งตัวสามารถให้บริการหลายช่องทางข้อความและเอเจนต์ ใช้หลายGatewayเฉพาะเพื่อความซ้ำซ้อนหรือการแยกที่เข้มงวด (เช่น บอตกู้ภัย) Use multiple Gateways only for redundancy or strict isolation (ex: rescue bot).

รองรับหากคุณแยกสถานะ+คอนฟิกและใช้พอร์ตที่ไม่ซ้ำ คู่มือเต็ม: [Multiple gateways](/gateway/multiple-gateways). Full guide: [Multiple gateways](/gateway/multiple-gateways).

ชื่อบริการรองรับโปรไฟล์:

- macOS: `bot.molt.<profile>` (อาจยังมีเดิม `com.openclaw.*`)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

เมตาดาตาการติดตั้งถูกฝังในคอนฟิกบริการ:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

รูปแบบRescue-Bot: คงGatewayตัวที่สองแยกด้วยโปรไฟล์ของตนเอง ไดเรกทอรีสถานะ เวิร์กสเปซ และการเว้นระยะพอร์ตฐาน คู่มือเต็ม: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide). Full guide: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### โปรไฟล์Dev (`--dev`)

ทางลัด: รันอินสแตนซ์devที่แยกสมบูรณ์ (คอนฟิก/สถานะ/เวิร์กสเปซ) โดยไม่กระทบการตั้งค่าหลัก

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

ค่าเริ่มต้น (ปรับทับได้ผ่าน env/flags/config):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- พอร์ตบริการควบคุมเบราว์เซอร์ = `19003` (คำนวณ: `gateway.port+2`, เฉพาะ loopback)
- `canvasHost.port=19005` (คำนวณ: `gateway.port+4`)
- ค่าเริ่มต้น `agents.defaults.workspace` จะกลายเป็น `~/.openclaw/workspace-dev` เมื่อคุณรัน `setup`/`onboard` ภายใต้ `--dev`.

พอร์ตที่ได้มา (แนวทางโดยสังเขป):

- พอร์ตฐาน = `gateway.port` (หรือ `OPENCLAW_GATEWAY_PORT` / `--port`)
- พอร์ตบริการควบคุมเบราว์เซอร์ = ฐาน + 2 (เฉพาะ loopback)
- `canvasHost.port = base + 4` (หรือ `OPENCLAW_CANVAS_HOST_PORT` / ปรับทับในคอนฟิก)
- พอร์ต CDP ของโปรไฟล์เบราว์เซอร์จัดสรรอัตโนมัติจาก `browser.controlPort + 9 .. + 108` (บันทึกต่อโปรไฟล์)

เช็กลิสต์ต่ออินสแตนซ์:

- `gateway.port` ไม่ซ้ำ
- `OPENCLAW_CONFIG_PATH` ไม่ซ้ำ
- `OPENCLAW_STATE_DIR` ไม่ซ้ำ
- `agents.defaults.workspace` ไม่ซ้ำ
- หมายเลข WhatsApp แยกกัน (หากใช้ WA)

ติดตั้งบริการต่อโปรไฟล์:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

ตัวอย่าง:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## โปรโตคอล (มุมมองผู้ปฏิบัติงาน)

- เอกสารเต็ม: [Gateway protocol](/gateway/protocol) และ [Bridge protocol (legacy)](/gateway/bridge-protocol).
- เฟรมแรกที่บังคับจากไคลเอนต์: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway ตอบกลับ `res {type:"res", id, ok:true, payload:hello-ok }` (หรือ `ok:false` พร้อมข้อผิดพลาด แล้วปิด).
- หลังการจับมือ:
  - คำขอ: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - อีเวนต์: `{type:"event", event, payload, seq?, stateVersion?}`
- รายการ presence แบบมีโครงสร้าง: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (สำหรับไคลเอนต์WS, `instanceId` มาจาก `connect.client.instanceId`).
- การตอบกลับ `agent` เป็นสองช่วง: ช่วงแรก `res` ack `{runId,status:"accepted"}`, จากนั้นผลลัพธ์สุดท้าย `res` `{runId,status:"ok"|"error",summary}` หลังรันเสร็จ; เอาต์พุตแบบสตรีมมาถึงเป็น `event:"agent"`.

## Methods (ชุดเริ่มต้น)

- `health` — สแนปช็อตสุขภาพแบบเต็ม (โครงสร้างเดียวกับ `openclaw health --json`).
- `status` — สรุปสั้น.
- `system-presence` — รายการ presence ปัจจุบัน.
- `system-event` — โพสต์โน้ต presence/ระบบ (มีโครงสร้าง).
- `send` — ส่งข้อความผ่านช่องทางที่ใช้งานอยู่.
- `agent` — รันเทิร์นเอเจนต์ (สตรีมอีเวนต์กลับบนการเชื่อมต่อเดียวกัน).
- `node.list` — แสดงรายการโหนดที่จับคู่แล้วและที่เชื่อมต่ออยู่ (รวม `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, และ `commands` ที่โฆษณา).
- `node.describe` — อธิบายโหนด (ความสามารถ + คำสั่ง `node.invoke` ที่รองรับ; ใช้ได้กับโหนดที่จับคู่แล้วและโหนดที่เชื่อมต่ออยู่แต่ยังไม่จับคู่).
- `node.invoke` — เรียกใช้คำสั่งบนโหนด (เช่น `canvas.*`, `camera.*`).
- `node.pair.*` — วงจรชีวิตการจับคู่ (`request`, `list`, `approve`, `reject`, `verify`).

ดูเพิ่มเติม: [Presence](/concepts/presence) สำหรับวิธีสร้าง/ตัดซ้ำ presence และเหตุผลที่ `client.instanceId` ที่เสถียรมีความสำคัญ

## อีเวนต์

- `agent` — อีเวนต์เครื่องมือ/เอาต์พุตที่สตรีมจากการรันเอเจนต์ (มีแท็กลำดับ).
- `presence` — การอัปเดต presence (เดลตาพร้อม stateVersion) ถูกผลักไปยังไคลเอนต์ที่เชื่อมต่อทั้งหมด.
- `tick` — keepalive/no-op ตามรอบเพื่อยืนยันการมีชีวิต.
- `shutdown` — Gateway กำลังออก; เพย์โหลดมี `reason` และ `restartExpectedMs` ที่เป็นตัวเลือก ไคลเอนต์ควรเชื่อมต่อใหม่ Clients should reconnect.

## การผสานรวม WebChat

- WebChat เป็น UI SwiftUI เนทีฟที่สื่อสารโดยตรงกับ Gateway WebSocket สำหรับประวัติ การส่ง การยกเลิก และอีเวนต์
- การใช้งานระยะไกลผ่านอุโมงค์SSH/Tailscaleเดียวกัน; หากตั้งค่าโทเคนGatewayไว้ ไคลเอนต์จะรวมระหว่าง `connect`.
- แอปmacOS เชื่อมต่อผ่าน WS เดียว (แชร์การเชื่อมต่อ); ไฮเดรต presence จากสแนปช็อตเริ่มต้นและฟังอีเวนต์ `presence` เพื่ออัปเดต UI

## การพิมพ์และการตรวจสอบ

- เซิร์ฟเวอร์ตรวจสอบทุกเฟรมขาเข้าด้วย AJV เทียบกับ JSON Schema ที่ปล่อยจากคำจำกัดความโปรโตคอล
- ไคลเอนต์ (TS/Swift) ใช้ชนิดที่สร้างขึ้น (TS โดยตรง; Swift ผ่านตัวสร้างของรีโป)
- คำจำกัดความโปรโตคอลคือแหล่งความจริง; สร้าง schema/models ใหม่ด้วย:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## สแนปช็อตการเชื่อมต่อ

- `hello-ok` รวม `snapshot` พร้อม `presence`, `health`, `stateVersion`, และ `uptimeMs` พร้อม `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` เพื่อให้ไคลเอนต์เรนเดอร์ได้ทันทีโดยไม่ต้องร้องขอเพิ่ม
- `health`/`system-presence` ยังใช้ได้สำหรับรีเฟรชด้วยตนเอง แต่ไม่จำเป็นในเวลาที่เชื่อมต่อ

## รหัสข้อผิดพลาด (รูปแบบ res.error)

- ข้อผิดพลาดใช้ `{ code, message, details?, retryable?, retryAfterMs? }`.
- รหัสมาตรฐาน:
  - `NOT_LINKED` — WhatsApp ยังไม่ยืนยันตัวตน.
  - `AGENT_TIMEOUT` — เอเจนต์ไม่ตอบภายในเส้นตายที่กำหนด.
  - `INVALID_REQUEST` — การตรวจสอบสคีมา/พารามิเตอร์ล้มเหลว.
  - `UNAVAILABLE` — Gateway กำลังปิดหรือดีเพนเดนซีไม่พร้อมใช้งาน.

## พฤติกรรม Keepalive

- อีเวนต์ `tick` (หรือ WS ping/pong) ถูกส่งเป็นระยะเพื่อให้ไคลเอนต์ทราบว่าGatewayยังมีชีวิตแม้ไม่มีทราฟฟิก
- การยืนยันการส่ง/เอเจนต์ยังคงเป็นการตอบกลับแยกต่างหาก; อย่าโอเวอร์โหลด ticks สำหรับการส่ง

## Replay / ช่องว่าง

- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. อีเวนต์ไม่ถูกเล่นซ้ำ ไคลเอนต์ตรวจจับช่องว่างลำดับและควรรีเฟรช (`health` + `system-presence`) ก่อนดำเนินการต่อ WebChat และไคลเอนต์macOS จะรีเฟรชอัตโนมัติเมื่อพบช่องว่าง

## การกำกับดูแล (ตัวอย่างmacOS)

- ใช้ launchd เพื่อคงการทำงานของบริการ:
  - Program: พาธไปยัง `openclaw`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: พาธไฟล์หรือ `syslog`
- เมื่อเกิดความล้มเหลว launchd จะรีสตาร์ต; การคอนฟิกผิดพลาดร้ายแรงควรออกต่อเนื่องเพื่อให้ผู้ปฏิบัติงานสังเกต
- LaunchAgents เป็นแบบต่อผู้ใช้และต้องมีเซสชันที่ล็อกอิน; สำหรับการตั้งค่าแบบ headless ให้ใช้ LaunchDaemon แบบกำหนดเอง (ไม่จัดส่ง)
  - `openclaw gateway install` เขียน `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (หรือ `bot.molt.<profile>.plist`; เดิม `com.openclaw.*` จะถูกล้าง)
  - `openclaw doctor` ตรวจสอบคอนฟิก LaunchAgent และอัปเดตเป็นค่าเริ่มต้นปัจจุบันได้

## การจัดการบริการGateway (CLI)

ใช้ Gateway CLI สำหรับ install/start/stop/restart/status:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

หมายเหตุ:

- `gateway status` ตรวจสอบ Gateway RPC โดยค่าเริ่มต้นด้วยพอร์ต/คอนฟิกที่แก้ไขแล้วของบริการ (ปรับทับด้วย `--url`).
- `gateway status --deep` เพิ่มการสแกนระดับระบบ (LaunchDaemons/system units).
- `gateway status --no-probe` ข้ามการตรวจ RPC (มีประโยชน์เมื่อเครือข่ายล่ม).
- `gateway status --json` เสถียรสำหรับสคริปต์.
- `gateway status` รายงาน **เวลารันของตัวควบคุม** (launchd/systemd กำลังรัน) แยกจาก **การเข้าถึง RPC** (เชื่อมต่อ WS + status RPC).
- `gateway status` พิมพ์พาธคอนฟิก + เป้าหมายการตรวจเพื่อหลีกเลี่ยงความสับสน “localhost vs LAN bind” และโปรไฟล์ไม่ตรงกัน
- `gateway status` รวมบรรทัดข้อผิดพลาดGatewayล่าสุดเมื่อบริการดูเหมือนรันอยู่แต่พอร์ตปิด
- `logs` ไล่ดูล็อกไฟล์Gatewayผ่าน RPC (ไม่ต้อง `tail`/`grep` ด้วยตนเอง)
- หากตรวจพบบริการคล้ายGatewayอื่นๆ CLI จะเตือนเว้นแต่จะเป็นบริการโปรไฟล์OpenClaw
  เรายังแนะนำ **หนึ่งGatewayต่อเครื่อง** สำหรับการตั้งค่าส่วนใหญ่; ใช้โปรไฟล์/พอร์ตที่แยกเพื่อความซ้ำซ้อนหรือบอตกู้ภัย ดู [Multiple gateways](/gateway/multiple-gateways).
  We still recommend **one gateway per machine** for most setups; use isolated profiles/ports for redundancy or a rescue bot. See [Multiple gateways](/gateway/multiple-gateways).
  - การทำความสะอาด: `openclaw gateway uninstall` (บริการปัจจุบัน) และ `openclaw doctor` (การย้ายเดิม)
- `gateway install` ไม่ทำอะไรเมื่อมีการติดตั้งอยู่แล้ว; ใช้ `openclaw gateway install --force` เพื่อติดตั้งใหม่ (เปลี่ยนโปรไฟล์/env/พาธ)

แอปmacOSแบบบันเดิล:

- OpenClaw.app สามารถบันเดิลรีเลย์GatewayแบบNodeและติดตั้ง LaunchAgent ต่อผู้ใช้ที่ติดป้ายกำกับ
  `bot.molt.gateway` (หรือ `bot.molt.<profile>`; ป้ายเดิม `com.openclaw.*` ยังถอดได้อย่างสะอาด)
- เพื่อหยุดอย่างเรียบร้อย ใช้ `openclaw gateway stop` (หรือ `launchctl bootout gui/$UID/bot.molt.gateway`).
- เพื่อรีสตาร์ต ใช้ `openclaw gateway restart` (หรือ `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` ใช้ได้เฉพาะเมื่อมีการติดตั้ง LaunchAgent มิฉะนั้นใช้ `openclaw gateway install` ก่อน
  - แทนที่ป้ายด้วย `bot.molt.<profile>` เมื่อรันโปรไฟล์ที่ตั้งชื่อ

## การกำกับดูแล (systemd user unit)

OpenClaw ติดตั้ง **systemd user service** โดยค่าเริ่มต้นบน Linux/WSL2 เรา
แนะนำบริการผู้ใช้สำหรับเครื่องผู้ใช้เดี่ยว (env ง่าย คอนฟิกต่อผู้ใช้)
ใช้ **system service** สำหรับหลายผู้ใช้หรือเซิร์ฟเวอร์ที่เปิดตลอด (ไม่ต้อง lingering การกำกับดูแลร่วม) We
recommend user services for single-user machines (simpler env, per-user config).
Use a **system service** for multi-user or always-on servers (no lingering
required, shared supervision).

`openclaw gateway install` เขียน user unit. `openclaw doctor` ตรวจสอบ
unit และอัปเดตให้ตรงกับค่าเริ่มต้นที่แนะนำปัจจุบันได้

สร้าง `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

เปิดใช้ lingering (จำเป็นเพื่อให้บริการผู้ใช้ยังอยู่หลังออกจากระบบ/ว่าง):

```
sudo loginctl enable-linger youruser
```

การเริ่มต้นจะรันสิ่งนี้บน Linux/WSL2 (อาจขอ sudo; เขียน `/var/lib/systemd/linger`).
จากนั้นเปิดใช้บริการ:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternative (system service)** - for always-on or multi-user servers, you can
install a systemd **system** unit instead of a user unit (no lingering needed).
**ทางเลือก (system service)** - สำหรับเซิร์ฟเวอร์ที่เปิดตลอดหรือหลายผู้ใช้ คุณสามารถติดตั้ง systemd **system** unit แทน user unit (ไม่ต้อง lingering)
สร้าง `/etc/systemd/system/openclaw-gateway[-<profile>].service` (คัดลอก unit ด้านบน,
สลับ `WantedBy=multi-user.target`, ตั้งค่า `User=` + `WorkingDirectory=`), จากนั้น:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

การติดตั้งบนWindowsควรใช้ **WSL2** และทำตามส่วน systemd ของLinuxด้านบน

## การตรวจสอบการปฏิบัติงาน

- ความมีชีวิต: เปิด WS และส่ง `req:connect` → คาดหวัง `res` พร้อม `payload.type="hello-ok"` (พร้อมสแนปช็อต).
- ความพร้อม: เรียก `health` → คาดหวัง `ok: true` และช่องทางที่เชื่อมโยงใน `linkChannel` (เมื่อมี).
- ดีบัก: สมัครรับอีเวนต์ `tick` และ `presence`; ตรวจสอบว่า `status` แสดงอายุการเชื่อมโยง/การยืนยันตัวตน; รายการ presence แสดงโฮสต์Gatewayและไคลเอนต์ที่เชื่อมต่อ

## การรับประกันด้านความปลอดภัย

- สมมติหนึ่งGatewayต่อโฮสต์โดยค่าเริ่มต้น; หากรันหลายโปรไฟล์ ให้แยกพอร์ต/สถานะและชี้ไปยังอินสแตนซ์ที่ถูกต้อง
- ไม่มีการถอยกลับไปเชื่อมต่อ Baileys โดยตรง; หากGatewayล่ม การส่งจะล้มเหลวทันที
- เฟรมแรกที่ไม่ใช่การเชื่อมต่อหรือ JSON ที่ผิดรูปแบบจะถูกปฏิเสธและปิดซ็อกเก็ต
- ปิดอย่างนุ่มนวล: ส่งอีเวนต์ `shutdown` ก่อนปิด; ไคลเอนต์ต้องจัดการการปิด+เชื่อมต่อใหม่

## ตัวช่วย CLI

- `openclaw gateway health|status` — ขอสุขภาพ/สถานะผ่าน Gateway WS.
- `openclaw message send --target <num> --message "hi" [--media ...]` — ส่งผ่านGateway (ทำซ้ำได้สำหรับWhatsApp).
- `openclaw agent --message "hi" --to <num>` — รันเทิร์นเอเจนต์ (รอผลลัพธ์สุดท้ายโดยค่าเริ่มต้น).
- `openclaw gateway call <method> --params '{"k":"v"}'` — ตัวเรียกเมธอดดิบสำหรับดีบัก.
- `openclaw gateway stop|restart` — หยุด/รีสตาร์ตบริการGatewayที่ถูกกำกับ (launchd/systemd).
- คำสั่งย่อยตัวช่วยGatewayสมมติว่ามีGatewayรันอยู่บน `--url`; จะไม่สปอว์นอัตโนมัติอีกต่อไป

## แนวทางการย้ายระบบ

- เลิกใช้ `openclaw gateway` และพอร์ตควบคุม TCP เดิม
- อัปเดตไคลเอนต์ให้พูดโปรโตคอลWSพร้อมการเชื่อมต่อที่บังคับและ presence แบบมีโครงสร้าง
