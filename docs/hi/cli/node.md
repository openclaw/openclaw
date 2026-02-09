---
summary: "`openclaw node` के लिए CLI संदर्भ (हेडलैस नोड होस्ट)"
read_when:
  - हेडलैस नोड होस्ट चलाते समय
  - system.run के लिए गैर‑macOS नोड को पेयर करते समय
title: "नोड"
---

# `openclaw node`

एक **हेडलैस नोड होस्ट** चलाएँ जो Gateway WebSocket से कनेक्ट होता है और
इस मशीन पर `system.run` / `system.which` उपलब्ध कराता है।

## नोड होस्ट का उपयोग क्यों करें?

जब आप अपने नेटवर्क में **अन्य मशीनों पर कमांड चलाना** चाहते हों, लेकिन वहाँ
पूरा macOS सहचर ऐप इंस्टॉल नहीं करना चाहते, तब नोड होस्ट का उपयोग करें।

सामान्य उपयोग परिदृश्य:

- दूरस्थ Linux/Windows बॉक्स (बिल्ड सर्वर, लैब मशीनें, NAS) पर कमांड चलाना।
- Gateway पर exec को **sandboxed** रखना, लेकिन स्वीकृत रन अन्य होस्ट्स को सौंपना।
- ऑटोमेशन या CI नोड्स के लिए हल्का, हेडलैस निष्पादन लक्ष्य प्रदान करना।

निष्पादन अभी भी **exec approvals** और नोड होस्ट पर प्रति‑एजेंट allowlists द्वारा
सुरक्षित रहता है, ताकि कमांड एक्सेस सीमित और स्पष्ट बना रहे।

## ब्राउज़र प्रॉक्सी (शून्य‑विन्यास)

Node hosts automatically advertise a browser proxy if `browser.enabled` is not
disabled on the node. This lets the agent use browser automation on that node
without extra configuration.

आवश्यक होने पर नोड पर इसे अक्षम करें:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## चलाएँ (फोरग्राउंड)

```bash
openclaw node run --host <gateway-host> --port 18789
```

विकल्प:

- `--host <host>`: Gateway WebSocket होस्ट (डिफ़ॉल्ट: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket पोर्ट (डिफ़ॉल्ट: `18789`)
- `--tls`: Gateway कनेक्शन के लिए TLS का उपयोग करें
- `--tls-fingerprint <sha256>`: अपेक्षित TLS प्रमाणपत्र फिंगरप्रिंट (sha256)
- `--node-id <id>`: नोड आईडी ओवरराइड करें (पेयरिंग टोकन साफ़ करता है)
- `--display-name <name>`: नोड का प्रदर्शन नाम ओवरराइड करें

## सेवा (पृष्ठभूमि)

एक हेडलैस नोड होस्ट को उपयोगकर्ता सेवा के रूप में इंस्टॉल करें।

```bash
openclaw node install --host <gateway-host> --port 18789
```

विकल्प:

- `--host <host>`: Gateway WebSocket होस्ट (डिफ़ॉल्ट: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket पोर्ट (डिफ़ॉल्ट: `18789`)
- `--tls`: Gateway कनेक्शन के लिए TLS का उपयोग करें
- `--tls-fingerprint <sha256>`: अपेक्षित TLS प्रमाणपत्र फिंगरप्रिंट (sha256)
- `--node-id <id>`: नोड आईडी ओवरराइड करें (पेयरिंग टोकन साफ़ करता है)
- `--display-name <name>`: नोड का प्रदर्शन नाम ओवरराइड करें
- `--runtime <runtime>`: सेवा रनटाइम (`node` या `bun`)
- `--force`: यदि पहले से इंस्टॉल है तो पुनः‑इंस्टॉल/ओवरराइट करें

सेवा का प्रबंधन करें:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

बिना सेवा के फोरग्राउंड नोड होस्ट के लिए `openclaw node run` का उपयोग करें।

सेवा कमांड मशीन‑पठनीय आउटपुट के लिए `--json` स्वीकार करते हैं।

## पेयरिंग

The first connection creates a pending node pair request on the Gateway.
Approve it via:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

नोड होस्ट अपना नोड आईडी, टोकन, प्रदर्शन नाम, और Gateway कनेक्शन जानकारी
`~/.openclaw/node.json` में संग्रहीत करता है।

## Exec अनुमोदन

`system.run` स्थानीय exec अनुमोदनों द्वारा नियंत्रित है:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (Gateway से संपादित करें)
