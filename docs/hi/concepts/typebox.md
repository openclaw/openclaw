---
summary: "Gateway प्रोटोकॉल के लिए एकमात्र सत्य स्रोत के रूप में TypeBox स्कीमा"
read_when:
  - प्रोटोकॉल स्कीमा या कोडजन अपडेट करते समय
title: "TypeBox"
---

# प्रोटोकॉल के सत्य स्रोत के रूप में TypeBox

अंतिम अपडेट: 2026-01-10

TypeBox एक TypeScript-फर्स्ट स्कीमा लाइब्रेरी है। हम इसका उपयोग **Gateway WebSocket प्रोटोकॉल** (handshake, request/response, server events) को परिभाषित करने के लिए करते हैं। ये स्कीमाज़ **रनटाइम वैलिडेशन**, **JSON Schema export**, और macOS ऐप के लिए **Swift codegen** को ड्राइव करती हैं। एक ही source of truth; बाकी सब कुछ जनरेट किया जाता है।

यदि आपको उच्च‑स्तरीय प्रोटोकॉल संदर्भ चाहिए, तो
[Gateway architecture](/concepts/architecture) से शुरू करें।

## मानसिक मॉडल (30 सेकंड)

हर Gateway WS संदेश तीन में से एक फ्रेम होता है:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion?
  }` पहला फ़्रेम **ज़रूर** एक `connect` रिक्वेस्ट होना चाहिए।

इसके बाद, क्लाइंट्स मेथड्स (जैसे `health`, `send`, `chat.send`) कॉल कर सकते हैं और इवेंट्स (जैसे `presence`, `tick`, `agent`) को सब्सक्राइब कर सकते हैं। **सर्वर साइड**: हर इनबाउंड फ़्रेम को AJV से वैलिडेट किया जाता है।

कनेक्शन फ्लो (न्यूनतम):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

सामान्य मेथड्स + इवेंट्स:

| Category  | Examples                                                  | Notes                                        |
| --------- | --------------------------------------------------------- | -------------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` सबसे पहले होना चाहिए               |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | साइड‑इफेक्ट्स के लिए `idempotencyKey` आवश्यक |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat इन्हीं का उपयोग करता है              |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | सत्र प्रशासन                                 |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + नोड क्रियाएँ                    |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | सर्वर पुश                                    |

अधिकारिक सूची `src/gateway/server.ts` में रहती है (`METHODS`, `EVENTS`)।

## स्कीमा कहाँ रहते हैं

- Source: `src/gateway/protocol/schema.ts`
- Runtime validators (AJV): `src/gateway/protocol/index.ts`
- Server handshake + method dispatch: `src/gateway/server.ts`
- Node client: `src/gateway/client.ts`
- Generated JSON Schema: `dist/protocol.schema.json`
- Generated Swift models: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## वर्तमान पाइपलाइन

- `pnpm protocol:gen`
  - JSON Schema (draft‑07) को `dist/protocol.schema.json` में लिखता है
- `pnpm protocol:gen:swift`
  - Swift gateway मॉडल्स जनरेट करता है
- `pnpm protocol:check`
  - दोनों जनरेटर चलाता है और सत्यापित करता है कि आउटपुट कमिट किया गया है

## रनटाइम पर स्कीमा का उपयोग कैसे होता है

- हैंडशेक केवल उसी `connect` रिक्वेस्ट को स्वीकार करता है जिसके params `ConnectParams` से मेल खाते हों। जनरेट किया गया JSON Schema repo में `dist/protocol.schema.json` पर मौजूद है।
- **Client side**: JS क्लाइंट इवेंट और प्रतिक्रिया फ्रेम्स का उपयोग करने से पहले
  उन्हें वैलिडेट करता है।
- **Method surface**: Gateway समर्थित `methods` और
  `events` को `hello-ok` में विज्ञापित करता है।

## उदाहरण फ्रेम्स

Connect (पहला संदेश):

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

Hello-ok प्रतिक्रिया:

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

## न्यूनतम क्लाइंट (Node.js)

सबसे छोटा उपयोगी फ्लो: connect + health।

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

## वर्क्ड उदाहरण: एक मेथड को एंड‑टू‑एंड जोड़ना

उदाहरण: एक नया `system.echo` अनुरोध जोड़ें जो `{ ok: true, text }` लौटाता है।

1. **Schema (सत्य का स्रोत)**

`src/gateway/protocol/schema.ts` में जोड़ें:

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

दोनों को `ProtocolSchemas` में जोड़ें और टाइप्स एक्सपोर्ट करें:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validation**

`src/gateway/protocol/index.ts` में, एक AJV वैलिडेटर एक्सपोर्ट करें:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Server behavior**

`src/gateway/server-methods/system.ts` में एक हैंडलर जोड़ें:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

इसे `src/gateway/server-methods.ts` में रजिस्टर करें (जो पहले से `systemHandlers` को मर्ज करता है),
फिर `"system.echo"` को `METHODS` में `src/gateway/server.ts` के भीतर जोड़ें।

4. **Regenerate**

```bash
pnpm protocol:check
```

5. **Tests + docs**

`src/gateway/server.*.test.ts` में एक सर्वर टेस्ट जोड़ें और दस्तावेज़ों में मेथड का उल्लेख करें।

## Swift कोडजन व्यवहार

Swift जनरेटर निम्नलिखित उत्सर्जित करता है:

- `GatewayFrame` enum, जिसमें `req`, `res`, `event`, और `unknown` केस होते हैं
- मज़बूती से टाइप किए गए payload structs/enums
- `ErrorCode` मान और `GATEWAY_PROTOCOL_VERSION`

अज्ञात फ्रेम प्रकारों को forward compatibility के लिए raw payloads के रूप में संरक्षित रखा जाता है।

## संस्करण निर्धारण + संगतता

- `PROTOCOL_VERSION` `src/gateway/protocol/schema.ts` में रहता है।
- क्लाइंट `minProtocol` + `maxProtocol` भेजते हैं; सर्वर असंगतियों को अस्वीकार करता है।
- Swift मॉडल्स पुराने क्लाइंट्स को न तोड़ने के लिए अज्ञात फ्रेम प्रकारों को बनाए रखते हैं।

## स्कीमा पैटर्न और परंपराएँ

- अधिकांश ऑब्जेक्ट्स सख्त payloads के लिए `additionalProperties: false` का उपयोग करते हैं।
- IDs और method/event नामों के लिए `NonEmptyString` डिफ़ॉल्ट है।
- टॉप‑लेवल `GatewayFrame` `type` पर **discriminator** का उपयोग करता है।
- साइड‑इफेक्ट्स वाले मेथड्स आमतौर पर params में `idempotencyKey` की आवश्यकता रखते हैं
  (उदाहरण: `send`, `poll`, `agent`, `chat.send`)।

## लाइव स्कीमा JSON

प्रकाशित रॉ फ़ाइल आमतौर पर यहाँ उपलब्ध होती है: जब कोई रन सक्रिय होता है, तो टाइपिंग इंडिकेटर्स चैट चैनल पर भेजे जाते हैं।

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## जब आप स्कीमा बदलते हैं

1. TypeBox स्कीमा अपडेट करें।
2. `pnpm protocol:check` चलाएँ।
3. पुनः जनरेट किए गए स्कीमा + Swift मॉडल्स को कमिट करें।
