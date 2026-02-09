---
summary: "โปรโตคอลBridge(โหนดแบบดั้งเดิม): TCP JSONL, การจับคู่, RPCแบบมีขอบเขต"
read_when:
  - สร้างหรือดีบักไคลเอนต์โหนด(โหมดโหนด iOS/Android/macOS)
  - ตรวจสอบปัญหาการจับคู่หรือความล้มเหลวของการยืนยันตัวตนBridge
  - ตรวจสอบพื้นผิวโหนดที่Gatewayเปิดให้ใช้งาน
title: "โปรโตคอลBridge"
---

# โปรโตคอลBridge(ทรานสปอร์ตโหนดแบบดั้งเดิม)

โปรโตคอลBridgeเป็นทรานสปอร์ตโหนดแบบ**ดั้งเดิม**(TCP JSONL) ไคลเอนต์โหนดรุ่นใหม่
ควรใช้โปรโตคอลGateway WebSocketแบบรวมศูนย์แทน New node clients
should use the unified Gateway WebSocket protocol instead.

หากคุณกำลังสร้างโอเปอเรเตอร์หรือไคลเอนต์โหนด ให้ใช้
[โปรโตคอลGateway](/gateway/protocol)

**หมายเหตุ:** บิลด์ OpenClaw ปัจจุบันไม่ได้รวมตัวรับฟัง TCP bridge แล้ว เอกสารนี้เก็บไว้เพื่อการอ้างอิงทางประวัติศาสตร์
คีย์คอนฟิกแบบดั้งเดิม `bridge.*` ไม่ได้เป็นส่วนหนึ่งของสคีมาคอนฟิกอีกต่อไป
Legacy `bridge.*` config keys are no longer part of the config schema.

## ทำไมเราจึงมีทั้งสองแบบ

- **ขอบเขตความปลอดภัย**: bridge เปิดเผยรายการอนุญาตขนาดเล็กแทนที่จะเป็นพื้นผิว API ของGatewayทั้งหมด
- **การจับคู่+ตัวตนโหนด**: การรับโหนดถูกควบคุมโดยGatewayและผูกกับโทเคนต่อโหนด
- **UXด้านDiscovery**: โหนดสามารถค้นหาGatewayผ่าน Bonjour บน LAN หรือเชื่อมต่อโดยตรงผ่าน tailnet
- **Loopback WS**: ระนาบควบคุม WS ทั้งหมดยังคงอยู่ในเครื่อง เว้นแต่จะถูกอุโมงค์ผ่าน SSH

## ทรานสปอร์ต

- TCP, หนึ่งอ็อบเจ็กต์ JSON ต่อบรรทัด(JSONL)
- TLS แบบไม่บังคับ(เมื่อ `bridge.tls.enabled` เป็น true)
- พอร์ตตัวรับฟังเริ่มต้นแบบดั้งเดิมคือ `18790` (บิลด์ปัจจุบันไม่เริ่ม TCP bridge)

เมื่อเปิดใช้ TLS ระเบียน TXT ของDiscoveryจะรวม `bridgeTls=1` พร้อมกับ
`bridgeTlsSha256` เพื่อให้โหนดสามารถทำการ pin ใบรับรองได้

## แฮนด์เชค+การจับคู่

1. ไคลเอนต์ส่ง `hello` พร้อมเมตาดาตาโหนด+โทเคน(หากจับคู่แล้ว)
2. หากยังไม่จับคู่ Gatewayจะตอบกลับ `error` (`NOT_PAIRED`/`UNAUTHORIZED`)
3. ไคลเอนต์ส่ง `pair-request`
4. Gatewayรอการอนุมัติ จากนั้นส่ง `pair-ok` และ `hello-ok`

`hello-ok` จะคืนค่า `serverName` และอาจรวม `canvasHostUrl`

## เฟรม

ไคลเอนต์ → Gateway:

- `req` / `res`: GatewayRPCแบบมีขอบเขต(chat, sessions, config, health, voicewake, skills.bins)
- `event`: สัญญาณโหนด(ถอดเสียง, คำขอเอเจนต์, สมัครรับแชต, วงจรชีวิตการรันคำสั่ง)

Gateway → ไคลเอนต์:

- `invoke` / `invoke-res`: คำสั่งโหนด(`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: อัปเดตแชตสำหรับเซสชันที่สมัครรับ
- `ping` / `pong`: keepalive

การบังคับใช้ allowlist แบบดั้งเดิมอยู่ใน `src/gateway/server-bridge.ts` (ถูกถอดออกแล้ว)

## อีเวนต์วงจรชีวิตการรันคำสั่ง

โหนดสามารถส่งอีเวนต์ `exec.finished` หรือ `exec.denied` เพื่อแสดงกิจกรรม system.run
อีเวนต์เหล่านี้จะถูกแมปเป็นอีเวนต์ของระบบในGateway (โหนดแบบดั้งเดิมอาจยังส่ง `exec.started`)
These are mapped to system events in the gateway. (Legacy nodes may still emit `exec.started`.)

ฟิลด์ของเพย์โหลด(ทั้งหมดเป็นตัวเลือกเว้นแต่ระบุไว้):

- `sessionKey` (จำเป็น): เซสชันเอเจนต์ที่จะรับอีเวนต์ของระบบ
- `runId`: exec id ที่ไม่ซ้ำสำหรับการจัดกลุ่ม
- `command`: สตริงคำสั่งแบบดิบหรือจัดรูปแบบแล้ว
- `exitCode`, `timedOut`, `success`, `output`: รายละเอียดการเสร็จสิ้น(เฉพาะกรณีเสร็จแล้ว)
- `reason`: เหตุผลการปฏิเสธ(เฉพาะกรณีถูกปฏิเสธ)

## การใช้งานTailnet

- ผูก bridge กับ IP ของ tailnet: `bridge.bind: "tailnet"` ใน
  `~/.openclaw/openclaw.json`
- ไคลเอนต์เชื่อมต่อผ่านชื่อ MagicDNS หรือ IP ของ tailnet
- Bonjour **ไม่**ข้ามเครือข่าย ใช้โฮสต์/พอร์ตแบบกำหนดเองหรือ DNS‑SD แบบพื้นที่กว้างเมื่อจำเป็น

## การกำหนดเวอร์ชัน

Bridgeปัจจุบันเป็น**v1โดยนัย**(ไม่มีการเจรจา min/max) คาดว่าจะคงความเข้ากันได้ย้อนหลัง
ควรเพิ่มฟิลด์เวอร์ชันโปรโตคอลBridgeก่อนการเปลี่ยนแปลงที่ทำให้เข้ากันไม่ได้ Backward‑compat
is expected; add a bridge protocol version field before any breaking changes.
