---
summary: "OpenClaw में Qwen OAuth (मुफ़्त टियर) का उपयोग करें"
read_when:
  - आप OpenClaw के साथ Qwen का उपयोग करना चाहते हैं
  - आप Qwen Coder के लिए मुफ़्त-टियर OAuth एक्सेस चाहते हैं
title: "Qwen"
---

# Qwen

Qwen, Qwen Coder और Qwen Vision मॉडलों के लिए मुफ़्त-टियर OAuth फ़्लो प्रदान करता है
(प्रति दिन 2,000 अनुरोध, Qwen की दर सीमाओं के अधीन)।

## प्लगइन सक्षम करें

```bash
openclaw plugins enable qwen-portal-auth
```

सक्षम करने के बाद Gateway को पुनः आरंभ करें।

## प्रमाणीकरण

```bash
openclaw models auth login --provider qwen-portal --set-default
```

यह Qwen डिवाइस-कोड OAuth फ़्लो चलाता है और आपके
`models.json` में एक प्रदाता प्रविष्टि लिखता है (तेज़ स्विचिंग के लिए
`qwen` उपनाम के साथ)।

## मॉडल IDs

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

मॉडल बदलें:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI लॉगिन का पुन: उपयोग

If you already logged in with the Qwen Code CLI, OpenClaw will sync credentials
from `~/.qwen/oauth_creds.json` when it loads the auth store. You still need a
`models.providers.qwen-portal` entry (use the login command above to create one).

## नोट्स

- टोकन स्वतः रिफ़्रेश होते हैं; यदि रिफ़्रेश विफल हो जाए या एक्सेस रद्द हो जाए, तो लॉगिन कमांड फिर से चलाएँ।
- डिफ़ॉल्ट बेस URL: `https://portal.qwen.ai/v1` (यदि Qwen कोई अलग एंडपॉइंट प्रदान करे, तो
  `models.providers.qwen-portal.baseUrl` से ओवरराइड करें)।
- प्रदाता-स्तरीय नियमों के लिए [Model providers](/concepts/model-providers) देखें।
