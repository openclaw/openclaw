---
summary: "OpenClaw में Qwen OAuth (मुफ़्त टियर) का उपयोग करें"
read_when:
  - आप OpenClaw के साथ Qwen का उपयोग करना चाहते हैं
  - आप Qwen Coder के लिए मुफ़्त-टियर OAuth एक्सेस चाहते हैं
title: "Qwen"
x-i18n:
  source_path: providers/qwen.md
  source_hash: 88b88e224e2fecbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:33Z
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

यदि आपने पहले ही Qwen Code CLI के साथ लॉग इन किया है, तो OpenClaw प्रमाणीकरण स्टोर लोड होने पर
`~/.qwen/oauth_creds.json` से क्रेडेंशियल्स सिंक करेगा। फिर भी आपको एक
`models.providers.qwen-portal` प्रविष्टि चाहिए (इसे बनाने के लिए ऊपर दिया गया लॉगिन कमांड उपयोग करें)।

## नोट्स

- टोकन स्वतः रिफ़्रेश होते हैं; यदि रिफ़्रेश विफल हो जाए या एक्सेस रद्द हो जाए, तो लॉगिन कमांड फिर से चलाएँ।
- डिफ़ॉल्ट बेस URL: `https://portal.qwen.ai/v1` (यदि Qwen कोई अलग एंडपॉइंट प्रदान करे, तो
  `models.providers.qwen-portal.baseUrl` से ओवरराइड करें)।
- प्रदाता-स्तरीय नियमों के लिए [Model providers](/concepts/model-providers) देखें।
