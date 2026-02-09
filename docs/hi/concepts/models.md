---
summary: "मॉडल्स CLI: सूची, सेट, उपनाम, फॉलबैक, स्कैन, स्थिति"
read_when:
  - मॉडल्स CLI (models list/set/scan/aliases/fallbacks) जोड़ते या संशोधित करते समय
  - मॉडल फॉलबैक व्यवहार या चयन UX बदलते समय
  - मॉडल स्कैन प्रोब्स (tools/images) अपडेट करते समय
title: "मॉडल्स CLI"
---

# मॉडल्स CLI

20. auth प्रोफ़ाइल रोटेशन, कूलडाउन, और यह फॉलबैक्स के साथ कैसे इंटरैक्ट करता है—इसके लिए [/concepts/model-failover](/concepts/model-failover) देखें।
21. त्वरित प्रोवाइडर ओवरव्यू + उदाहरण: [/concepts/model-providers](/concepts/model-providers)।

## मॉडल चयन कैसे काम करता है

OpenClaw इस क्रम में मॉडल चुनता है:

1. **प्राथमिक** मॉडल (`agents.defaults.model.primary` या `agents.defaults.model`)।
2. `agents.defaults.model.fallbacks` में **फॉलबैक** (क्रम में)।
3. अगले मॉडल पर जाने से पहले, **प्रदाता प्रमाणीकरण फेलओवर** उसी प्रदाता के भीतर होता है।

संबंधित:

- `agents.defaults.models` वह allowlist/कैटलॉग है जिन मॉडलों का उपयोग OpenClaw कर सकता है (उपनाम सहित)।
- `agents.defaults.imageModel` का उपयोग **केवल तब** होता है जब प्राथमिक मॉडल इमेज स्वीकार नहीं कर सकता।
- प्रति-एजेंट डिफ़ॉल्ट्स `agents.defaults.model` को `agents.list[].model` तथा बाइंडिंग्स के माध्यम से ओवरराइड कर सकते हैं (देखें [/concepts/multi-agent](/concepts/multi-agent))।

## त्वरित मॉडल चयन (अनौपचारिक)

- **GLM**: कोडिंग/टूल कॉलिंग के लिए थोड़ा बेहतर।
- **MiniMax**: लेखन और वाइब्स के लिए बेहतर।

## सेटअप विज़ार्ड (अनुशंसित)

यदि आप कॉन्फ़िग को हाथ से संपादित नहीं करना चाहते, तो ऑनबोर्डिंग विज़ार्ड चलाएँ:

```bash
openclaw onboard
```

यह सामान्य प्रदाताओं के लिए मॉडल + प्रमाणीकरण सेट कर सकता है, जिनमें **OpenAI Code (Codex)
सब्सक्रिप्शन** (OAuth) और **Anthropic** (एपीआई कुंजी अनुशंसित; `claude
setup-token` भी समर्थित) शामिल हैं।

## कॉन्फ़िग कुंजियाँ (अवलोकन)

- `agents.defaults.model.primary` और `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` और `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + उपनाम + प्रदाता पैरामीटर)
- `models.providers` (कस्टम प्रदाता `models.json` में लिखे जाते हैं)

22. मॉडल रेफ़्स को लोअरकेस में नॉर्मलाइज़ किया जाता है। 23. `z.ai/*` जैसे प्रोवाइडर एलियास `zai/*` में नॉर्मलाइज़ हो जाते हैं।

प्रदाता विन्यास के उदाहरण (OpenCode Zen सहित) यहाँ उपलब्ध हैं:
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)।

## “Model is not allowed” (और उत्तर क्यों रुक जाते हैं)

24. यदि `agents.defaults.models` सेट है, तो यह `/model` और सेशन ओवरराइड्स के लिए **allowlist** बन जाता है। 25. जब कोई उपयोगकर्ता ऐसा मॉडल चुनता है जो उस allowlist में नहीं है, तो OpenClaw लौटाता है:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

26. यह सामान्य उत्तर बनने **से पहले** होता है, इसलिए संदेश ऐसा लग सकता है जैसे उसने “जवाब नहीं दिया।” 27. समाधान यह है कि या तो:

- मॉडल को `agents.defaults.models` में जोड़ें, या
- allowlist साफ़ करें (`agents.defaults.models` हटाएँ), या
- `/model list` से कोई मॉडल चुनें।

उदाहरण allowlist कॉन्फ़िग:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## चैट में मॉडल बदलना (`/model`)

बिना रीस्टार्ट किए आप वर्तमान सत्र के लिए मॉडल बदल सकते हैं:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

नोट्स:

- `/model` (और `/model list`) एक संक्षिप्त, क्रमांकित पिकर है (मॉडल परिवार + उपलब्ध प्रदाता)।
- `/model <#>` उसी पिकर से चयन करता है।
- `/model status` विस्तृत दृश्य है (प्रमाणीकरण उम्मीदवार और, जब कॉन्फ़िगर हो, प्रदाता एंडपॉइंट `baseUrl` + `api` मोड)।
- 28. मॉडल रेफ़्स को **पहले** `/` पर विभाजित करके पार्स किया जाता है। 29. `/model <ref>` टाइप करते समय `provider/model` का उपयोग करें।
- यदि स्वयं मॉडल ID में `/` (OpenRouter-शैली) शामिल है, तो आपको प्रदाता प्रीफ़िक्स शामिल करना होगा (उदाहरण: `/model openrouter/moonshotai/kimi-k2`)।
- यदि आप प्रदाता छोड़ देते हैं, तो OpenClaw इनपुट को उपनाम या **डिफ़ॉल्ट प्रदाता** के मॉडल के रूप में मानता है (यह केवल तब काम करता है जब मॉडल ID में `/` न हो)।

पूर्ण कमांड व्यवहार/कॉन्फ़िग: [Slash commands](/tools/slash-commands)।

## CLI कमांड्स

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (बिना सबकमांड) `models status` का शॉर्टकट है।

### `models list`

30. डिफ़ॉल्ट रूप से कॉन्फ़िगर किए गए मॉडल दिखाता है। 31. उपयोगी फ़्लैग्स:

- `--all`: पूर्ण कैटलॉग
- `--local`: केवल स्थानीय प्रदाता
- `--provider <name>`: प्रदाता के अनुसार फ़िल्टर
- `--plain`: प्रति पंक्ति एक मॉडल
- `--json`: मशीन‑पठनीय आउटपुट

### `models status`

32. कॉन्फ़िगर किए गए प्रोवाइडर्स के लिए रेज़ॉल्व्ड प्राइमरी मॉडल, फॉलबैक्स, इमेज मॉडल, और auth ओवरव्यू दिखाता है। 33. यह auth स्टोर में मिली प्रोफ़ाइल्स के लिए OAuth एक्सपायरी स्टेटस भी दिखाता है (डिफ़ॉल्ट रूप से 24h के भीतर चेतावनी देता है)। 34. `--plain` केवल रेज़ॉल्व्ड प्राइमरी मॉडल प्रिंट करता है।
33. OAuth स्टेटस हमेशा दिखाया जाता है (और `--json` आउटपुट में शामिल होता है)। 36. यदि किसी कॉन्फ़िगर किए गए प्रोवाइडर के पास क्रेडेंशियल्स नहीं हैं, तो `models status` एक **Missing auth** सेक्शन प्रिंट करता है।
34. JSON में `auth.oauth` (वार्न विंडो + प्रोफ़ाइल्स) और `auth.providers` (प्रोवाइडर‑वार प्रभावी auth) शामिल होते हैं।
35. ऑटोमेशन के लिए `--check` का उपयोग करें (मिसिंग/एक्सपायर्ड होने पर exit `1`, एक्सपायर होने वाले पर `2`)।

Anthropic के लिए पसंदीदा प्रमाणीकरण Claude Code CLI setup-token है (कहीं भी चलाएँ; आवश्यकता हो तो Gateway होस्ट पर पेस्ट करें):

```bash
claude setup-token
openclaw models status
```

## स्कैनिंग (OpenRouter फ्री मॉडल्स)

`openclaw models scan` OpenRouter के **फ्री मॉडल कैटलॉग** का निरीक्षण करता है और
वैकल्पिक रूप से टूल और इमेज समर्थन के लिए मॉडलों को प्रोब कर सकता है।

मुख्य फ़्लैग्स:

- `--no-probe`: लाइव प्रोब्स छोड़ें (केवल मेटाडेटा)
- `--min-params <b>`: न्यूनतम पैरामीटर आकार (अरबों में)
- `--max-age-days <days>`: पुराने मॉडल छोड़ें
- `--provider <name>`: प्रदाता प्रीफ़िक्स फ़िल्टर
- `--max-candidates <n>`: फॉलबैक सूची का आकार
- `--set-default`: `agents.defaults.model.primary` को पहले चयन पर सेट करें
- `--set-image`: `agents.defaults.imageModel.primary` को पहले इमेज चयन पर सेट करें

39. प्रोबिंग के लिए OpenRouter API key की आवश्यकता होती है (auth प्रोफ़ाइल्स से या `OPENROUTER_API_KEY`)। 40. कुंजी के बिना, केवल कैंडिडेट्स सूचीबद्ध करने के लिए `--no-probe` का उपयोग करें।

स्कैन परिणामों की रैंकिंग इस आधार पर होती है:

1. इमेज समर्थन
2. टूल लेटेंसी
3. कॉन्टेक्स्ट आकार
4. पैरामीटर संख्या

इनपुट

- OpenRouter `/models` सूची (फ़िल्टर `:free`)
- ऑथ प्रोफ़ाइल्स या `OPENROUTER_API_KEY` से OpenRouter API कुंजी आवश्यक (देखें [/environment](/help/environment))
- वैकल्पिक फ़िल्टर: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- प्रोब नियंत्रण: `--timeout`, `--concurrency`

41. TTY में चलाने पर, आप फॉलबैक्स को इंटरैक्टिव रूप से चुन सकते हैं। 42. नॉन‑इंटरैक्टिव मोड में, डिफ़ॉल्ट स्वीकार करने के लिए `--yes` पास करें।

## मॉडल्स रजिस्ट्री (`models.json`)

43. `models.providers` में कस्टम प्रोवाइडर्स को एजेंट डायरेक्टरी के तहत `models.json` में लिखा जाता है (डिफ़ॉल्ट `~/.openclaw/agents/<agentId>/models.json`)। 44. यह फ़ाइल डिफ़ॉल्ट रूप से मर्ज होती है, जब तक `models.mode` को `replace` पर सेट न किया गया हो।
