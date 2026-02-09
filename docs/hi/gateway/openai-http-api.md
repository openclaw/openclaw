---
summary: "Gateway से OpenAI‑संगत /v1/chat/completions HTTP एंडपॉइंट को उजागर करें"
read_when:
  - OpenAI Chat Completions की अपेक्षा करने वाले टूल्स का एकीकरण करते समय
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw का Gateway एक छोटा OpenAI‑संगत Chat Completions एंडपॉइंट प्रदान कर सकता है।

यह endpoint **डिफ़ॉल्ट रूप से अक्षम** है। पहले इसे config में सक्षम करें।

- `POST /v1/chat/completions`
- Gateway के समान पोर्ट (WS + HTTP मल्टीप्लेक्स): `http://<gateway-host>:<port>/v1/chat/completions`

आंतरिक रूप से, अनुरोधों को एक सामान्य Gateway एजेंट रन के रूप में निष्पादित किया जाता है (उसी कोडपाथ के साथ जैसे `openclaw agent`), इसलिए रूटिंग/अनुमतियाँ/विन्यास आपके Gateway से मेल खाते हैं।

## प्रमाणीकरण

Gateway auth configuration का उपयोग करता है। एक bearer टोकन भेजें:

- `Authorization: Bearer <token>`

टिप्पणियाँ:

- जब `gateway.auth.mode="token"`, तब `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) का उपयोग करें।
- जब `gateway.auth.mode="password"`, तब `gateway.auth.password` (या `OPENCLAW_GATEWAY_PASSWORD`) का उपयोग करें।

## एजेंट का चयन

कोई कस्टम हेडर आवश्यक नहीं है: OpenAI के `model` फ़ील्ड में एजेंट id एन्कोड करें:

- `model: "openclaw:<agentId>"` (उदाहरण: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (उपनाम)

या हेडर के माध्यम से किसी विशिष्ट OpenClaw एजेंट को लक्षित करें:

- `x-openclaw-agent-id: <agentId>` (डिफ़ॉल्ट: `main`)

उन्नत:

- सत्र रूटिंग पर पूर्ण नियंत्रण के लिए `x-openclaw-session-key: <sessionKey>`।

## एंडपॉइंट सक्षम करना

`gateway.http.endpoints.chatCompletions.enabled` को `true` पर सेट करें:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## एंडपॉइंट अक्षम करना

`gateway.http.endpoints.chatCompletions.enabled` को `false` पर सेट करें:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## सत्र व्यवहार

डिफ़ॉल्ट रूप से यह एंडपॉइंट **प्रति अनुरोध stateless** होता है (प्रत्येक कॉल पर एक नया सत्र कुंजी उत्पन्न होती है)।

यदि अनुरोध में OpenAI का `user` स्ट्रिंग शामिल है, तो Gateway उससे एक स्थिर सत्र कुंजी व्युत्पन्न करता है, ताकि दोहराए गए कॉल एक ही एजेंट सत्र साझा कर सकें।

## स्ट्रीमिंग (SSE)

Server‑Sent Events (SSE) प्राप्त करने के लिए `stream: true` सेट करें:

- `Content-Type: text/event-stream`
- प्रत्येक इवेंट पंक्ति `data: <json>` होती है
- स्ट्रीम `data: [DONE]` के साथ समाप्त होती है

## उदाहरण

नॉन‑स्ट्रीमिंग:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

स्ट्रीमिंग:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
