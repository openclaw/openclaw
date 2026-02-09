---
summary: "वर्कफ़्लो के लिए केवल-JSON LLM कार्य (वैकल्पिक प्लगइन टूल)"
read_when:
  - आप वर्कफ़्लो के भीतर केवल-JSON LLM चरण चाहते हैं
  - आपको स्वचालन के लिए स्कीमा-मान्य LLM आउटपुट की आवश्यकता है
title: "LLM कार्य"
---

# LLM कार्य

`llm-task` एक **वैकल्पिक प्लगइन टूल** है जो केवल-JSON LLM कार्य चलाता है और
संरचित आउटपुट लौटाता है (वैकल्पिक रूप से JSON Schema के विरुद्ध मान्य किया गया)।

यह Lobster जैसे वर्कफ़्लो इंजनों के लिए आदर्श है: आप प्रत्येक वर्कफ़्लो के लिए कस्टम OpenClaw कोड लिखे बिना एक ही LLM चरण जोड़ सकते हैं।

## प्लगइन सक्षम करें

1. प्लगइन सक्षम करें:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. टूल को Allowlist में जोड़ें (यह `optional: true` के साथ पंजीकृत है):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## विन्यास (वैकल्पिक)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` `provider/model` स्ट्रिंग्स की एक अलाउलिस्ट है। यदि सेट किया गया है, तो सूची के बाहर का कोई भी अनुरोध अस्वीकार कर दिया जाता है।

## टूल पैरामीटर

- `prompt` (string, आवश्यक)
- `input` (any, वैकल्पिक)
- `schema` (object, वैकल्पिक JSON Schema)
- `provider` (string, वैकल्पिक)
- `model` (string, वैकल्पिक)
- `authProfileId` (string, वैकल्पिक)
- `temperature` (number, वैकल्पिक)
- `maxTokens` (number, वैकल्पिक)
- `timeoutMs` (number, वैकल्पिक)

## आउटपुट

`details.json` लौटाता है, जिसमें पार्स किया गया JSON शामिल होता है (और उपलब्ध होने पर `schema` के विरुद्ध मान्य किया जाता है)।

## उदाहरण: Lobster वर्कफ़्लो चरण

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## सुरक्षा नोट्स

- यह टूल **केवल-JSON** है और मॉडल को केवल JSON आउटपुट करने का निर्देश देता है (कोई कोड फ़ेंस नहीं, कोई टिप्पणी नहीं)।
- इस रन के लिए मॉडल को कोई टूल उपलब्ध नहीं कराए जाते।
- जब तक आप `schema` के साथ मान्य न करें, आउटपुट को अविश्वसनीय मानें।
- किसी भी साइड-इफ़ेक्टिंग चरण (send, post, exec) से पहले अनुमोदन रखें।
