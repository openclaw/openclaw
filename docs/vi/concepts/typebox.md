---
summary: "Schema TypeBox làm nguồn sự thật duy nhất cho giao thức Gateway"
read_when:
  - Cập nhật schema giao thức hoặc codegen
title: "TypeBox"
---

# TypeBox là nguồn sự thật cho giao thức

Cập nhật lần cuối: 2026-01-10

TypeBox là một thư viện schema ưu tiên TypeScript. Chúng tôi dùng nó để định nghĩa **giao thức Gateway WebSocket** (bắt tay, yêu cầu/phản hồi, sự kiện máy chủ). Các schema đó
thúc đẩy **xác thực thời gian chạy**, **xuất JSON Schema** và **sinh mã Swift** cho ứng dụng macOS. Một nguồn sự thật; mọi thứ khác đều được sinh ra.

Nếu bạn muốn bối cảnh giao thức ở mức cao hơn, hãy bắt đầu với
[Kiến trúc Gateway](/concepts/architecture).

## Mô hình tư duy (30 giây)

Mỗi thông điệp WS của Gateway là một trong ba frame:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion?
  }` Khung đầu tiên **phải** là một yêu cầu `connect`.

Sau đó, client có thể gọi
các phương thức (ví dụ: `health`, `send`, `chat.send`) và đăng ký sự kiện (ví dụ:
`presence`, `tick`, `agent`). **Phía máy chủ**: mọi khung đến đều được xác thực bằng AJV.

Luồng kết nối (tối thiểu):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Các method + event phổ biến:

| Danh mục  | Ví dụ                                                     | Ghi chú                           |
| --------- | --------------------------------------------------------- | --------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` phải là đầu tiên        |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | tác dụng phụ cần `idempotencyKey` |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat dùng các mục này          |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | quản trị phiên                    |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + hành động node       |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server push                       |

Danh sách có thẩm quyền nằm ở `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Nơi đặt các schema

- Nguồn: `src/gateway/protocol/schema.ts`
- Trình xác thực lúc chạy (AJV): `src/gateway/protocol/index.ts`
- Bắt tay máy chủ + điều phối method: `src/gateway/server.ts`
- Client node: `src/gateway/client.ts`
- JSON Schema được sinh: `dist/protocol.schema.json`
- Model Swift được sinh: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Pipeline hiện tại

- `pnpm protocol:gen`
  - ghi JSON Schema (draft‑07) vào `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - sinh các model Gateway cho Swift
- `pnpm protocol:check`
  - chạy cả hai bộ sinh và xác minh đầu ra đã được commit

## Cách các schema được dùng lúc chạy

- Bắt tay chỉ
  chấp nhận một yêu cầu `connect` có params khớp với `ConnectParams`. JSON Schema được sinh ra nằm trong repo tại `dist/protocol.schema.json`.
- **Phía client**: client JS xác thực các frame sự kiện và phản hồi trước khi
  sử dụng chúng.
- **Bề mặt method**: Gateway công bố các `methods` và
  `events` được hỗ trợ trong `hello-ok`.

## Ví dụ frame

Kết nối (thông điệp đầu tiên):

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

Phản hồi hello-ok:

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

Request + response:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Event:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Client tối thiểu (Node.js)

Luồng nhỏ nhất hữu ích: kết nối + health.

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

## Ví dụ hoàn chỉnh: thêm một method từ đầu đến cuối

Ví dụ: thêm một request `system.echo` mới trả về `{ ok: true, text }`.

1. **Schema (nguồn sự thật)**

Thêm vào `src/gateway/protocol/schema.ts`:

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

Thêm cả hai vào `ProtocolSchemas` và export type:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Xác thực**

Trong `src/gateway/protocol/index.ts`, export một trình xác thực AJV:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Hành vi máy chủ**

Thêm một handler trong `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Đăng ký nó trong `src/gateway/server-methods.ts` (đã gộp `systemHandlers`),
sau đó thêm `"system.echo"` vào `METHODS` trong `src/gateway/server.ts`.

4. **Sinh lại**

```bash
pnpm protocol:check
```

5. **Kiểm thử + tài liệu**

Thêm một test phía máy chủ trong `src/gateway/server.*.test.ts` và ghi chú method trong tài liệu.

## Hành vi codegen Swift

Bộ sinh Swift phát ra:

- enum `GatewayFrame` với các case `req`, `res`, `event`, và `unknown`
- Các struct/enum payload được gõ kiểu chặt chẽ
- Các giá trị `ErrorCode` và `GATEWAY_PROTOCOL_VERSION`

Các loại frame không xác định được giữ nguyên dưới dạng payload thô để tương thích về sau.

## Phiên bản + khả năng tương thích

- `PROTOCOL_VERSION` nằm trong `src/gateway/protocol/schema.ts`.
- Client gửi `minProtocol` + `maxProtocol`; máy chủ từ chối nếu không khớp.
- Các model Swift giữ lại các loại frame không xác định để tránh làm hỏng client cũ.

## Mẫu schema và quy ước

- Hầu hết các object dùng `additionalProperties: false` cho payload chặt chẽ.
- `NonEmptyString` là mặc định cho ID và tên method/event.
- `GatewayFrame` cấp cao nhất dùng **discriminator** trên `type`.
- Các method có tác dụng phụ thường yêu cầu một `idempotencyKey` trong params
  (ví dụ: `send`, `poll`, `agent`, `chat.send`).

## JSON schema trực tiếp

Tệp thô đã phát hành thường có sẵn tại: Chỉ báo đang gõ được gửi tới kênh chat trong khi một lần chạy đang hoạt động.

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Khi bạn thay đổi schema

1. Cập nhật các schema TypeBox.
2. Chạy `pnpm protocol:check`.
3. Commit schema và các model Swift đã được sinh lại.
