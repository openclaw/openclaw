---
summary: "โปรโตคอลWebSocketของGateway: แฮนด์เชค, เฟรม, การกำหนดเวอร์ชัน"
read_when:
  - เมื่อนำไปใช้หรืออัปเดตไคลเอนต์WSของGateway
  - เมื่อแก้ไขปัญหาความไม่ตรงกันของโปรโตคอลหรือการเชื่อมต่อล้มเหลว
  - เมื่อสร้างสคีมา/โมเดลของโปรโตคอลใหม่
title: "โปรโตคอลGateway"
---

# โปรโตคอลGateway(WebSocket)

โปรโตคอล Gateway WS เป็น **คอนโทรลเพลนเดียว + การขนส่งโหนด** สำหรับ OpenClaw โปรโตคอลWSของGatewayเป็น **ระนาบควบคุมเดียว+ทรานสปอร์ตของโหนด** สำหรับ
OpenClaw ไคลเอนต์ทั้งหมด(CLI, เว็บUI, แอปmacOS, โหนดiOS/Android, โหนดแบบไม่มีส่วนหัว)
เชื่อมต่อผ่านWebSocketและประกาศ **บทบาท** + **ขอบเขต** ของตนในช่วงแฮนด์เชค

## ทรานสปอร์ต

- WebSocket, เฟรมข้อความพร้อมเพย์โหลดJSON
- เฟรมแรก **ต้อง** เป็นคำขอ `connect`

## แฮนด์เชค(เชื่อมต่อ)

Gateway → ไคลเอนต์(ความท้าทายก่อนเชื่อมต่อ):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

ไคลเอนต์ → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → ไคลเอนต์:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

เมื่อมีการออกโทเคนอุปกรณ์ `hello-ok` จะรวมสิ่งต่อไปนี้ด้วย:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### ตัวอย่างโหนด

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## การจัดเฟรม

- **คำขอ**: `{type:"req", id, method, params}`
- **การตอบกลับ**: `{type:"res", id, ok, payload|error}`
- **อีเวนต์**: `{type:"event", event, payload, seq?, stateVersion?}`

เมธอดที่ก่อให้เกิดผลข้างเคียงต้องใช้ **คีย์idempotency** (ดูสคีมา)

## บทบาท+ขอบเขต

### บทบาท

- `operator` = ไคลเอนต์ระนาบควบคุม(CLI/UI/ระบบอัตโนมัติ)
- `node` = โฮสต์ความสามารถ(camera/screen/canvas/system.run)

### ขอบเขต(ผู้ปฏิบัติการ)

ขอบเขตที่ใช้บ่อย:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### ความสามารถ/คำสั่ง/สิทธิ์(โหนด)

โหนดประกาศการอ้างสิทธิ์ความสามารถเมื่อเชื่อมต่อ:

- `caps`: หมวดหมู่ความสามารถระดับสูง
- `commands`: รายการอนุญาตคำสั่งสำหรับการเรียกใช้
- `permissions`: ตัวเลือกย่อยแบบละเอียด(เช่น `screen.record`, `camera.capture`)

Gatewayถือว่าสิ่งเหล่านี้เป็น **การอ้างสิทธิ์** และบังคับใช้รายการอนุญาตฝั่งเซิร์ฟเวอร์

## Presence

- `system-presence` ส่งคืนรายการที่จัดคีย์ตามอัตลักษณ์อุปกรณ์
- รายการสถานะการมีอยู่รวม `deviceId`, `roles`, และ `scopes` เพื่อให้UIแสดงหนึ่งแถวต่ออุปกรณ์
  แม้จะเชื่อมต่อทั้งในบทบาท **ผู้ปฏิบัติการ** และ **โหนด**

### เมธอดช่วยสำหรับโหนด

- โหนดอาจเรียก `skills.bins` เพื่อดึงรายการปัจจุบันของไฟล์ปฏิบัติการของสกิล
  สำหรับการตรวจสอบการอนุญาตอัตโนมัติ

## Exec approvals

- เมื่อคำขอรันคำสั่งต้องการการอนุมัติ Gatewayจะกระจาย `exec.approval.requested`
- ไคลเอนต์ผู้ปฏิบัติการแก้ไขโดยเรียก `exec.approval.resolve` (ต้องมีขอบเขต `operator.approvals`)

## การกำหนดเวอร์ชัน

- `PROTOCOL_VERSION` อยู่ใน `src/gateway/protocol/schema.ts`
- ไคลเอนต์ส่ง `minProtocol` + `maxProtocol`; เซิร์ฟเวอร์จะปฏิเสธเมื่อไม่ตรงกัน
- สคีมา+โมเดลถูกสร้างจากคำจำกัดความTypeBox:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## การยืนยันตัวตน

- หากตั้งค่า `OPENCLAW_GATEWAY_TOKEN` (หรือ `--token`) ไว้ ค่า `connect.params.auth.token`
  ต้องตรงกัน มิฉะนั้นซ็อกเก็ตจะถูกปิด
- หลังการจับคู่ Gatewayจะออก **โทเคนอุปกรณ์** ที่ผูกกับบทบาท+ขอบเขตของการเชื่อมต่อ
  โทเคนจะถูกส่งกลับใน `hello-ok.auth.deviceToken` และควรถูกบันทึกโดยไคลเอนต์เพื่อการเชื่อมต่อครั้งถัดไป มันถูกส่งกลับมาใน `hello-ok.auth.deviceToken` และควรถูกเก็บไว้โดยไคลเอนต์เพื่อใช้ในการเชื่อมต่อครั้งถัดไป
- โทเคนอุปกรณ์สามารถหมุนเวียน/เพิกถอนได้ผ่าน `device.token.rotate` และ
  `device.token.revoke` (ต้องมีขอบเขต `operator.pairing`)

## อัตลักษณ์อุปกรณ์+การจับคู่

- โหนดควรรวมอัตลักษณ์อุปกรณ์ที่เสถียร(`device.id`) ซึ่งได้มาจากลายนิ้วมือของคีย์แพร์
- Gatewayออกโทเคนต่ออุปกรณ์+บทบาท
- การอนุมัติการจับคู่จำเป็นสำหรับIDอุปกรณ์ใหม่ เว้นแต่จะเปิดการอนุมัติอัตโนมัติภายในเครื่อง
- การเชื่อมต่อแบบ **ภายในเครื่อง** รวม loopback และที่อยู่tailnetของโฮสต์Gatewayเอง
  (เพื่อให้การผูกtailnetบนโฮสต์เดียวกันยังคงอนุมัติอัตโนมัติได้)
- ไคลเอนต์ WS ทุกตัวต้องระบุตัวตน `device` ระหว่าง `connect` (ผู้ปฏิบัติการ + โหนด)
  ไคลเอนต์WSทั้งหมดต้องรวมอัตลักษณ์ `device` ระหว่าง `connect` (ผู้ปฏิบัติการ+โหนด)
  Control UIสามารถละเว้นได้ **เฉพาะ** เมื่อเปิด `gateway.controlUi.allowInsecureAuth`
  (หรือ `gateway.controlUi.dangerouslyDisableDeviceAuth` สำหรับการใช้งานแบบbreak-glass)
- การเชื่อมต่อที่ไม่ใช่ภายในเครื่องต้องลงนาม nonce `connect.challenge` ที่เซิร์ฟเวอร์จัดให้

## TLS+การปักหมุด

- รองรับTLSสำหรับการเชื่อมต่อWS
- ไคลเอนต์อาจเลือกปักหมุดลายนิ้วมือใบรับรองของGateway(ดูคอนฟิก `gateway.tls`
  รวมถึง `gateway.remote.tlsFingerprint` หรือ CLI `--tls-fingerprint`)

## ขอบเขต

โปรโตคอลนี้เปิดเผย **APIของGatewayทั้งหมด** (สถานะ, ช่องทาง, โมเดล, แชต,
เอเจนต์, เซสชัน, โหนด, การอนุมัติ ฯลฯ) พื้นผิวที่แน่นอนถูกกำหนดโดย
สคีมาTypeBoxใน `src/gateway/protocol/schema.ts` ขอบเขตที่แน่นอนถูกกำหนดโดยสคีมา TypeBox ใน `src/gateway/protocol/schema.ts`
