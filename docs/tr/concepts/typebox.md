---
summary: "Gateway protokolü için tek doğruluk kaynağı olarak TypeBox şemaları"
read_when:
  - Protokol şemaları veya codegen güncellenirken
title: "TypeBox"
---

# Protokol için doğruluk kaynağı olarak TypeBox

Son güncelleme: 2026-01-10

TypeBox, TypeScript öncelikli bir şema kütüphanesidir. Bunu **Gateway
WebSocket protokolünü** (el sıkışma, istek/yanıt, sunucu olayları) tanımlamak için kullanıyoruz. Bu şemalar **çalışma zamanı doğrulamasını**, **JSON Schema dışa aktarımını** ve macOS uygulaması için **Swift codegen**’i yönlendirir. Tek bir doğruluk kaynağı vardır; diğer her şey buradan üretilir.

Daha üst düzey protokol bağlamı için
[Gateway architecture](/concepts/architecture) ile başlayın.

## Zihinsel model (30 saniye)

Her Gateway WS mesajı üç çerçeveden (frame) biridir:

- **Request**: `{ type: "req", id, method, params }`
- **Response**: `{ type: "res", id, ok, payload | error }`
- **Event**: `{ type: "event", event, payload, seq?, stateVersion? }`

İlk çerçeve **mutlaka** bir `connect` isteği olmalıdır. Bundan sonra istemciler
metotları çağırabilir (örn. `health`, `send`, `chat.send`) ve olaylara abone olabilir (örn.
`presence`, `tick`, `agent`).

Bağlantı akışı (asgari):

```
Client                    Gateway
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Yaygın metotlar + olaylar:

| Category  | Examples                                                  | Notes                                     |
| --------- | --------------------------------------------------------- | ----------------------------------------- |
| Core      | `connect`, `health`, `status`                             | `connect` ilk olmalıdır                   |
| Messaging | `send`, `poll`, `agent`, `agent.wait`                     | yan etkiler için `idempotencyKey` gerekir |
| Chat      | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat bunları kullanır                  |
| Sessions  | `sessions.list`, `sessions.patch`, `sessions.delete`      | oturum yönetimi                           |
| Nodes     | `node.list`, `node.invoke`, `node.pair.*`                 | Gateway WS + düğüm eylemleri              |
| Events    | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | sunucu itmesi                             |

Yetkili liste `src/gateway/server.ts`’te bulunur (`METHODS`, `EVENTS`).

## Where the schemas live

- Kaynak: `src/gateway/protocol/schema.ts`
- Çalışma zamanı doğrulayıcıları (AJV): `src/gateway/protocol/index.ts`
- Sunucu el sıkışması + metot yönlendirme: `src/gateway/server.ts`
- Node istemcisi: `src/gateway/client.ts`
- Üretilmiş JSON Schema: `dist/protocol.schema.json`
- Üretilmiş Swift modelleri: `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Mevcut boru hattı

- `pnpm protocol:gen`
  - JSON Schema’yı (draft‑07) `dist/protocol.schema.json`’e yazar
- `pnpm protocol:gen:swift`
  - Swift gateway modellerini üretir
- `pnpm protocol:check`
  - her iki üreticiyi de çalıştırır ve çıktının commit edildiğini doğrular

## How the schemas are used at runtime

- **Sunucu tarafı**: gelen her çerçeve AJV ile doğrulanır. El sıkışma yalnızca
  parametreleri `ConnectParams` ile eşleşen bir `connect` isteğini kabul eder.
- **İstemci tarafı**: JS istemcisi, olay ve yanıt çerçevelerini kullanmadan önce doğrular.
- **Metot yüzeyi**: Gateway, desteklenen `methods` ve
  `events`’ü `hello-ok` içinde ilan eder.

## Örnek çerçeveler

Bağlan (ilk mesaj):

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

Hello-ok yanıtı:

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

İstek + yanıt:

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Olay:

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Minimal istemci (Node.js)

En küçük kullanışlı akış: bağlan + health.

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

## Worked example: add a method end‑to‑end

Örnek: `{ ok: true, text }` döndüren yeni bir `system.echo` isteği ekleyin.

1. **Şema (doğruluk kaynağı)**

`src/gateway/protocol/schema.ts`’e ekleyin:

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

Her ikisini de `ProtocolSchemas`’e ekleyin ve türleri dışa aktarın:

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Doğrulama**

`src/gateway/protocol/index.ts` içinde bir AJV doğrulayıcısı dışa aktarın:

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Sunucu davranışı**

`src/gateway/server-methods/system.ts`’e bir handler ekleyin:

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Bunu `src/gateway/server-methods.ts`’de kaydedin (`systemHandlers`’ü zaten birleştirir),
ardından `src/gateway/server.ts` içindeki `METHODS`’e `"system.echo"` ekleyin.

4. **Yeniden üret**

```bash
pnpm protocol:check
```

5. **Testler + dokümanlar**

`src/gateway/server.*.test.ts` içinde bir sunucu testi ekleyin ve metodu dokümanlarda belirtin.

## Swift codegen davranışı

Swift üreticisi şunları üretir:

- `req`, `res`, `event` ve `unknown` durumlarını içeren bir `GatewayFrame` enum’u
- Güçlü tiplenmiş payload struct/enum’ları
- `ErrorCode` değerleri ve `GATEWAY_PROTOCOL_VERSION`

Bilinmeyen çerçeve türleri, ileriye dönük uyumluluk için ham payload’lar olarak korunur.

## Sürümleme + uyumluluk

- `PROTOCOL_VERSION`, `src/gateway/protocol/schema.ts` içinde bulunur.
- İstemciler `minProtocol` + `maxProtocol` gönderir; sunucu uyumsuzlukları reddeder.
- Swift modelleri, eski istemcilerin bozulmasını önlemek için bilinmeyen çerçeve türlerini saklar.

## Schema patterns and conventions

- Çoğu nesne, katı payload’lar için `additionalProperties: false` kullanır.
- Kimlikler ve metot/olay adları için varsayılan `NonEmptyString`’dır.
- En üst düzey `GatewayFrame`, `type` üzerinde bir **discriminator** kullanır.
- Yan etkili metotlar genellikle parametrelerde bir `idempotencyKey` gerektirir
  (örnek: `send`, `poll`, `agent`, `chat.send`).

## Canlı şema JSON’u

Üretilmiş JSON Schema, repoda `dist/protocol.schema.json` yolunda bulunur. Yayımlanan ham dosya genellikle şurada mevcuttur:

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## When you change schemas

1. TypeBox şemalarını güncelleyin.
2. `pnpm protocol:check` çalıştırın.
3. Yeniden üretilmiş şemayı + Swift modellerini commit edin.
