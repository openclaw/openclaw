---
summary: "Gateway WebSocket پروٹوکول: ہینڈشیک، فریمز، ورژننگ"
read_when:
  - Gateway WS کلائنٹس کو نافذ یا اپ ڈیٹ کرتے وقت
  - پروٹوکول عدم مطابقت یا کنکشن کی ناکامیوں کی ڈیبگنگ کے دوران
  - پروٹوکول اسکیما/ماڈلز کو دوبارہ تیار کرتے وقت
title: "Gateway پروٹوکول"
---

# Gateway پروٹوکول (WebSocket)

The Gateway WS protocol is the **single control plane + node transport** for
OpenClaw. All clients (CLI, web UI, macOS app, iOS/Android nodes, headless
nodes) connect over WebSocket and declare their **role** + **scope** at
handshake time.

## Transport

- WebSocket, text frames with JSON payloads.
- First frame **must** be a `connect` request.

## Handshake (connect)

Gateway → Client (pre-connect challenge):

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

When a device token is issued, `hello-ok` also includes:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node example

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

Side-effecting methods require **idempotency keys** (see schema).

## Roles + scopes

### Roles

- `operator` = control plane client (CLI/UI/automation).
- `node` = capability host (camera/screen/canvas/system.run).

### Scopes (operator)

Common scopes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

Nodes declare capability claims at connect time:

- `caps`: high-level capability categories.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The Gateway treats these as **claims** and enforces server-side allowlists.

## Presence

- `system-presence` returns entries keyed by device identity.
- 1. Presence entries میں `deviceId`, `roles` اور `scopes` شامل ہوتے ہیں تاکہ UIs ہر ڈیوائس کے لیے ایک ہی قطار دکھا سکیں
     چاہے وہ بیک وقت **operator** اور **node** کے طور پر کنیکٹ ہو۔

### 2. Node helper methods

- 3. Nodes خودکار اجازت (auto-allow) کی جانچ کے لیے موجودہ skill executables کی فہرست حاصل کرنے کے لیے `skills.bins` کو کال کر سکتے ہیں۔

## ایگزیک منظوریات

- 4. جب کسی exec درخواست کو منظوری درکار ہو، تو گیٹ وے `exec.approval.requested` براڈکاسٹ کرتا ہے۔
- 5. Operator کلائنٹس `exec.approval.resolve` کال کر کے حل کرتے ہیں (اس کے لیے `operator.approvals` اسکوپ درکار ہے)۔

## Versioning

- `PROTOCOL_VERSION` `src/gateway/protocol/schema.ts` میں موجود ہے۔
- کلائنٹس `minProtocol` + `maxProtocol` بھیجتے ہیں؛ سرور عدم مطابقت کو مسترد کر دیتا ہے۔
- 6. Schemas + models، TypeBox definitions سے جنریٹ کیے جاتے ہیں:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- 7. اگر `OPENCLAW_GATEWAY_TOKEN` (یا `--token`) سیٹ ہو، تو `connect.params.auth.token`
     کا میچ ہونا لازمی ہے ورنہ ساکٹ بند کر دی جاتی ہے۔
- 8. pairing کے بعد، گیٹ وے کنکشن کے رول + اسکوپس تک محدود ایک **device token** جاری کرتا ہے۔ 9. یہ `hello-ok.auth.deviceToken` میں واپس کیا جاتا ہے اور آئندہ کنیکشنز کے لیے
     کلائنٹ کو اسے محفوظ کرنا چاہیے۔
- 10. Device tokens کو `device.token.rotate` اور
      `device.token.revoke` کے ذریعے روٹیٹ/ریووٖک کیا جا سکتا ہے (اس کے لیے `operator.pairing` اسکوپ درکار ہے)۔

## Device identity + pairing

- 11. Nodes کو ایک مستحکم ڈیوائس شناخت (`device.id`) شامل کرنی چاہیے جو
      keypair fingerprint سے اخذ کی گئی ہو۔
- 12. Gateways ہر ڈیوائس + رول کے لیے ٹوکن جاری کرتے ہیں۔
- Pairing approvals are required for new device IDs unless local auto-approval
  is enabled.
- 14. **Local** کنیکشنز میں loopback اور گیٹ وے ہوسٹ کا اپنا tailnet ایڈریس شامل ہوتا ہے
      (تاکہ اسی ہوسٹ کے tailnet binds بھی auto-approve ہو سکیں)۔
- 15. تمام WS کلائنٹس کو `connect` کے دوران `device` شناخت شامل کرنی لازمی ہے (operator + node)۔
  16. Control UI اسے **صرف** اسی صورت میں چھوڑ سکتی ہے جب `gateway.controlUi.allowInsecureAuth` فعال ہو
      (یا ہنگامی استعمال کے لیے `gateway.controlUi.dangerouslyDisableDeviceAuth`)۔
- Non-local connections must sign the server-provided `connect.challenge` nonce.

## TLS + pinning

- 18. WS کنیکشنز کے لیے TLS سپورٹ موجود ہے۔
- 19. کلائنٹس اختیاری طور پر گیٹ وے سرٹیفکیٹ فنگرپرنٹ پن کر سکتے ہیں (دیکھیے `gateway.tls`
      کنفیگ کے ساتھ `gateway.remote.tlsFingerprint` یا CLI `--tls-fingerprint`)۔

## Scope

20. یہ پروٹوکول **مکمل گیٹ وے API** کو ایکسپوز کرتا ہے (status, channels, models, chat,
    agent, sessions, nodes, approvals، وغیرہ)۔ The exact surface is defined by the
    TypeBox schemas in `src/gateway/protocol/schema.ts`.
