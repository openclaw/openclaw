---
summary: "Gateway WebSocket ပရိုတိုကောလ်៖ လက်ဆွဲချိတ်ဆက်ခြင်း၊ ဖရိမ်များ၊ ဗားရှင်းသတ်မှတ်မှု"
read_when:
  - Gateway WS ကလိုင်ယင့်များကို အကောင်အထည်ဖော်ခြင်း သို့မဟုတ် အပ်ဒိတ်လုပ်နေစဉ်
  - ပရိုတိုကောလ် မကိုက်ညီမှုများ သို့မဟုတ် ချိတ်ဆက်မှု မအောင်မြင်မှုများကို ဒီဘတ်လုပ်နေစဉ်
  - ပရိုတိုကောလ် စကီးမာ/မော်ဒယ်များကို ပြန်လည်ထုတ်လုပ်နေစဉ်
title: "Gateway ပရိုတိုကောလ်"
x-i18n:
  source_path: gateway/protocol.md
  source_hash: bdafac40d5356590
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:34Z
---

# Gateway ပရိုတိုကောလ် (WebSocket)

Gateway WS ပရိုတိုကောလ်သည် OpenClaw အတွက် **တစ်ခုတည်းသော control plane + node transport** ဖြစ်သည်။ ကလိုင်ယင့်အားလုံး (CLI, web UI, macOS app, iOS/Android nodes, headless nodes) သည် WebSocket မှတစ်ဆင့် ချိတ်ဆက်ပြီး handshake အချိန်တွင် မိမိတို့၏ **role** + **scope** ကို ကြေညာရသည်။

## Transport

- WebSocket၊ JSON payload ပါသော text frame များ။
- ပထမဆုံး frame သည် **မဖြစ်မနေ** `connect` request ဖြစ်ရမည်။

## Handshake (connect)

Gateway → Client (ချိတ်ဆက်မတိုင်မီ စိန်ခေါ်ချက်):

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

Device token ထုတ်ပေးသောအခါ `hello-ok` တွင် အောက်ပါတို့လည်း ပါဝင်သည် —

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node ဥပမာ

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

Side-effect ဖြစ်စေသော method များတွင် **idempotency keys** လိုအပ်သည် (schema ကိုကြည့်ပါ)။

## Roles + scopes

### Roles

- `operator` = control plane client (CLI/UI/automation)။
- `node` = capability host (camera/screen/canvas/system.run)။

### Scopes (operator)

အသုံးများသော scopes များ —

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

Node များသည် ချိတ်ဆက်ချိန်တွင် capability claim များကို ကြေညာရသည် —

- `caps`: အဆင့်မြင့် capability အမျိုးအစားများ။
- `commands`: invoke အတွက် command allowlist။
- `permissions`: အသေးစိတ် toggle များ (ဥပမာ `screen.record`, `camera.capture`)။

Gateway သည် ယင်းတို့ကို **claims** အဖြစ် သတ်မှတ်ပြီး server-side allowlist များဖြင့် အကောင်အထည်ဖော် ထိန်းချုပ်သည်။

## Presence

- `system-presence` သည် device identity ဖြင့် key လုပ်ထားသော entry များကို ပြန်ပေးသည်။
- Presence entry များတွင် `deviceId`, `roles`, နှင့် `scopes` ပါဝင်သဖြင့်
  **operator** နှင့် **node** နှစ်မျိုးလုံးအဖြစ် ချိတ်ဆက်ထားသည့်အခါတောင် UI များက device တစ်ခုလျှင် row တစ်ခုတည်းအဖြစ် ပြသနိုင်သည်။

### Node အကူအညီပေး method များ

- Node များသည် auto-allow စစ်ဆေးမှုများအတွက် လက်ရှိ skill executable စာရင်းကို ရယူရန် `skills.bins` ကို ခေါ်နိုင်သည်။

## Exec approvals

- Exec request တစ်ခုတွင် အတည်ပြုချက်လိုအပ်ပါက Gateway သည် `exec.approval.requested` ကို broadcast လုပ်သည်။
- Operator ကလိုင်ယင့်များသည် `exec.approval.resolve` ကို ခေါ်ခြင်းဖြင့် ဖြေရှင်းရပြီး (`operator.approvals` scope လိုအပ်သည်)။

## Versioning

- `PROTOCOL_VERSION` သည် `src/gateway/protocol/schema.ts` ထဲတွင် ရှိသည်။
- ကလိုင်ယင့်များသည် `minProtocol` + `maxProtocol` ကို ပို့ရပြီး server သည် မကိုက်ညီမှုများကို ပယ်ချသည်။
- Schema + model များကို TypeBox သတ်မှတ်ချက်များမှ ထုတ်လုပ်သည် —
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- `OPENCLAW_GATEWAY_TOKEN` (သို့မဟုတ် `--token`) ကို သတ်မှတ်ထားပါက `connect.params.auth.token`
  မကိုက်ညီလျှင် socket ကို ပိတ်သိမ်းမည်။
- Pairing ပြီးနောက် Gateway သည် connection role + scopes အလိုက် ခွဲထားသော **device token** ကို ထုတ်ပေးသည်။ ယင်းကို `hello-ok.auth.deviceToken` ထဲတွင် ပြန်ပေးပြီး
  နောင်တစ်ကြိမ် ချိတ်ဆက်ရာတွင် အသုံးပြုရန် ကလိုင်ယင့်က သိမ်းဆည်းထားသင့်သည်။
- Device token များကို `device.token.rotate` နှင့်
  `device.token.revoke` ဖြင့် လှည့်ပြောင်း/ရုပ်သိမ်းနိုင်သည် (`operator.pairing` scope လိုအပ်သည်)။

## Device identity + pairing

- Node များသည် keypair fingerprint မှ ဆင်းသက်လာသော တည်ငြိမ်သော device identity (`device.id`) ကို ထည့်သွင်းသင့်သည်။
- Gateway များသည် device + role အလိုက် token များကို ထုတ်ပေးသည်။
- Device ID အသစ်များအတွက် pairing အတည်ပြုချက် လိုအပ်ပြီး local auto-approval ကို ဖွင့်ထားပါက ချန်လှပ်နိုင်သည်။
- **Local** ချိတ်ဆက်မှုများတွင် loopback နှင့် gateway ဟို့စ်၏ ကိုယ်ပိုင် tailnet လိပ်စာ ပါဝင်သည်
  (ထို့ကြောင့် same‑host tailnet bind များကိုလည်း auto‑approve လုပ်နိုင်သည်)။
- WS ကလိုင်ယင့်အားလုံးသည် `connect` အတွင်း (`device` identity ကို) ထည့်သွင်းရမည် (operator + node)။
  Control UI သည် `gateway.controlUi.allowInsecureAuth` ကို ဖွင့်ထားသောအခါ **သာလျှင်**
  (သို့မဟုတ် break‑glass အသုံးအတွက် `gateway.controlUi.dangerouslyDisableDeviceAuth`) ယင်းကို ချန်လှပ်နိုင်သည်။
- Local မဟုတ်သော ချိတ်ဆက်မှုများသည် server မှ ပေးထားသော `connect.challenge` nonce ကို လက်မှတ်ရေးထိုးရမည်။

## TLS + pinning

- WS ချိတ်ဆက်မှုများအတွက် TLS ကို ပံ့ပိုးထားသည်။
- ကလိုင်ယင့်များသည် gateway cert fingerprint ကို ရွေးချယ်၍ pin လုပ်နိုင်သည် (`gateway.tls`
  config နှင့်အတူ `gateway.remote.tlsFingerprint` သို့မဟုတ် CLI `--tls-fingerprint` ကို ကြည့်ပါ)။

## Scope

ဤပရိုတိုကောလ်သည် **Gateway API အပြည့်အစုံ** (status, channels, models, chat,
agent, sessions, nodes, approvals စသည်တို့) ကို ဖော်ထုတ်ပေးသည်။ တိကျသော API မျက်နှာပြင်ကို
`src/gateway/protocol/schema.ts` ထဲရှိ TypeBox schema များဖြင့် သတ်မှတ်ထားသည်။
