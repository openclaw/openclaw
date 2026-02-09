---
summary: "यह ऑडिट करें कि कौन-सी चीज़ें पैसे खर्च कर सकती हैं, कौन-सी कुंजियाँ उपयोग में हैं, और उपयोग कैसे देखा जाए"
read_when:
  - आप समझना चाहते हैं कि कौन-सी विशेषताएँ सशुल्क APIs को कॉल कर सकती हैं
  - आपको कुंजियों, लागत, और उपयोग दृश्यता का ऑडिट करना है
  - आप /status या /usage लागत रिपोर्टिंग समझा रहे हैं
title: "API उपयोग और लागत"
---

# API उपयोग और लागत

यह डॉक **उन फीचर्स** की सूची देता है जो API keys को इनवोक कर सकते हैं और जहाँ उनकी लागत दिखाई देती है। यह उन OpenClaw फीचर्स पर केंद्रित है जो प्रोवाइडर उपयोग या पेड API कॉल्स जनरेट कर सकते हैं।

## लागत कहाँ दिखाई देती है (चैट + CLI)

**प्रति-सत्र लागत स्नैपशॉट**

- `/status` वर्तमान सत्र का मॉडल, संदर्भ उपयोग, और अंतिम प्रतिक्रिया टोकन दिखाता है।
- यदि मॉडल **API-key auth** का उपयोग करता है, तो `/status` अंतिम उत्तर के लिए **अनुमानित लागत** भी दिखाता है।

**प्रति-संदेश लागत फ़ूटर**

- `/usage full` हर उत्तर में एक उपयोग फ़ूटर जोड़ता है, जिसमें **अनुमानित लागत** शामिल होती है (केवल API-key)।
- `/usage tokens` केवल टोकन दिखाता है; OAuth फ्लो डॉलर लागत छिपाते हैं।

**CLI उपयोग विंडो (प्रदाता कोटा)**

- `openclaw status --usage` और `openclaw channels list` प्रदाता **उपयोग विंडो** दिखाते हैं
  (कोटा स्नैपशॉट, प्रति-संदेश लागत नहीं)।

विवरण और उदाहरणों के लिए [Token use & costs](/reference/token-use) देखें।

## कुंजियाँ कैसे खोजी जाती हैं

OpenClaw निम्न से क्रेडेंशियल्स प्राप्त कर सकता है:

- **Auth प्रोफ़ाइल्स** (प्रति-एजेंट, `auth-profiles.json` में संग्रहीत)।
- **Environment variables** (जैसे `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`)।
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`)।
- **Skills** (`skills.entries.<name> 11. .apiKey`) जो keys को skill प्रोसेस env में एक्सपोर्ट कर सकते हैं।हर reply या tool call **वर्तमान मॉडल प्रोवाइडर** (OpenAI, Anthropic, आदि) का उपयोग करता है।

## वे विशेषताएँ जो कुंजियाँ खर्च कर सकती हैं

### 1. कोर मॉडल प्रतिक्रियाएँ (चैट + टूल्स)

यह उपयोग और लागत का प्राथमिक स्रोत है। इनबाउंड मीडिया को reply चलने से पहले summarize/transcribe किया जा सकता है।

प्राइसिंग विन्यास के लिए [Models](/providers/models) और प्रदर्शन के लिए [Token use & costs](/reference/token-use) देखें।

### 2. मीडिया समझ (ऑडियो/इमेज/वीडियो)

यह मॉडल/प्रोवाइडर APIs का उपयोग करता है। कुछ स्टेटस कमांड्स **provider usage endpoints** को कॉल करते हैं ताकि quota windows या auth health दिखाया जा सके।

- ऑडियो: OpenAI / Groq / Deepgram (अब **auto-enabled** जब कुंजियाँ मौजूद हों)।
- इमेज: OpenAI / Anthropic / Google।
- वीडियो: Google।

देखें [Media understanding](/nodes/media-understanding)।

### 3. मेमोरी एम्बेडिंग्स + सिमैंटिक सर्च

सिमैंटिक मेमोरी सर्च, रिमोट प्रदाताओं के लिए कॉन्फ़िगर होने पर **embedding APIs** का उपयोग करता है:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- यदि स्थानीय एम्बेडिंग्स विफल हों तो रिमोट प्रदाता पर वैकल्पिक फ़ॉलबैक

आप `memorySearch.provider = "local"` के साथ इसे स्थानीय रख सकते हैं (कोई API उपयोग नहीं)।

देखें [Memory](/concepts/memory)।

### 4. वेब सर्च टूल (Brave / Perplexity via OpenRouter)

`web_search` API कुंजियों का उपयोग करता है और उपयोग शुल्क लग सकता है:

- **Brave Search API**: `BRAVE_API_KEY` या `tools.web.search.apiKey`
- **Perplexity** (OpenRouter के माध्यम से): `PERPLEXITY_API_KEY` या `OPENROUTER_API_KEY`

**Brave फ्री टियर (उदार):**

- **2,000 अनुरोध/माह**
- **1 अनुरोध/सेकंड**
- **सत्यापन के लिए क्रेडिट कार्ड आवश्यक** (अपग्रेड न करने तक कोई शुल्क नहीं)

देखें [Web tools](/tools/web)।

### 5. वेब फ़ेच टूल (Firecrawl)

`web_fetch` API कुंजी मौजूद होने पर **Firecrawl** को कॉल कर सकता है:

- `FIRECRAWL_API_KEY` या `tools.web.fetch.firecrawl.apiKey`

यदि Firecrawl कॉन्फ़िगर नहीं है, तो टूल डायरेक्ट फ़ेच + रीडेबिलिटी पर फ़ॉलबैक करता है (कोई सशुल्क API नहीं)।

देखें [Web tools](/tools/web)।

### 6. प्रदाता उपयोग स्नैपशॉट्स (status/health)

ये आम तौर पर कम-वॉल्यूम कॉल्स होते हैं, लेकिन फिर भी प्रोवाइडर APIs को हिट करते हैं:
Skills `apiKey` को `skills.entries.<name> 19. .apiKey` में स्टोर कर सकते हैं।

- `openclaw status --usage`
- `openclaw models status --json`

देखें [Models CLI](/cli/models)।

### 7. कम्पैक्शन सेफ़गार्ड सारांशण

कम्पैक्शन सेफ़गार्ड सत्र इतिहास को **वर्तमान मॉडल** का उपयोग करके सारांशित कर सकता है, जिससे
चलने पर प्रदाता APIs कॉल होते हैं।

देखें [Session management + compaction](/reference/session-management-compaction)।

### 8. मॉडल स्कैन / प्रोब

`openclaw models scan` OpenRouter मॉडलों को प्रोब कर सकता है और
प्रोबिंग सक्षम होने पर `OPENROUTER_API_KEY` का उपयोग करता है।

देखें [Models CLI](/cli/models)।

### 9. Talk (स्पीच)

Talk मोड कॉन्फ़िगर होने पर **ElevenLabs** को कॉल कर सकता है:

- `ELEVENLABS_API_KEY` या `talk.apiKey`

देखें [Talk mode](/nodes/talk)।

### 10. Skills (थर्ड-पार्टी APIs)

यदि कोई skill उस key का उपयोग बाहरी APIs के लिए करता है, तो skill के प्रोवाइडर के अनुसार लागत आ सकती है।"हम सब बस अपने-अपने prompts के साथ खेल रहे हैं।" (एक AI, शायद tokens पर हाई)

देखें [Skills](/tools/skills)।
