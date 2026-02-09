---
summary: "योजना: OpenResponses /v1/responses एंडपॉइंट जोड़ना और Chat Completions को स्वच्छ रूप से अप्रचलित करना"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway योजना"
---

# OpenResponses Gateway एकीकरण योजना

## संदर्भ

OpenClaw Gateway वर्तमान में `/v1/chat/completions` पर एक न्यूनतम OpenAI-संगत Chat Completions एंडपॉइंट प्रदान करता है
(देखें [OpenAI Chat Completions](/gateway/openai-http-api))।

36. Open Responses, OpenAI Responses API पर आधारित एक open inference standard है। 37. इसे agentic workflows के लिए डिज़ाइन किया गया है और यह item‑based inputs तथा semantic streaming events का उपयोग करता है। 38. OpenResponses
    spec `/v1/chat/completions` नहीं, बल्कि `/v1/responses` को परिभाषित करता है।

## लक्ष्य

- OpenResponses सेमांटिक्स का पालन करने वाला `/v1/responses` एंडपॉइंट जोड़ना।
- Chat Completions को एक संगतता लेयर के रूप में बनाए रखना जिसे आसानी से अक्षम किया जा सके और अंततः हटाया जा सके।
- पृथक, पुन: उपयोग योग्य स्कीमाओं के साथ वैलिडेशन और पार्सिंग का मानकीकरण।

## गैर-लक्ष्य

- पहले चरण में पूर्ण OpenResponses फ़ीचर समानता (इमेज, फ़ाइलें, होस्टेड टूल्स)।
- आंतरिक एजेंट निष्पादन लॉजिक या टूल ऑर्केस्ट्रेशन को प्रतिस्थापित करना।
- पहले चरण के दौरान मौजूदा `/v1/chat/completions` व्यवहार को बदलना।

## अनुसंधान सारांश

स्रोत: OpenResponses OpenAPI, OpenResponses स्पेसिफ़िकेशन साइट, और Hugging Face ब्लॉग पोस्ट।

मुख्य बिंदु:

- `POST /v1/responses` में `CreateResponseBody` फ़ील्ड स्वीकार होते हैं, जैसे `model`, `input` (स्ट्रिंग या
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, और
  `max_tool_calls`।
- `ItemParam` एक डिस्क्रिमिनेटेड यूनियन है, जिसमें शामिल हैं:
  - `message` आइटम, जिनकी भूमिकाएँ `system`, `developer`, `user`, `assistant` हैं
  - `function_call` और `function_call_output`
  - `reasoning`
  - `item_reference`
- सफल प्रतिक्रियाएँ एक `ResponseResource` लौटाती हैं, जिसमें `object: "response"`, `status`, और
  `output` आइटम होते हैं।
- स्ट्रीमिंग में निम्न जैसे सेमांटिक इवेंट्स का उपयोग होता है:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- स्पेसिफ़िकेशन की आवश्यकताएँ:
  - `Content-Type: text/event-stream`
  - `event:` को JSON के `type` फ़ील्ड से मेल खाना चाहिए
  - टर्मिनल इवेंट का लिटरल `[DONE]` होना चाहिए
- रीज़निंग आइटम `content`, `encrypted_content`, और `summary` को एक्सपोज़ कर सकते हैं।
- HF उदाहरणों में अनुरोधों में `OpenResponses-Version: latest` शामिल है (वैकल्पिक हेडर)।

## प्रस्तावित आर्किटेक्चर

- केवल Zod स्कीमाओं वाला `src/gateway/open-responses.schema.ts` जोड़ना (कोई Gateway इम्पोर्ट नहीं)।
- `/v1/responses` के लिए `src/gateway/openresponses-http.ts` (या `open-responses-http.ts`) जोड़ना।
- लेगेसी संगतता एडेप्टर के रूप में `src/gateway/openai-http.ts` को यथावत रखना।
- कॉन्फ़िग `gateway.http.endpoints.responses.enabled` जोड़ना (डिफ़ॉल्ट `false`)।
- `gateway.http.endpoints.chatCompletions.enabled` को स्वतंत्र रखना; दोनों एंडपॉइंट्स को अलग-अलग टॉगल करने की अनुमति देना।
- Chat Completions सक्षम होने पर स्टार्टअप चेतावनी जारी करना ताकि लेगेसी स्थिति का संकेत मिले।

## Chat Completions के लिए अप्रचलन पथ

- सख़्त मॉड्यूल सीमाएँ बनाए रखना: responses और chat completions के बीच कोई साझा स्कीमा टाइप नहीं।
- Chat Completions को कॉन्फ़िग द्वारा ऑप्ट-इन बनाना ताकि कोड परिवर्तन के बिना इसे अक्षम किया जा सके।
- `/v1/responses` स्थिर होने पर दस्तावेज़ों में Chat Completions को लेगेसी के रूप में चिह्नित करना।
- वैकल्पिक भविष्य कदम: सरल हटाने पथ के लिए Chat Completions अनुरोधों को Responses हैंडलर से मैप करना।

## चरण 1 समर्थित उपसमुच्चय

- `input` को स्ट्रिंग या `ItemParam[]` के रूप में स्वीकार करना, जिसमें संदेश भूमिकाएँ और `function_call_output` हों।
- सिस्टम और डेवलपर संदेशों को `extraSystemPrompt` में निकालना।
- एजेंट रन के लिए वर्तमान संदेश के रूप में सबसे हालिया `user` या `function_call_output` का उपयोग करना।
- असमर्थित कंटेंट पार्ट्स (इमेज/फ़ाइल) को `invalid_request_error` के साथ अस्वीकार करना।
- `output_text` कंटेंट के साथ एक एकल असिस्टेंट संदेश लौटाना।
- टोकन अकाउंटिंग जुड़ने तक शून्य मानों के साथ `usage` लौटाना।

## वैलिडेशन रणनीति (SDK नहीं)

- समर्थित उपसमुच्चय के लिए Zod स्कीमाएँ लागू करना:
  - `CreateResponseBody`
  - `ItemParam` + संदेश कंटेंट पार्ट यूनियन
  - `ResponseResource`
  - Gateway द्वारा उपयोग किए जाने वाले स्ट्रीमिंग इवेंट शेप्स
- स्कीमाओं को एक ही, पृथक मॉड्यूल में रखना ताकि ड्रिफ़्ट से बचा जा सके और भविष्य में कोडजेन की अनुमति मिले।

## स्ट्रीमिंग इम्प्लीमेंटेशन (चरण 1)

- `event:` और `data:` दोनों के साथ SSE लाइन्स।
- आवश्यक अनुक्रम (न्यूनतम व्यवहार्य):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (आवश्यकतानुसार दोहराएँ)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## परीक्षण और सत्यापन योजना

- `/v1/responses` के लिए e2e कवरेज जोड़ना:
  - प्रमाणीकरण आवश्यक
  - नॉन-स्ट्रीम प्रतिक्रिया संरचना
  - स्ट्रीम इवेंट क्रम और `[DONE]`
  - हेडर्स और `user` के साथ सत्र रूटिंग
- `src/gateway/openai-http.e2e.test.ts` को अपरिवर्तित रखना।
- मैनुअल: `stream: true` के साथ `/v1/responses` पर curl करना और इवेंट क्रम तथा टर्मिनल
  `[DONE]` सत्यापित करना।

## दस्तावेज़ अपडेट (फ़ॉलो-अप)

- `/v1/responses` उपयोग और उदाहरणों के लिए एक नया डॉक्स पेज जोड़ना।
- `/gateway/openai-http-api` को लेगेसी नोट और `/v1/responses` के पॉइंटर के साथ अपडेट करना।
