---
summary: "Gateway से OpenResponses-संगत /v1/responses HTTP एंडपॉइंट को उजागर करें"
read_when:
  - OpenResponses API बोलने वाले क्लाइंट्स का एकीकरण करते समय
  - जब आपको आइटम-आधारित इनपुट, क्लाइंट टूल कॉल्स, या SSE इवेंट्स चाहिए हों
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw का Gateway एक OpenResponses-संगत `POST /v1/responses` एंडपॉइंट प्रदान कर सकता है।

यह endpoint **डिफ़ॉल्ट रूप से अक्षम** है। पहले इसे config में सक्षम करें।

- `POST /v1/responses`
- Gateway के समान पोर्ट पर (WS + HTTP मल्टीप्लेक्स): `http://<gateway-host>:<port>/v1/responses`

आंतरिक रूप से, अनुरोधों को एक सामान्य Gateway एजेंट रन के रूप में निष्पादित किया जाता है (वही कोडपाथ जैसा
`openclaw agent`), इसलिए रूटिंग/अनुमतियाँ/विन्यास आपके Gateway से मेल खाते हैं।

## प्रमाणीकरण

Gateway auth configuration का उपयोग करता है। एक bearer टोकन भेजें:

- `Authorization: Bearer <token>`

टिप्पणियाँ:

- जब `gateway.auth.mode="token"` हो, तो `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) का उपयोग करें।
- जब `gateway.auth.mode="password"` हो, तो `gateway.auth.password` (या `OPENCLAW_GATEWAY_PASSWORD`) का उपयोग करें।

## एजेंट का चयन

किसी कस्टम हेडर की आवश्यकता नहीं: OpenResponses के `model` फ़ील्ड में एजेंट आईडी एन्कोड करें:

- `model: "openclaw:<agentId>"` (उदाहरण: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (उपनाम)

या हेडर द्वारा किसी विशिष्ट OpenClaw एजेंट को लक्षित करें:

- `x-openclaw-agent-id: <agentId>` (डिफ़ॉल्ट: `main`)

उन्नत:

- सत्र रूटिंग पर पूर्ण नियंत्रण के लिए `x-openclaw-session-key: <sessionKey>`।

## एंडपॉइंट सक्षम करना

`gateway.http.endpoints.responses.enabled` को `true` पर सेट करें:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## एंडपॉइंट अक्षम करना

`gateway.http.endpoints.responses.enabled` को `false` पर सेट करें:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## सत्र व्यवहार

डिफ़ॉल्ट रूप से यह एंडपॉइंट **प्रति अनुरोध स्टेटलेस** होता है (हर कॉल पर एक नई सत्र कुंजी बनाई जाती है)।

यदि अनुरोध में OpenResponses का `user` स्ट्रिंग शामिल है, तो Gateway उससे एक स्थिर सत्र कुंजी
व्युत्पन्न करता है, ताकि दोहराए गए कॉल्स एक ही एजेंट सत्र साझा कर सकें।

## अनुरोध संरचना (समर्थित)

रिक्वेस्ट item-आधारित इनपुट के साथ OpenResponses API का अनुसरण करती है। वर्तमान समर्थन:

- `input`: स्ट्रिंग या आइटम ऑब्जेक्ट्स की ऐरे।
- `instructions`: सिस्टम प्रॉम्प्ट में मर्ज किया जाता है।
- `tools`: क्लाइंट टूल परिभाषाएँ (फ़ंक्शन टूल्स)।
- `tool_choice`: क्लाइंट टूल्स को फ़िल्टर या आवश्यक बनाता है।
- `stream`: SSE स्ट्रीमिंग सक्षम करता है।
- `max_output_tokens`: सर्वोत्तम-प्रयास आउटपुट सीमा (प्रदाता-निर्भर)।
- `user`: स्थिर सत्र रूटिंग।

स्वीकृत लेकिन **वर्तमान में अनदेखा** किया जाता है:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## आइटम्स (इनपुट)

### `message`

भूमिकाएँ: `system`, `developer`, `user`, `assistant`।

- `system` और `developer` सिस्टम प्रॉम्प्ट में जोड़े जाते हैं।
- सबसे हालिया `user` या `function_call_output` आइटम “वर्तमान संदेश” बन जाता है।
- पहले के यूज़र/असिस्टेंट संदेश संदर्भ के लिए इतिहास के रूप में शामिल किए जाते हैं।

### `function_call_output` (टर्न-आधारित टूल्स)

मॉडल को टूल परिणाम वापस भेजें:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` और `item_reference`

स्कीमा संगतता के लिए स्वीकृत हैं, लेकिन प्रॉम्प्ट बनाते समय अनदेखा किए जाते हैं।

## टूल्स (क्लाइंट-साइड फ़ंक्शन टूल्स)

`tools: [{ type: "function", function: { name, description?, parameters?` के साथ टूल्स प्रदान करें `} }]`।

यदि एजेंट किसी टूल को कॉल करने का निर्णय लेता है, तो प्रतिक्रिया में एक `function_call` आउटपुट आइटम लौटता है।
फिर आप टर्न जारी रखने के लिए `function_call_output` के साथ एक फ़ॉलो-अप रिक्वेस्ट भेजते हैं।

## छवियाँ (`input_image`)

base64 या URL स्रोतों का समर्थन करता है:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

अनुमत MIME प्रकार (वर्तमान): `image/jpeg`, `image/png`, `image/gif`, `image/webp`।
अधिकतम आकार (वर्तमान): 10MB।

## फ़ाइलें (`input_file`)

base64 या URL स्रोतों का समर्थन करता है:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

अनुमत MIME प्रकार (वर्तमान): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`।

अधिकतम आकार (वर्तमान): 5MB।

वर्तमान व्यवहार:

- फ़ाइल सामग्री डिकोड की जाती है और **सिस्टम प्रॉम्प्ट** में जोड़ी जाती है, यूज़र संदेश में नहीं,
  ताकि यह अल्पकालिक रहे (सत्र इतिहास में स्थायी न हो)।
- PDFs को टेक्स्ट के लिए पार्स किया जाता है। यदि बहुत कम टेक्स्ट मिलता है, तो पहली पेजों को रास्टराइज़ किया जाता है
  और छवियों के रूप में मॉडल को भेजा जाता है।

PDF पार्सिंग Node-फ़्रेंडली `pdfjs-dist` लेगेसी बिल्ड (बिना worker) का उपयोग करती है। आधुनिक
PDF.js बिल्ड ब्राउज़र workers/DOM globals की अपेक्षा करता है, इसलिए Gateway में इसका उपयोग नहीं किया जाता।

URL फ़ेच डिफ़ॉल्ट्स:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- अनुरोध संरक्षित होते हैं (DNS रेज़ोल्यूशन, निजी IP ब्लॉकिंग, रीडायरेक्ट सीमाएँ, टाइमआउट्स)।

## फ़ाइल + छवि सीमाएँ (विन्यास)

डिफ़ॉल्ट्स को `gateway.http.endpoints.responses` के अंतर्गत समायोजित किया जा सकता है:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

जब छोड़ा जाए तो डिफ़ॉल्ट्स:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## स्ट्रीमिंग (SSE)

Server-Sent Events (SSE) प्राप्त करने के लिए `stream: true` सेट करें:

- `Content-Type: text/event-stream`
- प्रत्येक इवेंट लाइन `event: <type>` और `data: <json>` होती है
- स्ट्रीम `data: [DONE]` के साथ समाप्त होती है

वर्तमान में उत्सर्जित इवेंट प्रकार:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (त्रुटि पर)

## उपयोग

`usage` तब भरा जाता है जब अंतर्निहित प्रदाता टोकन गणनाएँ रिपोर्ट करता है।

## त्रुटियाँ

त्रुटियाँ इस प्रकार के JSON ऑब्जेक्ट का उपयोग करती हैं:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

सामान्य मामले:

- `401` अनुपस्थित/अमान्य प्रमाणीकरण
- `400` अमान्य अनुरोध बॉडी
- `405` गलत मेथड

## उदाहरण

नॉन-स्ट्रीमिंग:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

स्ट्रीमिंग:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
