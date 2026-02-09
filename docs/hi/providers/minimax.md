---
summary: "OpenClaw में MiniMax M2.1 का उपयोग करें"
read_when:
  - आप OpenClaw में MiniMax मॉडल चाहते हैं
  - आपको MiniMax सेटअप मार्गदर्शन की आवश्यकता है
title: "MiniMax"
---

# MiniMax

MiniMax is an AI company that builds the **M2/M2.1** model family. The current
coding-focused release is **MiniMax M2.1** (December 23, 2025), built for
real-world complex tasks.

स्रोत: [MiniMax M2.1 रिलीज़ नोट](https://www.minimax.io/news/minimax-m21)

## मॉडल अवलोकन (M2.1)

MiniMax ने M2.1 में इन सुधारों को उजागर किया है:

- अधिक मजबूत **बहु-भाषा कोडिंग** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS)।
- बेहतर **वेब/ऐप विकास** और सौंदर्य आउटपुट गुणवत्ता (नेटिव मोबाइल सहित)।
- कार्यालय-शैली वर्कफ़्लो के लिए **समग्र निर्देश** हैंडलिंग में सुधार, जो
  इंटरलीव्ड थिंकिंग और एकीकृत बाधा निष्पादन पर आधारित है।
- **अधिक संक्षिप्त प्रतिक्रियाएँ**, कम टोकन उपयोग और तेज़ पुनरावृत्ति लूप।
- **टूल/एजेंट फ़्रेमवर्क** संगतता और संदर्भ प्रबंधन में सुधार (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox)।
- उच्च-गुणवत्ता वाले **संवाद और तकनीकी लेखन** आउटपुट।

## MiniMax M2.1 बनाम MiniMax M2.1 Lightning

- **गति:** Lightning, MiniMax के मूल्य निर्धारण दस्तावेज़ों में “तेज़” वैरिएंट है।
- **लागत:** मूल्य निर्धारण में समान इनपुट लागत दिखाई गई है, लेकिन Lightning की आउटपुट लागत अधिक है।
- **Coding plan routing:** The Lightning back-end isn’t directly available on the MiniMax
  coding plan. MiniMax auto-routes most requests to Lightning, but falls back to the
  regular M2.1 back-end during traffic spikes.

## सेटअप चुनें

### MiniMax OAuth (कोडिंग प्लान) — अनुशंसित

**के लिए सर्वोत्तम:** OAuth के माध्यम से MiniMax कोडिंग प्लान के साथ त्वरित सेटअप, API कुंजी की आवश्यकता नहीं।

बंडल्ड OAuth प्लगइन सक्षम करें और प्रमाणीकरण करें:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

आपसे एक एंडपॉइंट चुनने के लिए कहा जाएगा:

- **Global** - अंतरराष्ट्रीय उपयोगकर्ता (`api.minimax.io`)
- **CN** - चीन में उपयोगकर्ता (`api.minimaxi.com`)

विवरण के लिए [MiniMax OAuth प्लगइन README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) देखें।

### MiniMax M2.1 (API कुंजी)

**के लिए सर्वोत्तम:** Anthropic-संगत API के साथ होस्टेड MiniMax।

CLI के माध्यम से विन्यास करें:

- `openclaw configure` चलाएँ
- **Model/auth** चुनें
- **MiniMax M2.1** चुनें

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 को फ़ॉलबैक के रूप में (Opus प्राथमिक)

**के लिए सर्वोत्तम:** Opus 4.6 को प्राथमिक रखें, और MiniMax M2.1 पर फ़ेलओवर करें।

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### वैकल्पिक: LM Studio के माध्यम से स्थानीय (मैनुअल)

**Best for:** local inference with LM Studio.
We have seen strong results with MiniMax M2.1 on powerful hardware (e.g. a
desktop/server) using LM Studio's local server.

`openclaw.json` के माध्यम से मैनुअल रूप से विन्यास करें:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## `openclaw configure` के माध्यम से विन्यास करें

JSON संपादित किए बिना MiniMax सेट करने के लिए इंटरैक्टिव कॉन्फ़िग विज़ार्ड का उपयोग करें:

1. `openclaw configure` चलाएँ।
2. **Model/auth** चुनें।
3. **MiniMax M2.1** चुनें।
4. संकेत मिलने पर अपना डिफ़ॉल्ट मॉडल चुनें।

## विन्यास विकल्प

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` (Anthropic-संगत) को प्राथमिकता दें; OpenAI-संगत पेलोड के लिए `https://api.minimax.io/v1` वैकल्पिक है।
- `models.providers.minimax.api`: `anthropic-messages` को प्राथमिकता दें; OpenAI-संगत पेलोड के लिए `openai-completions` वैकल्पिक है।
- `models.providers.minimax.apiKey`: MiniMax API कुंजी (`MINIMAX_API_KEY`)।
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` परिभाषित करें।
- `agents.defaults.models`: allowlist में जिन मॉडलों की आवश्यकता हो, उनके लिए उपनाम।
- `models.mode`: यदि आप MiniMax को बिल्ट-इन के साथ जोड़ना चाहते हैं, तो `merge` बनाए रखें।

## नोट्स

- मॉडल संदर्भ `minimax/<model>` हैं।
- कोडिंग प्लान उपयोग API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (कोडिंग प्लान कुंजी आवश्यक)।
- यदि आपको सटीक लागत ट्रैकिंग चाहिए, तो `models.json` में मूल्य निर्धारण मान अपडेट करें।
- MiniMax कोडिंग प्लान के लिए रेफ़रल लिंक (10% छूट): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- प्रदाता नियमों के लिए [/concepts/model-providers](/concepts/model-providers) देखें।
- स्विच करने के लिए `openclaw models list` और `openclaw models set minimax/MiniMax-M2.1` का उपयोग करें।

## समस्या-निवारण

### “Unknown model: minimax/MiniMax-M2.1”

This usually means the **MiniMax provider isn’t configured** (no provider entry
and no MiniMax auth profile/env key found). A fix for this detection is in
**2026.1.12** (unreleased at the time of writing). Fix by:

- **2026.1.12** में अपग्रेड करें (या स्रोत से `main` चलाएँ), फिर Gateway को पुनः प्रारंभ करें।
- `openclaw configure` चलाएँ और **MiniMax M2.1** चुनें, या
- `models.providers.minimax` ब्लॉक को मैनुअल रूप से जोड़ें, या
- `MINIMAX_API_KEY` (या MiniMax auth प्रोफ़ाइल) सेट करें ताकि प्रदाता इंजेक्ट किया जा सके।

सुनिश्चित करें कि मॉडल आईडी **केस‑संवेदी** है:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

फिर पुनः जाँच करें:

```bash
openclaw models list
```
