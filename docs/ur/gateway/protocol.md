---
summary: "Gateway WebSocket پروٹوکول: ہینڈشیک، فریمز، ورژننگ"
read_when:
  - Gateway WS کلائنٹس کو نافذ یا اپ ڈیٹ کرتے وقت
  - پروٹوکول عدم مطابقت یا کنکشن کی ناکامیوں کی ڈیبگنگ کے دوران
  - پروٹوکول اسکیما/ماڈلز کو دوبارہ تیار کرتے وقت
title: "Gateway پروٹوکول"
x-i18n:
  source_path: gateway/protocol.md
  source_hash: bdafac40d5356590
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:23Z
---

# Gateway پروٹوکول (WebSocket)

Gateway WS پروٹوکول OpenClaw کے لیے **واحد کنٹرول پلین + نوڈ ٹرانسپورٹ** ہے۔
تمام کلائنٹس (CLI، ویب UI، macOS ایپ، iOS/Android نوڈز، ہیڈلیس
نوڈز) WebSocket کے ذریعے کنیکٹ ہوتے ہیں اور ہینڈشیک کے وقت اپنا **role**

- **scope** ظاہر کرتے ہیں۔

## Transport

- WebSocket، JSON payloads کے ساتھ ٹیکسٹ فریمز۔
- پہلا فریم **لازم** ہے کہ `connect` درخواست ہو۔

## Handshake (connect)

Gateway → Client (پری کنیکٹ چیلنج):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway:

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

Gateway → Client:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

جب ڈیوائس ٹوکن جاری کیا جاتا ہے، تو `hello-ok` میں یہ بھی شامل ہوتا ہے:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node مثال

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

## Framing

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

سائیڈ ایفیکٹ رکھنے والے طریقوں کے لیے **idempotency keys** درکار ہیں (اسکیما دیکھیں)۔

## Roles + scopes

### Roles

- `operator` = کنٹرول پلین کلائنٹ (CLI/UI/automation)۔
- `node` = صلاحیت ہوسٹ (camera/screen/canvas/system.run)۔

### Scopes (operator)

عام اسکوپس:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

نوڈز کنیکٹ کے وقت صلاحیتی دعوے (capability claims) ظاہر کرتے ہیں:

- `caps`: اعلیٰ سطحی صلاحیتی زمروں۔
- `commands`: invoke کے لیے کمانڈ اجازت فہرست۔
- `permissions`: باریک کنٹرول ٹوگلز (مثلاً `screen.record`, `camera.capture`)۔

Gateway ان کو **claims** کے طور پر لیتا ہے اور سرور سائیڈ اجازت فہرستوں کو نافذ کرتا ہے۔

## Presence

- `system-presence` ڈیوائس شناخت کے مطابق کلید شدہ اندراجات واپس کرتا ہے۔
- Presence اندراجات میں `deviceId`, `roles`، اور `scopes` شامل ہوتے ہیں تاکہ UI ایک ہی ڈیوائس کے لیے ایک ہی قطار دکھا سکے
  چاہے وہ **operator** اور **node** دونوں کے طور پر کنیکٹ ہو۔

### Node معاون طریقے

- نوڈز خودکار اجازت چیک کے لیے موجودہ skill executables کی فہرست حاصل کرنے کو `skills.bins` کال کر سکتے ہیں۔

## Exec منظوریات

- جب کسی exec درخواست کو منظوری درکار ہو، گیٹ وے `exec.approval.requested` نشر کرتا ہے۔
- Operator کلائنٹس `exec.approval.resolve` کال کر کے حل کرتے ہیں (اس کے لیے `operator.approvals` scope درکار ہے)۔

## Versioning

- `PROTOCOL_VERSION`، `src/gateway/protocol/schema.ts` میں موجود ہوتا ہے۔
- کلائنٹس `minProtocol` + `maxProtocol` بھیجتے ہیں؛ سرور عدم مطابقت کو مسترد کر دیتا ہے۔
- اسکیماز + ماڈلز TypeBox تعریفات سے تیار کیے جاتے ہیں:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- اگر `OPENCLAW_GATEWAY_TOKEN` (یا `--token`) سیٹ ہو، تو `connect.params.auth.token`
  لازماً مطابقت رکھنا چاہیے ورنہ ساکٹ بند کر دیا جاتا ہے۔
- pairing کے بعد، Gateway کنکشن کے role + scopes کے مطابق ایک **device token** جاری کرتا ہے۔
  یہ `hello-ok.auth.deviceToken` میں واپس کیا جاتا ہے اور مستقبل کے کنکشنز کے لیے
  کلائنٹ کو اسے محفوظ کرنا چاہیے۔
- ڈیوائس ٹوکنز کو `device.token.rotate` اور
  `device.token.revoke` کے ذریعے گھمایا/منسوخ کیا جا سکتا ہے (اس کے لیے `operator.pairing` scope درکار ہے)۔

## Device identity + pairing

- نوڈز کو ایک مستحکم ڈیوائس شناخت (`device.id`) شامل کرنی چاہیے جو
  keypair fingerprint سے اخذ کی گئی ہو۔
- Gateways ہر ڈیوائس + role کے لیے ٹوکن جاری کرتے ہیں۔
- نئے ڈیوائس IDs کے لیے pairing منظوری درکار ہوتی ہے، الا یہ کہ مقامی خودکار منظوری فعال ہو۔
- **Local** کنکشنز میں loopback اور گیٹ وے ہوسٹ کا اپنا tailnet پتہ شامل ہوتا ہے
  (تاکہ ایک ہی ہوسٹ پر tailnet binds بھی خودکار منظوری حاصل کر سکیں)۔
- تمام WS کلائنٹس کو `connect` کے دوران `device` شناخت شامل کرنا **لازم** ہے (operator + node)۔
  Control UI اسے **صرف** اسی وقت چھوڑ سکتا ہے جب `gateway.controlUi.allowInsecureAuth` فعال ہو
  (یا بریک گلاس استعمال کے لیے `gateway.controlUi.dangerouslyDisableDeviceAuth`)۔
- غیر مقامی کنکشنز کو سرور کی جانب سے فراہم کردہ `connect.challenge` nonce پر دستخط کرنا ہوں گے۔

## TLS + pinning

- WS کنکشنز کے لیے TLS کی معاونت موجود ہے۔
- کلائنٹس اختیاری طور پر گیٹ وے سرٹیفکیٹ فنگرپرنٹ کو pin کر سکتے ہیں (دیکھیں `gateway.tls`
  کنفیگ کے ساتھ `gateway.remote.tlsFingerprint` یا CLI `--tls-fingerprint`)۔

## Scope

یہ پروٹوکول **مکمل گیٹ وے API** کو ظاہر کرتا ہے (status، channels، models، chat،
agent، sessions، nodes، approvals، وغیرہ)۔ درست سطح TypeBox اسکیماز میں
`src/gateway/protocol/schema.ts` کے اندر متعین ہے۔
