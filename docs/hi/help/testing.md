---
summary: "टेस्टिंग किट: यूनिट/e2e/लाइव सूट्स, Docker रनर्स, और प्रत्येक टेस्ट क्या कवर करता है"
read_when:
  - स्थानीय रूप से या CI में टेस्ट चलाते समय
  - मॉडल/प्रदाता बग्स के लिए रिग्रेशन जोड़ते समय
  - Gateway + एजेंट व्यवहार को डिबग करते समय
title: "टेस्टिंग"
---

# टेस्टिंग

OpenClaw में तीन Vitest सूट्स (unit/integration, e2e, live) और Docker रनर्स का एक छोटा सेट है।

यह दस्तावेज़ “हम कैसे टेस्ट करते हैं” के लिए एक मार्गदर्शिका है:

- प्रत्येक सूट क्या कवर करता है (और क्या जानबूझकर _कवर नहीं_ करता)
- सामान्य वर्कफ़्लो के लिए कौन-से कमांड चलाने हैं (लोकल, प्री-पुश, डिबगिंग)
- लाइव टेस्ट क्रेडेंशियल्स कैसे खोजते हैं और मॉडल/प्रदाता कैसे चुनते हैं
- वास्तविक दुनिया के मॉडल/प्रदाता मुद्दों के लिए रिग्रेशन कैसे जोड़ें

## त्वरित प्रारंभ

अधिकांश दिनों में:

- पूर्ण गेट (पुश से पहले अपेक्षित): `pnpm build && pnpm check && pnpm test`

जब आप टेस्ट्स को छूते हैं या अतिरिक्त भरोसा चाहते हैं:

- कवरेज गेट: `pnpm test:coverage`
- E2E सूट: `pnpm test:e2e`

जब वास्तविक प्रदाताओं/मॉडलों को डिबग कर रहे हों (वास्तविक क्रेड्स आवश्यक):

- लाइव सूट (मॉडल + Gateway टूल/इमेज प्रोब्स): `pnpm test:live`

सुझाव: जब आपको केवल एक फेल होने वाला केस चाहिए, तो नीचे वर्णित allowlist env vars के माध्यम से लाइव टेस्ट्स को सीमित करना बेहतर है।

## टेस्ट सूट्स (कहाँ क्या चलता है)

सूट्स को “यथार्थवाद में वृद्धि” (और अस्थिरता/लागत में वृद्धि) के रूप में सोचें:

### यूनिट / इंटीग्रेशन (डिफ़ॉल्ट)

- कमांड: `pnpm test`
- कॉन्फ़िग: `vitest.config.ts`
- फ़ाइलें: `src/**/*.test.ts`
- दायरा:
  - शुद्ध यूनिट टेस्ट्स
  - इन-प्रोसेस इंटीग्रेशन टेस्ट्स (gateway auth, routing, tooling, parsing, config)
  - ज्ञात बग्स के लिए निर्धारक रिग्रेशन
- अपेक्षाएँ:
  - CI में चलता है
  - वास्तविक कुंजियों की आवश्यकता नहीं
  - तेज़ और स्थिर होना चाहिए

### E2E (gateway स्मोक)

- कमांड: `pnpm test:e2e`
- कॉन्फ़िग: `vitest.e2e.config.ts`
- फ़ाइलें: `src/**/*.e2e.test.ts`
- दायरा:
  - मल्टी-इंस्टेंस gateway एंड-टू-एंड व्यवहार
  - WebSocket/HTTP सतहें, नोड पेयरिंग, और भारी नेटवर्किंग
- अपेक्षाएँ:
  - CI में चलता है (जब पाइपलाइन में सक्षम हो)
  - वास्तविक कुंजियों की आवश्यकता नहीं
  - यूनिट टेस्ट्स से अधिक मूविंग पार्ट्स (धीमा हो सकता है)

### लाइव (वास्तविक प्रदाता + वास्तविक मॉडल)

- कमांड: `pnpm test:live`
- कॉन्फ़िग: `vitest.live.config.ts`
- फ़ाइलें: `src/**/*.live.test.ts`
- डिफ़ॉल्ट: `pnpm test:live` द्वारा **सक्षम** (सेट करता है `OPENCLAW_LIVE_TEST=1`)
- दायरा:
  - “क्या यह प्रदाता/मॉडल _आज_ वास्तविक क्रेड्स के साथ काम करता है?”
  - प्रदाता फ़ॉर्मैट बदलाव, टूल-कॉलिंग की बारीकियाँ, auth समस्याएँ, और रेट लिमिट व्यवहार पकड़ना
- अपेक्षाएँ:
  - डिज़ाइन के अनुसार CI-स्थिर नहीं (वास्तविक नेटवर्क, वास्तविक प्रदाता नीतियाँ, कोटा, आउटेज)
  - पैसा खर्च करता है / रेट लिमिट्स उपयोग करता है
  - “सब कुछ” चलाने के बजाय सीमित सबसेट्स चलाना बेहतर
  - लाइव रन `~/.profile` को सोर्स करेंगे ताकि गायब API कुंजियाँ मिल सकें
  - Anthropic कुंजी रोटेशन: `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (या `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) या कई `ANTHROPIC_API_KEY*` vars सेट करें; टेस्ट्स रेट लिमिट पर रिट्राई करेंगे

## मुझे कौन-सा सूट चलाना चाहिए?

इस निर्णय तालिका का उपयोग करें:

- लॉजिक/टेस्ट्स संपादित कर रहे हैं: `pnpm test` चलाएँ (और यदि बहुत बदलाव किया है तो `pnpm test:coverage`)
- gateway नेटवर्किंग / WS प्रोटोकॉल / पेयरिंग को छू रहे हैं: `pnpm test:e2e` जोड़ें
- “मेरा बॉट डाउन है” / प्रदाता-विशिष्ट विफलताएँ / टूल कॉलिंग डिबग कर रहे हैं: सीमित `pnpm test:live` चलाएँ

## लाइव: मॉडल स्मोक (प्रोफ़ाइल कुंजियाँ)

लाइव टेस्ट्स दो लेयर्स में विभाजित हैं ताकि विफलताओं को अलग किया जा सके:

- “डायरेक्ट मॉडल” बताता है कि प्रदाता/मॉडल दी गई कुंजी के साथ उत्तर दे सकता है या नहीं।
- “Gateway स्मोक” बताता है कि पूरा gateway+agent पाइपलाइन उस मॉडल के लिए काम करता है (सेशन्स, इतिहास, टूल्स, sandbox नीति, आदि)।

### लेयर 1: डायरेक्ट मॉडल कम्प्लीशन (gateway नहीं)

- टेस्ट: `src/agents/models.profiles.live.test.ts`
- लक्ष्य:
  - खोजे गए मॉडलों की गणना
  - `getApiKeyForModel` का उपयोग करके वे मॉडल चुनना जिनके लिए आपके पास क्रेड्स हैं
  - प्रति मॉडल एक छोटा कम्प्लीशन चलाना (और जहाँ आवश्यक हो लक्षित रिग्रेशन)
- सक्षम कैसे करें:
  - `pnpm test:live` (या यदि Vitest सीधे चला रहे हों तो `OPENCLAW_LIVE_TEST=1`)
- वास्तव में यह सूट चलाने के लिए `OPENCLAW_LIVE_MODELS=modern` (या आधुनिक के लिए उपनाम `all`) सेट करें; अन्यथा यह स्किप हो जाता है ताकि `pnpm test:live` gateway स्मोक पर केंद्रित रहे
- मॉडल कैसे चुनें:
  - आधुनिक allowlist चलाने के लिए `OPENCLAW_LIVE_MODELS=modern` (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` आधुनिक allowlist का उपनाम है
  - या `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (कॉमा allowlist)
- प्रदाता कैसे चुनें:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (कॉमा allowlist)
- कुंजियाँ कहाँ से आती हैं:
  - डिफ़ॉल्ट रूप से: प्रोफ़ाइल स्टोर और env फ़ॉलबैक्स
  - केवल **प्रोफ़ाइल स्टोर** लागू करने के लिए `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` सेट करें
- यह क्यों मौजूद है:
  - “प्रदाता API टूटा है / कुंजी अमान्य है” को “gateway एजेंट पाइपलाइन टूटी है” से अलग करता है
  - छोटे, पृथक रिग्रेशन शामिल करता है (उदाहरण: OpenAI Responses/Codex Responses reasoning replay + tool-call फ़्लोज़)

### लेयर 2: Gateway + dev एजेंट स्मोक (जो “@openclaw” वास्तव में करता है)

- टेस्ट: `src/gateway/gateway-models.profiles.live.test.ts`
- लक्ष्य:
  - इन-प्रोसेस gateway स्पिन अप करना
  - एक `agent:dev:*` सत्र बनाना/पैच करना (प्रति रन मॉडल ओवरराइड)
  - कुंजियों वाले मॉडलों पर इटरेट करना और यह सत्यापित करना:
    - “अर्थपूर्ण” प्रतिक्रिया (बिना टूल्स)
    - एक वास्तविक टूल इन्वोकेशन काम करता है (read प्रोब)
    - वैकल्पिक अतिरिक्त टूल प्रोब्स (exec+read प्रोब)
    - OpenAI रिग्रेशन पाथ्स (केवल टूल-कॉल → फॉलो-अप) काम करते रहें
- प्रोब विवरण (ताकि आप विफलताओं को जल्दी समझा सकें):
  - `read` प्रोब: टेस्ट वर्कस्पेस में एक nonce फ़ाइल लिखता है और एजेंट से उसे `read` करने और nonce वापस इको करने को कहता है।
  - `exec+read` प्रोब: टेस्ट एजेंट से `exec`-राइट करके एक temp फ़ाइल में nonce लिखने, फिर उसे `read` करने को कहता है।
  - इमेज प्रोब: टेस्ट एक जेनरेटेड PNG (बिल्ली + रैंडमाइज़्ड कोड) अटैच करता है और मॉडल से `cat <CODE>` लौटाने की अपेक्षा करता है।
  - इम्प्लीमेंटेशन संदर्भ: `src/gateway/gateway-models.profiles.live.test.ts` और `src/gateway/live-image-probe.ts`।
- सक्षम कैसे करें:
  - `pnpm test:live` (या यदि Vitest सीधे चला रहे हों तो `OPENCLAW_LIVE_TEST=1`)
- मॉडल कैसे चुनें:
  - डिफ़ॉल्ट: आधुनिक allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` आधुनिक allowlist का उपनाम है
  - या `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (या कॉमा सूची) सेट करके सीमित करें
- प्रदाता कैसे चुनें (“OpenRouter सब कुछ” से बचें):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (कॉमा allowlist)
- इस लाइव टेस्ट में टूल + इमेज प्रोब्स हमेशा चालू रहते हैं:
  - `read` प्रोब + `exec+read` प्रोब (टूल स्ट्रेस)
  - इमेज प्रोब तब चलता है जब मॉडल इमेज इनपुट सपोर्ट विज्ञापित करता है
  - फ़्लो (उच्च स्तर):
    - टेस्ट “CAT” + रैंडम कोड के साथ एक छोटा PNG बनाता है (`src/gateway/live-image-probe.ts`)
    - इसे `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` के माध्यम से भेजता है
    - Gateway अटैचमेंट्स को `images[]` में पार्स करता है (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - एम्बेडेड एजेंट मल्टीमॉडल यूज़र संदेश मॉडल को फ़ॉरवर्ड करता है
    - असर्शन: उत्तर में `cat` + कोड शामिल हो (OCR सहनशीलता: छोटी गलतियाँ स्वीकार्य)

सुझाव: अपनी मशीन पर आप क्या टेस्ट कर सकते हैं (और सटीक `provider/model` IDs) देखने के लिए चलाएँ:

```bash
openclaw models list
openclaw models list --json
```

## लाइव: Anthropic setup-token स्मोक

- टेस्ट: `src/agents/anthropic.setup-token.live.test.ts`
- लक्ष्य: Claude Code CLI setup-token (या पेस्ट किया हुआ setup-token प्रोफ़ाइल) Anthropic प्रॉम्प्ट पूरा कर सकता है, यह सत्यापित करना।
- सक्षम करें:
  - `pnpm test:live` (या यदि Vitest सीधे चला रहे हों तो `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- टोकन स्रोत (एक चुनें):
  - प्रोफ़ाइल: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - रॉ टोकन: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- मॉडल ओवरराइड (वैकल्पिक):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

सेटअप उदाहरण:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## लाइव: CLI बैकएंड स्मोक (Claude Code CLI या अन्य लोकल CLIs)

- टेस्ट: `src/gateway/gateway-cli-backend.live.test.ts`
- लक्ष्य: आपकी डिफ़ॉल्ट कॉन्फ़िग को छुए बिना, लोकल CLI बैकएंड का उपयोग करके Gateway + एजेंट पाइपलाइन को वैलिडेट करना।
- सक्षम करें:
  - `pnpm test:live` (या यदि Vitest सीधे चला रहे हों तो `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- डिफ़ॉल्ट्स:
  - मॉडल: `claude-cli/claude-sonnet-4-5`
  - कमांड: `claude`
  - आर्ग्स: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- ओवरराइड्स (वैकल्पिक):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - वास्तविक इमेज अटैचमेंट भेजने के लिए `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` (पाथ्स प्रॉम्प्ट में इंजेक्ट किए जाते हैं)।
  - इमेज फ़ाइल पाथ्स को प्रॉम्प्ट इंजेक्शन के बजाय CLI आर्ग्स के रूप में पास करने के लिए `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"`।
  - `IMAGE_ARG` सेट होने पर इमेज आर्ग्स कैसे पास हों, इसे नियंत्रित करने के लिए `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (या `"list"`)।
  - दूसरे टर्न को भेजने और रिज़्यूम फ़्लो को वैलिडेट करने के लिए `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`।
- Claude Code CLI MCP कॉन्फ़िग को सक्षम रखने के लिए `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` (डिफ़ॉल्ट एक अस्थायी खाली फ़ाइल के साथ MCP कॉन्फ़िग को अक्षम करता है)।

उदाहरण:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### अनुशंसित लाइव रेसिपीज़

सीमित, स्पष्ट allowlists सबसे तेज़ और कम अस्थिर होती हैं:

- एकल मॉडल, डायरेक्ट (gateway नहीं):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- एकल मॉडल, gateway स्मोक:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- कई प्रदाताओं में टूल कॉलिंग:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google फ़ोकस (Gemini API कुंजी + Antigravity):
  - Gemini (API कुंजी): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

नोट्स:

- `google/...` Gemini API (API कुंजी) का उपयोग करता है।
- `google-antigravity/...` Antigravity OAuth ब्रिज (Cloud Code Assist-स्टाइल एजेंट एंडपॉइंट) का उपयोग करता है।
- `google-gemini-cli/...` आपकी मशीन पर लोकल Gemini CLI का उपयोग करता है (अलग auth + tooling quirks)।
- Gemini API बनाम Gemini CLI:
  - API: OpenClaw Google के होस्टेड Gemini API को HTTP पर कॉल करता है (API कुंजी / प्रोफ़ाइल auth); अधिकांश उपयोगकर्ता “Gemini” से यही समझते हैं।
  - CLI: OpenClaw लोकल `gemini` बाइनरी को शेल करता है; इसकी अपनी auth होती है और व्यवहार अलग हो सकता है (स्ट्रीमिंग/टूल सपोर्ट/वर्ज़न स्क्यू)।

## लाइव: मॉडल मैट्रिक्स (हम क्या कवर करते हैं)

कोई स्थिर “CI मॉडल सूची” नहीं है (लाइव ऑप्ट-इन है), लेकिन ये **अनुशंसित** मॉडल हैं जिन्हें कुंजियों के साथ डेवलपर मशीन पर नियमित रूप से कवर करना चाहिए।

### आधुनिक स्मोक सेट (टूल कॉलिंग + इमेज)

यह “कॉमन मॉडल्स” रन है जिसे हम कार्यरत बनाए रखने की अपेक्षा करते हैं:

- OpenAI (नॉन-Codex): `openai/gpt-5.2` (वैकल्पिक: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (वैकल्पिक: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (या `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` और `google/gemini-3-flash-preview` (पुराने Gemini 2.x मॉडलों से बचें)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` और `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

टूल्स + इमेज के साथ gateway स्मोक चलाएँ:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### बेसलाइन: टूल कॉलिंग (Read + वैकल्पिक Exec)

प्रदाता परिवार प्रति कम से कम एक चुनें:

- OpenAI: `openai/gpt-5.2` (या `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (या `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (या `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

वैकल्पिक अतिरिक्त कवरेज (अच्छा-सा-हो):

- xAI: `xai/grok-4` (या नवीनतम उपलब्ध)
- Mistral: `mistral/`… (pick one “tools” capable model you have enabled)
- Cerebras: `cerebras/`… (if you have access)
- LM Studio: `lmstudio/`… (local; tool calling API mode पर निर्भर करता है)

### विज़न: इमेज भेजना (अटैचमेंट → मल्टीमॉडल संदेश)

Include at least one image-capable model in `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI vision-capable variants, etc.) इमेज प्रोब को अभ्यास करने के लिए।

### एग्रीगेटर्स / वैकल्पिक gateways

यदि आपके पास कुंजियाँ सक्षम हैं, तो हम इनके माध्यम से भी टेस्टिंग सपोर्ट करते हैं:

- OpenRouter: `openrouter/...` (सैकड़ों मॉडल; टूल+इमेज सक्षम उम्मीदवार खोजने के लिए `openclaw models scan` का उपयोग करें)
- OpenCode Zen: `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

लाइव मैट्रिक्स में शामिल किए जा सकने वाले और प्रदाता (यदि आपके पास क्रेड्स/कॉन्फ़िग है):

- बिल्ट-इन: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- `models.providers` के माध्यम से (कस्टम एंडपॉइंट्स): `minimax` (क्लाउड/API), साथ ही कोई भी OpenAI/Anthropic-संगत प्रॉक्सी (LM Studio, vLLM, LiteLLM, आदि)

टिप: डॉक्यूमेंट्स में “all models” को हार्डकोड करने की कोशिश न करें। प्रामाणिक सूची वही है जो `discoverModels(...)` आपकी मशीन पर लौटाता है + जो भी keys उपलब्ध हों।

## क्रेडेंशियल्स (कभी कमिट न करें)

Live tests credentials को उसी तरह discover करते हैं जैसे CLI करता है। व्यावहारिक प्रभाव:

- यदि CLI काम करता है, तो लाइव टेस्ट्स को वही कुंजियाँ मिलनी चाहिए।

- यदि कोई लाइव टेस्ट “no creds” कहता है, तो उसी तरह डिबग करें जैसे आप `openclaw models list` / मॉडल चयन को करते।

- प्रोफ़ाइल स्टोर: `~/.openclaw/credentials/` (प्राथमिक; टेस्ट्स में “प्रोफ़ाइल कुंजियाँ” का यही अर्थ है)

- कॉन्फ़िग: `~/.openclaw/openclaw.json` (या `OPENCLAW_CONFIG_PATH`)

यदि आप env कुंजियों पर निर्भर रहना चाहते हैं (जैसे आपके `~/.profile` में एक्सपोर्टेड), तो `source ~/.profile` के बाद लोकल टेस्ट्स चलाएँ, या नीचे दिए गए Docker रनर्स का उपयोग करें (वे कंटेनर में `~/.profile` माउंट कर सकते हैं)।

## Deepgram लाइव (ऑडियो ट्रांसक्रिप्शन)

- टेस्ट: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker रनर्स (वैकल्पिक “Linux में काम करता है” जाँच)

ये रेपो Docker इमेज के भीतर `pnpm test:live` चलाते हैं, आपकी लोकल कॉन्फ़िग डायरेक्टरी और वर्कस्पेस को माउंट करते हुए (और यदि माउंट किया गया हो तो `~/.profile` को सोर्स करते हुए):

- डायरेक्ट मॉडल्स: `pnpm test:docker:live-models` (स्क्रिप्ट: `scripts/test-live-models-docker.sh`)
- Gateway + dev एजेंट: `pnpm test:docker:live-gateway` (स्क्रिप्ट: `scripts/test-live-gateway-models-docker.sh`)
- ऑनबोर्डिंग विज़ार्ड (TTY, पूर्ण स्कैफ़ोल्डिंग): `pnpm test:docker:onboard` (स्क्रिप्ट: `scripts/e2e/onboard-docker.sh`)
- Gateway नेटवर्किंग (दो कंटेनर, WS auth + हेल्थ): `pnpm test:docker:gateway-network` (स्क्रिप्ट: `scripts/e2e/gateway-network-docker.sh`)
- प्लगइन्स (कस्टम एक्सटेंशन लोड + रजिस्ट्री स्मोक): `pnpm test:docker:plugins` (स्क्रिप्ट: `scripts/e2e/plugins-docker.sh`)

उपयोगी env vars:

- `OPENCLAW_CONFIG_DIR=...` (डिफ़ॉल्ट: `~/.openclaw`) को `/home/node/.openclaw` पर माउंट किया जाता है
- `OPENCLAW_WORKSPACE_DIR=...` (डिफ़ॉल्ट: `~/.openclaw/workspace`) को `/home/node/.openclaw/workspace` पर माउंट किया जाता है
- `OPENCLAW_PROFILE_FILE=...` (डिफ़ॉल्ट: `~/.profile`) को `/home/node/.profile` पर माउंट किया जाता है और टेस्ट्स चलाने से पहले सोर्स किया जाता है
- रन को सीमित करने के लिए `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...`
- यह सुनिश्चित करने के लिए `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` कि क्रेड्स प्रोफ़ाइल स्टोर से आएँ (env से नहीं)

## डॉक्स सैनीटी

डॉक्स एडिट्स के बाद डॉक्स चेक्स चलाएँ: `pnpm docs:list`।

## ऑफ़लाइन रिग्रेशन (CI-सुरक्षित)

ये “वास्तविक पाइपलाइन” रिग्रेशन हैं, बिना वास्तविक प्रदाताओं के:

- Gateway टूल कॉलिंग (mock OpenAI, वास्तविक gateway + एजेंट लूप): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway विज़ार्ड (WS `wizard.start`/`wizard.next`, कॉन्फ़िग लिखता है + auth लागू): `src/gateway/gateway.wizard.e2e.test.ts`

## एजेंट विश्वसनीयता evals (Skills)

हमारे पास पहले से कुछ CI-सुरक्षित टेस्ट्स हैं जो “एजेंट विश्वसनीयता evals” जैसे व्यवहार करते हैं:

- वास्तविक gateway + एजेंट लूप के माध्यम से mock टूल-कॉलिंग (`src/gateway/gateway.tool-calling.mock-openai.test.ts`)।
- एंड-टू-एंड विज़ार्ड फ़्लोज़ जो सत्र वायरिंग और कॉन्फ़िग प्रभावों को वैलिडेट करते हैं (`src/gateway/gateway.wizard.e2e.test.ts`)।

Skills के लिए जो अभी भी कमी है (देखें [Skills](/tools/skills)):

- **निर्णय-निर्धारण:** जब प्रॉम्प्ट में skills सूचीबद्ध हों, तो क्या एजेंट सही skill चुनता है (या अप्रासंगिक से बचता है)?
- **अनुपालन:** क्या एजेंट उपयोग से पहले `SKILL.md` पढ़ता है और आवश्यक चरणों/आर्ग्स का पालन करता है?
- **वर्कफ़्लो अनुबंध:** मल्टी-टर्न परिदृश्य जो टूल क्रम, सत्र इतिहास कैरीओवर, और sandbox सीमाओं को असर्ट करते हैं।

भविष्य के evals पहले निर्धारक बने रहने चाहिए:

- mock प्रदाताओं का उपयोग करके टूल कॉल्स + क्रम, skill फ़ाइल रीड्स, और सत्र वायरिंग असर्ट करने वाला एक परिदृश्य रनर।
- skill-केंद्रित परिदृश्यों का एक छोटा सूट (उपयोग बनाम परहेज़, गेटिंग, प्रॉम्प्ट इंजेक्शन)।
- CI-सुरक्षित सूट के स्थापित होने के बाद ही वैकल्पिक लाइव evals (opt-in, env-gated)।

## रिग्रेशन जोड़ना (मार्गदर्शन)

जब आप लाइव में खोजे गए किसी प्रदाता/मॉडल मुद्दे को ठीक करते हैं:

- यदि संभव हो तो CI-सुरक्षित रिग्रेशन जोड़ें (प्रदाता को mock/stub करें, या सटीक request-shape ट्रांसफ़ॉर्मेशन कैप्चर करें)
- यदि यह स्वभावतः केवल लाइव है (रेट लिमिट्स, auth नीतियाँ), तो लाइव टेस्ट को संकीर्ण रखें और env vars के माध्यम से opt-in करें
- उस सबसे छोटे लेयर को लक्षित करना पसंद करें जो बग पकड़ता है:
  - प्रदाता request conversion/replay बग → डायरेक्ट मॉडल्स टेस्ट
  - gateway सत्र/इतिहास/टूल पाइपलाइन बग → gateway लाइव स्मोक या CI-सुरक्षित gateway mock टेस्ट
