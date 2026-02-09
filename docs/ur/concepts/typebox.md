---
summary: "گیٹ وے پروٹوکول کے لیے واحد ماخذِ حقیقت کے طور پر TypeBox اسکیمائیں"
read_when:
  - پروٹوکول اسکیمائیں یا کوڈ جنریشن اپ ڈیٹ کرتے وقت
title: "TypeBox"
---

# پروٹوکول کے واحد ماخذِ حقیقت کے طور پر TypeBox

آخری بار اپ ڈیٹ: 2026-01-10

29. TypeBox ایک TypeScript‑first اسکیما لائبریری ہے۔ 30. ہم اسے **Gateway
    WebSocket پروٹوکول** (ہینڈشیک، ریکویسٹ/ریسپانس، سرور ایونٹس) کی تعریف کے لیے استعمال کرتے ہیں۔ 31. یہ اسکیماز
    **رن ٹائم ویلیڈیشن**، **JSON Schema ایکسپورٹ**، اور
    macOS ایپ کے لیے **Swift codegen** کو چلاتی ہیں۔ 46. ایک ہی ماخذِ حقیقت؛ باقی سب کچھ جنریٹ کیا جاتا ہے۔

اگر آپ کو اعلیٰ سطحی پروٹوکول کا سیاق درکار ہو تو
[Gateway architecture](/concepts/architecture) سے آغاز کریں۔

## ذہنی ماڈل (30 سیکنڈ)

ہر Gateway WS پیغام تین میں سے ایک فریم ہوتا ہے:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- 33. **Event**: \`{ type: "event", event, payload, seq?, stateVersion?
  34. }`35. پہلا فریم **لازمی** طور پر`connect\` ریکویسٹ ہونا چاہیے۔

36. اس کے بعد، کلائنٹس
    methods کال کر سکتے ہیں (مثلاً `health`, `send`, `chat.send`) اور ایونٹس کو subscribe کر سکتے ہیں (مثلاً
    `presence`, `tick`, `agent`)۔ 37. **سرور سائیڈ**: ہر inbound فریم AJV کے ذریعے ویلیڈیٹ کیا جاتا ہے۔

کنکشن فلو (کم از کم):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

عام میتھڈز + ایونٹس:

| زمرہ      | مثالیں                                                    | نوٹس                                           |
| --------- | --------------------------------------------------------- | ---------------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` لازماً پہلے ہونا چاہیے               |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | سائیڈ ایفیکٹس کے لیے `idempotencyKey` درکار ہے |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat انہی کو استعمال کرتا ہے                |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | سیشن ایڈمن                                     |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + نوڈ ایکشنز                        |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | سرور پُش                                       |

مستند فہرست `src/gateway/server.ts` (`METHODS`, `EVENTS`) میں موجود ہے۔

## اسکیمائیں کہاں رہتی ہیں

- ماخذ: `src/gateway/protocol/schema.ts`
- رن ٹائم ویلیڈیٹرز (AJV): `src/gateway/protocol/index.ts`
- سرور ہینڈشیک + میتھڈ ڈسپیچ: `src/gateway/server.ts`
- نوڈ کلائنٹ: `src/gateway/client.ts`
- جنریٹ شدہ JSON Schema: `dist/protocol.schema.json`
- جنریٹ شدہ Swift ماڈلز: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## موجودہ پائپ لائن

- `pnpm protocol:gen`
  - JSON Schema (draft‑07) کو `dist/protocol.schema.json` میں لکھتا ہے
- `pnpm protocol:gen:swift`
  - Swift گیٹ وے ماڈلز جنریٹ کرتا ہے
- `pnpm protocol:check`
  - دونوں جنریٹرز چلاتا ہے اور تصدیق کرتا ہے کہ آؤٹ پٹ کمٹ ہو چکا ہے

## رن ٹائم میں اسکیماؤں کا استعمال

- 38. ہینڈشیک صرف
      ایسے `connect` ریکویسٹ کو قبول کرتا ہے جس کے params `ConnectParams` سے میچ کریں۔ 39. جنریٹ شدہ JSON Schema ریپو میں `dist/protocol.schema.json` پر موجود ہے۔
- **کلائنٹ سائیڈ**: JS کلائنٹ ایونٹ اور ریسپانس فریمز کو استعمال کرنے سے پہلے ویلیڈیٹ کرتا ہے۔
- **میتھڈ سرفیس**: Gateway سپورٹ شدہ `methods` اور `events` کو `hello-ok` میں مشتہر کرتا ہے۔

## مثال فریمز

کنیکٹ (پہلا پیغام):

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

Hello-ok ریسپانس:

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

ریکویسٹ + ریسپانس:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

ایونٹ:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## کم از کم کلائنٹ (Node.js)

سب سے چھوٹا مفید فلو: کنیکٹ + ہیلتھ۔

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

## عملی مثال: ایک میتھڈ اینڈ‑ٹو‑اینڈ شامل کریں

مثال: ایک نیا `system.echo` ریکویسٹ شامل کریں جو `{ ok: true, text }` واپس کرے۔

1. **اسکیمہ (واحد ماخذِ حقیقت)**

`src/gateway/protocol/schema.ts` میں شامل کریں:

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

دونوں کو `ProtocolSchemas` میں شامل کریں اور ٹائپس ایکسپورٹ کریں:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **ویلیڈیشن**

`src/gateway/protocol/index.ts` میں، ایک AJV ویلیڈیٹر ایکسپورٹ کریں:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **سرور رویّہ**

`src/gateway/server-methods/system.ts` میں ایک ہینڈلر شامل کریں:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

اسے `src/gateway/server-methods.ts` میں رجسٹر کریں (یہ پہلے ہی `systemHandlers` کو مرج کرتا ہے)،
پھر `"system.echo"` کو `METHODS` میں `src/gateway/server.ts` کے اندر شامل کریں۔

4. **دوبارہ جنریٹ کریں**

```bash
pnpm protocol:check
```

5. **ٹیسٹس + دستاویزات**

`src/gateway/server.*.test.ts` میں ایک سرور ٹیسٹ شامل کریں اور دستاویزات میں میتھڈ کا ذکر کریں۔

## Swift کوڈ جنریشن کا رویّہ

Swift جنریٹر درج ذیل خارج کرتا ہے:

- `GatewayFrame` enum جس میں `req`, `res`, `event`, اور `unknown` کیسز شامل ہیں
- مضبوط ٹائپڈ پےلوڈ اسٹرکٹس/اینمز
- `ErrorCode` ویلیوز اور `GATEWAY_PROTOCOL_VERSION`

نامعلوم فریم ٹائپس کو فارورڈ کمپیٹیبلٹی کے لیے را پےلوڈز کے طور پر محفوظ رکھا جاتا ہے۔

## ورژنینگ + مطابقت

- `PROTOCOL_VERSION` `src/gateway/protocol/schema.ts` میں موجود ہے۔
- کلائنٹس `minProtocol` + `maxProtocol` بھیجتے ہیں؛ سرور عدم مطابقت کو مسترد کر دیتا ہے۔
- Swift ماڈلز نامعلوم فریم ٹائپس کو برقرار رکھتے ہیں تاکہ پرانے کلائنٹس متاثر نہ ہوں۔

## اسکیمہ پیٹرنز اور کنونشنز

- زیادہ تر آبجیکٹس سخت پےلوڈز کے لیے `additionalProperties: false` استعمال کرتے ہیں۔
- IDs اور میتھڈ/ایونٹ ناموں کے لیے `NonEmptyString` بطورِ طے شدہ ہے۔
- ٹاپ‑لیول `GatewayFrame`، `type` پر **ڈسکریمنیٹر** استعمال کرتا ہے۔
- سائیڈ ایفیکٹس والے میتھڈز عموماً پیرامیٹرز میں `idempotencyKey` کا تقاضا کرتے ہیں
  (مثال: `send`, `poll`, `agent`, `chat.send`)۔

## لائیو اسکیمہ JSON

40. شائع شدہ
    raw فائل عموماً یہاں دستیاب ہوتی ہے: 41. رن فعال ہونے کے دوران ٹائپنگ انڈیکیٹرز چیٹ چینل پر بھیجے جاتے ہیں۔

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## جب آپ اسکیمائیں تبدیل کریں

1. TypeBox اسکیماؤں کو اپ ڈیٹ کریں۔
2. `pnpm protocol:check` چلائیں۔
3. دوبارہ جنریٹ شدہ اسکیمہ + Swift ماڈلز کمٹ کریں۔
