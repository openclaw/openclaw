---
summary: "Gateway ပရိုတိုကောအတွက် အမှန်တရားတစ်ခုတည်းသော အရင်းအမြစ်အဖြစ် TypeBox schema များ"
read_when:
  - ပရိုတိုကော schema များ သို့မဟုတ် codegen ကို အပ်ဒိတ်လုပ်နေချိန်
title: "TypeBox"
---

# ပရိုတိုကောအတွက် အမှန်တရားရင်းမြစ်အဖြစ် TypeBox

နောက်ဆုံးအပ်ဒိတ်လုပ်ခဲ့သည့်နေ့: 2026-01-10

TypeBox သည် TypeScript ကို အခြေခံထားသော schema library တစ်ခု ဖြစ်ပါသည်။ ၎င်းကို **Gateway WebSocket protocol** (handshake, request/response, server events) ကို သတ်မှတ်ရန် အသုံးပြုပါသည်။ ထို schema များသည် **runtime validation**, **JSON Schema export**, နှင့် macOS app အတွက် **Swift codegen** ကို မောင်းနှင်ပေးပါသည်။ အချက်အလက်ရင်းမြစ် တစ်ခုတည်းရှိပြီး အခြားအားလုံးကို ထုတ်လုပ်ထားပါသည်။

ပရိုတိုကောကို အမြင်ကျယ်ကျယ် နားလည်လိုပါက
[Gateway architecture](/concepts/architecture) မှ စတင်ကြည့်ရှုပါ။

## စိတ်ကူးပုံစံ (စက္ကန့် ၃၀)

Gateway WS မက်ဆေ့ချ်တိုင်းသည် frame သုံးမျိုးထဲမှ တစ်မျိုးဖြစ်ပါသည်-

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion?
   }`

ပထမ frame သည် မဖြစ်မနေ `connect` request ဖြစ်ရပါမည်။ အပြီးတွင် client များသည် methods (ဥပမာ `health`, `send`, `chat.send`) ကို ခေါ်နိုင်ပြီး events (ဥပမာ `presence`, `tick`, `agent`) ကို subscribe လုပ်နိုင်ပါသည်။

ချိတ်ဆက်မှု လုပ်ငန်းစဉ် (အနည်းဆုံး):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

ပုံမှန်အသုံးများသော method များ + event များ:

| အမျိုးအစား | ဥပမာများ                                                  | မှတ်ချက်များ                                       |
| ---------- | --------------------------------------------------------- | -------------------------------------------------- |
| Core       | `connect`, `health`, `status`                             | `connect` သည် ပထမဆုံး ဖြစ်ရပါမည်                   |
| Messaging  | `send`, `poll`, `agent`, `agent.wait`                     | side-effect များအတွက် `idempotencyKey` လိုအပ်ပါသည် |
| Chat       | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat သည် ဤအရာများကို အသုံးပြုပါသည်              |
| Sessions   | `sessions.list`, `sessions.patch`, `sessions.delete`      | session စီမံခန့်ခွဲမှု                             |
| Nodes      | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + node လုပ်ဆောင်ချက်များ                |
| Events     | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | server မှ push လုပ်ခြင်း                           |

အတည်ပြုထားသော စာရင်းအပြည့်အစုံသည် `src/gateway/server.ts` တွင်ရှိပြီး (`METHODS`, `EVENTS`) ဖြစ်ပါသည်။

## schema များ တည်ရှိရာနေရာ

- အရင်းအမြစ်: `src/gateway/protocol/schema.ts`
- Runtime validator များ (AJV): `src/gateway/protocol/index.ts`
- Server handshake + method dispatch: `src/gateway/server.ts`
- Node client: `src/gateway/client.ts`
- ထုတ်လုပ်ထားသော JSON Schema: `dist/protocol.schema.json`
- ထုတ်လုပ်ထားသော Swift model များ: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## လက်ရှိ pipeline

- `pnpm protocol:gen`
  - JSON Schema (draft‑07) ကို `dist/protocol.schema.json` သို့ ရေးသားပါသည်
- `pnpm protocol:gen:swift`
  - Swift gateway model များကို ထုတ်လုပ်ပါသည်
- `pnpm protocol:check`
  - generator နှစ်ခုလုံးကို အလုပ်လုပ်စေပြီး ထွက်လာသောအရာများကို commit လုပ်ထားကြောင်း စစ်ဆေးပါသည်

## runtime တွင် schema များကို အသုံးပြုပုံ

- **Server side**: ဝင်လာသော frame အားလုံးကို AJV ဖြင့် validation လုပ်ပါသည်။ handshake သည် params များက `ConnectParams` နှင့် ကိုက်ညီသော `connect` request တစ်ခုတည်းကိုသာ လက်ခံပါသည်။
- **Client ဘက်**: JS client သည် event နှင့် response frame များကို အသုံးမပြုမီ validation လုပ်ပါသည်။
- **Method surface**: Gateway သည် ပံ့ပိုးထားသော `methods` နှင့်
  `events` ကို `hello-ok` တွင် ကြော်ငြာပါသည်။

## ဥပမာ frame များ

ချိတ်ဆက်ခြင်း (ပထမဆုံး မက်ဆေ့ချ်):

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

Hello-ok response:

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

## အနည်းဆုံး client (Node.js)

အသုံးဝင်ဆုံး အနည်းဆုံး လုပ်ငန်းစဉ်: ချိတ်ဆက်ခြင်း + health စစ်ဆေးခြင်း။

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

## လုပ်ငန်းစဉ်တစ်ခုလုံးပါဝင်သည့် ဥပမာ: method တစ်ခု ထည့်သွင်းခြင်း

ဥပမာ: `{ ok: true, text }` ကို ပြန်ပေးသော `system.echo` request အသစ်တစ်ခု ထည့်သွင်းပါ။

1. **Schema (အမှန်တရားရင်းမြစ်)**

`src/gateway/protocol/schema.ts` ထဲသို့ ထည့်ပါ-

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

`ProtocolSchemas` ထဲသို့ နှစ်ခုလုံး ထည့်ပြီး type များကို export လုပ်ပါ-

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validation**

`src/gateway/protocol/index.ts` တွင် AJV validator တစ်ခုကို export လုပ်ပါ-

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Server အပြုအမူ**

`src/gateway/server-methods/system.ts` တွင် handler တစ်ခု ထည့်ပါ-

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

`src/gateway/server-methods.ts` တွင် register လုပ်ပါ (`systemHandlers` ကို ရောနှောထားပြီးသား),
ထို့နောက် `src/gateway/server.ts` ထဲရှိ `METHODS` သို့ `"system.echo"` ကို ထည့်ပါ။

4. **ပြန်လည်ထုတ်လုပ်ခြင်း**

```bash
pnpm protocol:check
```

5. **စမ်းသပ်မှုများ + စာရွက်စာတမ်း**

`src/gateway/server.*.test.ts` တွင် server test တစ်ခု ထည့်ပြီး စာရွက်စာတမ်းများတွင် method ကို မှတ်သားပါ။

## Swift codegen အပြုအမူ

Swift generator သည် အောက်ပါအရာများကို ထုတ်ပေးပါသည်-

- `req`, `res`, `event`, နှင့် `unknown` case များပါဝင်သော `GatewayFrame` enum
- အမျိုးအစားတင်းကြပ်သော payload struct/enum များ
- `ErrorCode` တန်ဖိုးများ နှင့် `GATEWAY_PROTOCOL_VERSION`

မသိသော frame အမျိုးအစားများကို အနာဂတ်နှင့် ကိုက်ညီမှုရှိစေရန် raw payload အဖြစ် ထိန်းသိမ်းထားပါသည်။

## Versioning + ကိုက်ညီမှု

- `PROTOCOL_VERSION` သည် `src/gateway/protocol/schema.ts` တွင် ရှိပါသည်။
- Client များသည် `minProtocol` + `maxProtocol` ကို ပို့ပြီး server သည် မကိုက်ညီပါက ပယ်ချပါသည်။
- Swift model များသည် အဟောင်း client များ မပျက်စီးစေရန် မသိသော frame အမျိုးအစားများကို ထိန်းသိမ်းထားပါသည်။

## Schema ပုံစံများနှင့် စည်းမျဉ်းများ

- အရာဝတ္ထုအများစုသည် တင်းကြပ်သော payload များအတွက် `additionalProperties: false` ကို အသုံးပြုပါသည်။
- ID များနှင့် method/event အမည်များအတွက် မူလသတ်မှတ်ချက်မှာ `NonEmptyString` ဖြစ်ပါသည်။
- ထိပ်တန်း `GatewayFrame` သည် `type` အပေါ် **discriminator** တစ်ခုကို အသုံးပြုပါသည်။
- side-effect ပါသော method များတွင် အများအားဖြင့် param ထဲတွင် `idempotencyKey` လိုအပ်ပါသည်
  (ဥပမာ: `send`, `poll`, `agent`, `chat.send`)။

## Live schema JSON

ထုတ်လုပ်ထားသော JSON Schema ကို repo အတွင်း `dist/protocol.schema.json` တွင် ရရှိနိုင်ပါသည်။ ထုတ်ဝေထားသော raw ဖိုင်ကို ပုံမှန်အားဖြင့် အောက်ပါနေရာတွင် ရရှိနိုင်ပါသည်:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Schema များကို ပြောင်းလဲသောအခါ

1. TypeBox schema များကို အပ်ဒိတ်လုပ်ပါ။
2. `pnpm protocol:check` ကို လည်ပတ်ပါ။
3. ပြန်လည်ထုတ်လုပ်ထားသော schema နှင့် Swift model များကို commit လုပ်ပါ။
