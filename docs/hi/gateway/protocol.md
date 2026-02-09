---
summary: "Gateway वेब-सॉकेट प्रोटोकॉल: हैंडशेक, फ्रेम, संस्करण निर्धारण"
read_when:
  - Gateway WS क्लाइंट्स को लागू या अपडेट करते समय
  - प्रोटोकॉल असंगतियों या कनेक्ट विफलताओं का डिबग करते समय
  - प्रोटोकॉल स्कीमा/मॉडल्स को पुनः जनरेट करते समय
title: "Gateway प्रोटोकॉल"
---

# Gateway प्रोटोकॉल (WebSocket)

Gateway WS प्रोटोकॉल OpenClaw के लिए **एकमात्र control plane + node transport** है। सभी क्लाइंट (CLI, web UI, macOS ऐप, iOS/Android nodes, headless
nodes) WebSocket के माध्यम से कनेक्ट होते हैं और handshake समय पर अपना **role** + **scope** घोषित करते हैं।

## Transport

- WebSocket, JSON पेलोड्स के साथ टेक्स्ट फ्रेम्स।
- पहला फ्रेम **अनिवार्य रूप से** `connect` अनुरोध होना चाहिए।

## Handshake (connect)

Gateway → Client (प्री-कनेक्ट चुनौती):

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

जब कोई डिवाइस टोकन जारी किया जाता है, तो `hello-ok` में यह भी शामिल होता है:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Node उदाहरण

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

साइड-इफ़ेक्ट वाले मेथड्स के लिए **idempotency keys** आवश्यक हैं (स्कीमा देखें)।

## Roles + scopes

### Roles

- `operator` = कंट्रोल प्लेन क्लाइंट (CLI/UI/ऑटोमेशन)।
- `node` = क्षमता होस्ट (camera/screen/canvas/system.run)।

### Scopes (operator)

सामान्य स्कोप्स:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commands/permissions (node)

नोड्स कनेक्ट समय पर क्षमता दावे (capability claims) घोषित करते हैं:

- `caps`: उच्च-स्तरीय क्षमता श्रेणियाँ।
- `commands`: invoke के लिए कमांड allowlist।
- `permissions`: सूक्ष्म टॉगल्स (जैसे `screen.record`, `camera.capture`)।

Gateway इन्हें **claims** के रूप में मानता है और सर्वर-साइड allowlists लागू करता है।

## Presence

- `system-presence` डिवाइस पहचान द्वारा कुंजीबद्ध प्रविष्टियाँ लौटाता है।
- Presence प्रविष्टियों में `deviceId`, `roles`, और `scopes` शामिल होते हैं ताकि UI प्रति डिवाइस एक ही पंक्ति दिखा सकें,
  भले ही वह **operator** और **node** दोनों के रूप में कनेक्ट हो।

### Node सहायक मेथड्स

- नोड्स `skills.bins` को कॉल कर सकते हैं ताकि auto-allow जाँचों के लिए
  वर्तमान skill executables की सूची प्राप्त की जा सके।

## Exec अनुमोदन

- जब किसी exec अनुरोध को अनुमोदन की आवश्यकता होती है, तो Gateway `exec.approval.requested` प्रसारित करता है।
- Operator क्लाइंट्स `exec.approval.resolve` को कॉल करके समाधान करते हैं (इसके लिए `operator.approvals` स्कोप आवश्यक है)।

## Versioning

- `PROTOCOL_VERSION` `src/gateway/protocol/schema.ts` में स्थित है।
- क्लाइंट्स `minProtocol` + `maxProtocol` भेजते हैं; सर्वर असंगतियों को अस्वीकार करता है।
- स्कीमा + मॉडल TypeBox परिभाषाओं से जनरेट किए जाते हैं:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- यदि `OPENCLAW_GATEWAY_TOKEN` (या `--token`) सेट है, तो `connect.params.auth.token`
  मेल खाना चाहिए; अन्यथा सॉकेट बंद कर दिया जाता है।
- pairing के बाद, Gateway कनेक्शन के role + scopes तक सीमित एक **device token** जारी करता है। यह `hello-ok.auth.deviceToken` में लौटाया जाता है और भविष्य के कनेक्शनों के लिए
  क्लाइंट द्वारा सहेजा जाना चाहिए।
- डिवाइस टोकन `device.token.rotate` और `device.token.revoke` के माध्यम से रोटेट/रिवोक किए जा सकते हैं
  (इसके लिए `operator.pairing` स्कोप आवश्यक है)।

## Device identity + pairing

- नोड्स को एक स्थिर डिवाइस पहचान (`device.id`) शामिल करनी चाहिए, जो
  keypair फ़िंगरप्रिंट से व्युत्पन्न हो।
- Gateway प्रति डिवाइस + role टोकन जारी करता है।
- नए डिवाइस IDs के लिए पेयरिंग अनुमोदन आवश्यक हैं, जब तक कि स्थानीय auto-approval सक्षम न हो।
- **Local** कनेक्शनों में loopback और Gateway होस्ट का अपना tailnet पता शामिल होता है
  (ताकि same‑host tailnet binds भी auto‑approve हो सकें)।
- सभी WS क्लाइंट्स को `connect` के दौरान `device` पहचान शामिल करनी चाहिए (operator + node)।
  Control UI इसे **केवल** तब छोड़ सकता है जब `gateway.controlUi.allowInsecureAuth` सक्षम हो
  (या ब्रेक-ग्लास उपयोग के लिए `gateway.controlUi.dangerouslyDisableDeviceAuth`)।
- गैर-स्थानीय कनेक्शनों को सर्वर द्वारा प्रदान किए गए `connect.challenge` nonce पर हस्ताक्षर करना होगा।

## TLS + pinning

- WS कनेक्शनों के लिए TLS समर्थित है।
- क्लाइंट्स वैकल्पिक रूप से Gateway प्रमाणपत्र फ़िंगरप्रिंट को पिन कर सकते हैं
  (देखें `gateway.tls` विन्यास तथा `gateway.remote.tlsFingerprint` या CLI `--tls-fingerprint`)।

## Scope

यह प्रोटोकॉल **पूरा गेटवे API** (status, channels, models, chat,
agent, sessions, nodes, approvals, आदि) को एक्सपोज़ करता है। सटीक सतह `src/gateway/protocol/schema.ts` में TypeBox schemas द्वारा परिभाषित है।
