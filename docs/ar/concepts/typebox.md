---
summary: "مخططات TypeBox بوصفها المصدر الوحيد للحقيقة لبروتوكول Gateway"
read_when:
  - تحديث مخططات البروتوكول أو توليد الشيفرة
title: "TypeBox"
---

# TypeBox كمصدر الحقيقة للبروتوكول

آخر تحديث: 2026-01-10

TypeBox هي مكتبة مخططات تعتمد TypeScript أولًا. نستخدمها لتعريف **بروتوكول Gateway عبر WebSocket** (المصافحة، الطلب/الاستجابة، أحداث الخادم). تقود هذه المخططات **التحقق أثناء التشغيل** و**تصدير JSON Schema** و**توليد شيفرة Swift** لتطبيق macOS. مصدر واحد للحقيقة؛ وكل ما عداه يتم توليده.

إذا كنت تريد السياق الأعلى مستوى للبروتوكول، فابدأ بـ
[بنية Gateway](/concepts/architecture).

## النموذج الذهني (30 ثانية)

كل رسالة WS في Gateway هي أحد ثلاثة إطارات:

- **طلب**: `{ type: "req", id, method, params }`
- **استجابة**: `{ type: "res", id, ok, payload | error }`
- **حدث**: `{ type: "event", event, payload, seq?, stateVersion? }`

الإطار الأول **يجب** أن يكون طلب `connect`. بعد ذلك، يمكن للعملاء استدعاء
الأساليب (مثل `health` و`send` و`chat.send`) والاشتراك في الأحداث (مثل
`presence` و`tick` و`agent`).

تدفّق الاتصال (الحد الأدنى):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

الأساليب والأحداث الشائعة:

| الفئة    | أمثلة                                                     | ملاحظات                                |
| -------- | --------------------------------------------------------- | -------------------------------------- |
| الأساسية | `connect`، `health`، `status`                             | يجب أن يكون `connect` أولًا            |
| المراسلة | `send`، `poll`، `agent`، `agent.wait`                     | الآثار الجانبية تتطلب `idempotencyKey` |
| الدردشة  | `chat.history`، `chat.send`، `chat.abort`، `chat.inject`  | يستخدم WebChat هذه                     |
| الجلسات  | `sessions.list`، `sessions.patch`، `sessions.delete`      | إدارة الجلسات                          |
| Nodes    | `node.list`، `node.invoke`، `node.pair.*`                 | Gateway WS + إجراءات العُقد            |
| الأحداث  | `tick`، `presence`، `agent`، `chat`، `health`، `shutdown` | دفع من الخادم                          |

القائمة المعتمدة تعيش في `src/gateway/server.ts` (`METHODS`، `EVENTS`).

## أين تعيش المخططات

- المصدر: `src/gateway/protocol/schema.ts`
- مُحقِّقات وقت التشغيل (AJV): `src/gateway/protocol/index.ts`
- مصافحة الخادم + توزيع الأساليب: `src/gateway/server.ts`
- عميل العُقدة: `src/gateway/client.ts`
- JSON Schema المُولَّد: `dist/protocol.schema.json`
- نماذج Swift المُولَّدة: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## خط الأنابيب الحالي

- `pnpm protocol:gen`
  - يكتب JSON Schema (draft‑07) إلى `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - يُولِّد نماذج Swift لـ Gateway
- `pnpm protocol:check`
  - يُشغِّل كلا المُولِّدَين ويتحقق من التزام إخراجاتهما

## كيف تُستخدم المخططات أثناء التشغيل

- **جانب الخادم**: يتم التحقق من كل إطار وارد باستخدام AJV. المصافحة لا تقبل إلا طلب
  `connect` تكون معلماته مطابقة لـ `ConnectParams`.
- **جانب العميل**: يتحقق عميل JS من أطر الأحداث والاستجابات قبل استخدامها.
- **سطح الأساليب**: يعلن Gateway عن `methods` و`events` المدعومة في `hello-ok`.

## أمثلة على الإطارات

الاتصال (الرسالة الأولى):

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

استجابة hello-ok:

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

طلب + استجابة:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

حدث:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## عميل حدّ أدنى (Node.js)

أصغر تدفّق مفيد: اتصال + صحة.

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

## مثال عملي: إضافة أسلوب من الطرف إلى الطرف

مثال: إضافة طلب جديد `system.echo` يُعيد `{ ok: true, text }`.

1. **المخطط (مصدر الحقيقة)**

أضِف إلى `src/gateway/protocol/schema.ts`:

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

أضِف كليهما إلى `ProtocolSchemas` وصدِّر الأنواع:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **التحقق**

في `src/gateway/protocol/index.ts`، صدِّر مُحقِّق AJV:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **سلوك الخادم**

أضِف معالجًا في `src/gateway/server-methods/system.ts`:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

سجِّله في `src/gateway/server-methods.ts` (الذي يدمج بالفعل `systemHandlers`)،
ثم أضِف `"system.echo"` إلى `METHODS` في `src/gateway/server.ts`.

4. **إعادة التوليد**

```bash
pnpm protocol:check
```

5. **الاختبارات + التوثيق**

أضِف اختبار خادم في `src/gateway/server.*.test.ts` واذكر الأسلوب في الوثائق.

## سلوك توليد شيفرة Swift

يُصدِر مولِّد Swift:

- تعداد `GatewayFrame` مع حالات `req` و`res` و`event` و`unknown`
- هياكل/تعدادات حمولة مُحكَمة الأنواع
- قيم `ErrorCode` و`GATEWAY_PROTOCOL_VERSION`

تُحفَظ أنواع الإطارات غير المعروفة كحِمولات خام لضمان التوافق المستقبلي.

## الإصدارات + التوافق

- يعيش `PROTOCOL_VERSION` في `src/gateway/protocol/schema.ts`.
- يرسل العملاء `minProtocol` + `maxProtocol`؛ ويرفض الخادم حالات عدم التطابق.
- تحتفظ نماذج Swift بأنواع الإطارات غير المعروفة لتجنّب كسر العملاء الأقدم.

## أنماط واتفاقيات المخطط

- تستخدم معظم الكائنات `additionalProperties: false` للحِمولات الصارمة.
- `NonEmptyString` هو الافتراضي للمعرّفات وأسماء الأساليب/الأحداث.
- يستخدم `GatewayFrame` على المستوى الأعلى **مميِّزًا** على `type`.
- غالبًا ما تتطلب الأساليب ذات الآثار الجانبية `idempotencyKey` ضمن المعلمات
  (مثال: `send` و`poll` و`agent` و`chat.send`).

## JSON للمخطط الحي

يتوفر JSON Schema المُولَّد في المستودع عند `dist/protocol.schema.json`. عادةً ما يكون
الملف الخام المنشور متاحًا على:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## عند تغيير المخططات

1. حدِّث مخططات TypeBox.
2. شغِّل `pnpm protocol:check`.
3. التزم بالمخطط المُعاد توليده ونماذج Swift.
