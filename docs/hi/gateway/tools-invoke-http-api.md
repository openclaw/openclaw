---
summary: "Gateway HTTP एंडपॉइंट के माध्यम से सीधे एकल टूल को इनवोक करें"
read_when:
  - पूर्ण एजेंट टर्न चलाए बिना टूल कॉल करना
  - टूल नीति प्रवर्तन की आवश्यकता वाली ऑटोमेशन बनाना
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled, but gated by Gateway auth and tool policy.

- `POST /tools/invoke`
- Gateway के समान पोर्ट (WS + HTTP मल्टीप्लेक्स): `http://<gateway-host>:<port>/tools/invoke`

डिफ़ॉल्ट अधिकतम पेलोड आकार 2 MB है।

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

टिप्पणियाँ:

- जब `gateway.auth.mode="token"`, तब `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) का उपयोग करें।
- जब `gateway.auth.mode="password"`, तब `gateway.auth.password` (या `OPENCLAW_GATEWAY_PASSWORD`) का उपयोग करें।

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

फ़ील्ड्स:

- `tool` (string, आवश्यक): इनवोक किए जाने वाले टूल का नाम।
- `action` (string, वैकल्पिक): यदि टूल स्कीमा `action` का समर्थन करता है और args पेलोड में इसे छोड़ा गया है, तो इसे args में मैप किया जाता है।
- `args` (object, वैकल्पिक): टूल-विशिष्ट आर्ग्युमेंट्स।
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and default agent, or `global` in global scope).
- `dryRun` (boolean, वैकल्पिक): भविष्य के उपयोग के लिए आरक्षित; वर्तमान में अनदेखा किया जाता है।

## Policy + routing behavior

टूल की उपलब्धता Gateway एजेंट्स द्वारा उपयोग की जाने वाली उसी नीति शृंखला के माध्यम से फ़िल्टर की जाती है:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- समूह नीतियाँ (यदि सत्र कुंजी किसी समूह या चैनल से मैप होती है)
- उप-एजेंट नीति (जब उप-एजेंट सत्र कुंजी के साथ इनवोक किया जाता है)

यदि किसी टूल को नीति द्वारा अनुमति नहीं है, तो एंडपॉइंट **404** लौटाता है।

समूह नीतियों को संदर्भ सुलझाने में सहायता देने के लिए, आप वैकल्पिक रूप से सेट कर सकते हैं:

- `x-openclaw-message-channel: <channel>` (उदाहरण: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (जब कई खाते मौजूद हों)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (अमान्य अनुरोध या टूल त्रुटि)
- `401` → अनधिकृत
- `404` → टूल उपलब्ध नहीं (नहीं मिला या allowlist में नहीं)
- `405` → विधि अनुमत नहीं

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
