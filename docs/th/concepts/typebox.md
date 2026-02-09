---
summary: "สคีมา TypeBox เป็นแหล่งความจริงเดียวสำหรับโปรโตคอลของGateway"
read_when:
  - การอัปเดตสคีมาโปรโตคอลหรือโค้ดเจน
title: "TypeBox"
---

# TypeBox เป็นแหล่งความจริงของโปรโตคอล

อัปเดตล่าสุด: 2026-01-10

เราใช้มันเพื่อกำหนด **Gateway
WebSocket protocol** (การจับมือ, คำขอ/การตอบกลับ, อีเวนต์ฝั่งเซิร์ฟเวอร์) สคีมาเหล่านั้นขับเคลื่อน **การตรวจสอบขณะรันไทม์**, **การส่งออก JSON Schema** และ **การสร้างโค้ด Swift** สำหรับแอป macOS แหล่งความจริงเดียว; ที่เหลือทั้งหมดถูกสร้างขึ้น เฟรมแรก **ต้อง** เป็นคำขอ `connect`

หากต้องการบริบทระดับสูงของโปรโตคอล ให้เริ่มจาก
[Gateway architecture](/concepts/architecture)

## โมเดลความคิด (30 วินาที)

ทุกข้อความ Gateway WS เป็นหนึ่งในสามเฟรม:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

ผู้ดูแลเซสชัน เฟรมแรก **ต้อง** เป็นคำขอ `connect` หลังจากนั้นไคลเอนต์สามารถเรียกเมธอด (เช่น `health`, `send`, `chat.send`) และสมัครรับอีเวนต์ (เช่น
`presence`, `tick`, `agent`)

ลำดับการเชื่อมต่อ (ขั้นต่ำ):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

เมธอดและอีเวนต์ที่ใช้ร่วมกันบ่อย:

| หมวดหมู่  | ตัวอย่าง                                                  | หมายเหตุ                              |
| --------- | --------------------------------------------------------- | ------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` ต้องมาก่อน                  |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | side-effects ต้องใช้ `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat ใช้สิ่งเหล่านี้               |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | ตำแหน่งที่สคีมาอยู่                   |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + การทำงานของโหนด          |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | เซิร์ฟเวอร์พุช                        |

รายการที่เป็นทางการอยู่ที่ `src/gateway/server.ts` (`METHODS`, `EVENTS`)

## การจับมือจะยอมรับเฉพาะคำขอ `connect` ที่พารามิเตอร์ตรงกับ `ConnectParams`

- แหล่งที่มา: `src/gateway/protocol/schema.ts`
- ตัวตรวจสอบรันไทม์ (AJV): `src/gateway/protocol/index.ts`
- แฮนด์เชคของเซิร์ฟเวอร์ + การกระจายเมธอด: `src/gateway/server.ts`
- ไคลเอนต์โหนด: `src/gateway/client.ts`
- JSON Schema ที่สร้างแล้ว: `dist/protocol.schema.json`
- โมเดล Swift ที่สร้างแล้ว: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## พายป์ไลน์ปัจจุบัน

- `pnpm protocol:gen`
  - เขียน JSON Schema (draft‑07) ไปที่ `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - สร้างโมเดล Gateway สำหรับ Swift
- `pnpm protocol:check`
  - รันตัวสร้างทั้งสองและตรวจสอบว่าผลลัพธ์ถูกคอมมิตแล้ว

## วิธีใช้สคีมาที่รันไทม์

- **ฝั่งเซิร์ฟเวอร์**: ทุกเฟรมขาเข้าถูกตรวจสอบด้วย AJV แฮนด์เชครับเฉพาะคำขอ `connect` ที่พารามิเตอร์ตรงกับ `ConnectParams` ไฟล์ดิบที่เผยแพร่มักจะพร้อมใช้งานที่:
- **ฝั่งไคลเอนต์**: ไคลเอนต์ JS ตรวจสอบเฟรมอีเวนต์และคำตอบก่อนนำไปใช้
- **พื้นผิวเมธอด**: Gateway โฆษณา `methods` และ `events` ที่รองรับใน `hello-ok`

## ตัวอย่างเฟรม

เชื่อมต่อ (ข้อความแรก):

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 2,
    "maxProtocol": 2,
    "client": {
      "id": "openclaw-macos",
      "displayName": "macos",
      "version": "1.0.0",
      "platform": "macos 15.1",
      "mode": "ui",
      "instanceId": "A1B2"
    }
  }
}
```

คำตอบ Hello-ok:

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 2,
    "server": { "version": "dev", "connId": "ws-1" },
    "features": { "methods": ["health"], "events": ["tick"] },
    "snapshot": {
      "presence": [],
      "health": {},
      "stateVersion": { "presence": 0, "health": 0 },
      "uptimeMs": 0
    },
    "policy": { "maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 30000 }
  }
}
```

คำขอ + คำตอบ:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

อีเวนต์:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## ไคลเอนต์ขั้นต่ำ (Node.js)

โฟลว์ที่เล็กที่สุดแต่ใช้งานได้: เชื่อมต่อ + สุขภาพระบบ

```ts
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "example",
          version: "dev",
          platform: "node",
          mode: "cli",
        },
      },
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === "res" && msg.id === "c1" && msg.ok) {
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
  }
  if (msg.type === "res" && msg.id === "h1") {
    console.log("health:", msg.payload);
    ws.close();
  }
});
```

## ตัวอย่างทำงานจริง: เพิ่มเมธอดแบบครบวงจร

ตัวอย่าง: เพิ่มคำขอ `system.echo` ใหม่ที่คืนค่า `{ ok: true, text }`

1. **สคีมา (แหล่งความจริง)**

เพิ่มไปที่ `src/gateway/protocol/schema.ts`:

```ts
export const SystemEchoParamsSchema = Type.Object(
  { text: NonEmptyString },
  { additionalProperties: false },
);

export const SystemEchoResultSchema = Type.Object(
  { ok: Type.Boolean(), text: NonEmptyString },
  { additionalProperties: false },
);
```

เพิ่มทั้งสองไปที่ `ProtocolSchemas` และส่งออกชนิดข้อมูล:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **การตรวจสอบ**

ใน `src/gateway/protocol/index.ts` ส่งออกตัวตรวจสอบ AJV:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **พฤติกรรมฝั่งเซิร์ฟเวอร์**

เพิ่มแฮนด์เลอร์ใน `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

ลงทะเบียนใน `src/gateway/server-methods.ts` (รวม `systemHandlers` อยู่แล้ว)
จากนั้นเพิ่ม `"system.echo"` ไปที่ `METHODS` ใน `src/gateway/server.ts`

4. **สร้างใหม่**

```bash
pnpm protocol:check
```

5. **การทดสอบ + เอกสาร**

เพิ่มการทดสอบเซิร์ฟเวอร์ใน `src/gateway/server.*.test.ts` และบันทึกเมธอดไว้ในเอกสาร

## พฤติกรรมการสร้างโค้ด Swift

ตัวสร้าง Swift จะสร้าง:

- enum `GatewayFrame` ที่มีกรณี `req`, `res`, `event` และ `unknown`
- โครงสร้าง/enum ของเพย์โหลดที่มีชนิดข้อมูลชัดเจน
- ค่า `ErrorCode` และ `GATEWAY_PROTOCOL_VERSION`

ชนิดเฟรมที่ไม่รู้จักจะถูกเก็บเป็นเพย์โหลดดิบเพื่อรองรับความเข้ากันได้ในอนาคต

## เวอร์ชันและความเข้ากันได้

- `PROTOCOL_VERSION` อยู่ใน `src/gateway/protocol/schema.ts`
- ไคลเอนต์ส่ง `minProtocol` + `maxProtocol`; เซิร์ฟเวอร์ปฏิเสธหากไม่ตรงกัน
- โมเดล Swift เก็บชนิดเฟรมที่ไม่รู้จักไว้เพื่อหลีกเลี่ยงการทำให้ไคลเอนต์รุ่นเก่าพัง

## รูปแบบและข้อตกลงของสคีมา

- วัตถุส่วนใหญ่ใช้ `additionalProperties: false` สำหรับเพย์โหลดที่เคร่งครัด
- ค่าเริ่มต้นสำหรับ ID และชื่อเมธอด/อีเวนต์คือ `NonEmptyString`
- ระดับบนสุด `GatewayFrame` ใช้ **ตัวแยกแยะ** บน `type`
- เมธอดที่มีผลข้างเคียงมักต้องมี `idempotencyKey` ในพารามิเตอร์
  (ตัวอย่าง: `send`, `poll`, `agent`, `chat.send`)

## JSON สคีมาสด

JSON Schema ที่สร้างแล้วอยู่ในรีโปที่ `dist/protocol.schema.json` โดยไฟล์ดิบที่เผยแพร่มักจะอยู่ที่: ตัวบ่งชี้การพิมพ์จะถูกส่งไปยังช่องแชตขณะมีการรันอยู่

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## เมื่อคุณเปลี่ยนสคีมา

1. อัปเดตสคีมา TypeBox
2. รัน `pnpm protocol:check`
3. คอมมิตสคีมาและโมเดล Swift ที่สร้างใหม่
