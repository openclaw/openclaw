---
summary: "CLI बैकएंड्स: स्थानीय AI CLI के माध्यम से केवल-पाठ फ़ॉलबैक"
read_when:
  - आप चाहते हैं कि API प्रदाता विफल होने पर एक विश्वसनीय फ़ॉलबैक उपलब्ध हो
  - आप Claude Code CLI या अन्य स्थानीय AI CLI चला रहे हैं और उन्हें पुनः उपयोग करना चाहते हैं
  - आपको एक केवल-पाठ, टूल-रहित मार्ग चाहिए जो फिर भी सत्रों और छवियों का समर्थन करता हो
title: "CLI बैकएंड्स"
---

# CLI बैकएंड्स (फ़ॉलबैक रनटाइम)

36. OpenClaw **local AI CLIs** को **text‑only fallback** के रूप में चला सकता है जब API providers डाउन हों, rate‑limited हों, या अस्थायी रूप से गलत व्यवहार कर रहे हों। 37. यह जानबूझकर conservative है:

- **टूल्स अक्षम हैं** (कोई टूल कॉल नहीं)।
- **पाठ इन → पाठ आउट** (विश्वसनीय)।
- **सत्र समर्थित हैं** (ताकि फ़ॉलो-अप टर्न सुसंगत रहें)।
- **छवियाँ पास-थ्रू की जा सकती हैं** यदि CLI छवि पथ स्वीकार करता हो।

38. इसे primary path के बजाय एक **safety net** के रूप में डिज़ाइन किया गया है। 39. इसका उपयोग तब करें जब आप बाहरी APIs पर निर्भर किए बिना “always works” टेक्स्ट प्रतिक्रियाएँ चाहते हों।

## शुरुआती-अनुकूल त्वरित प्रारंभ

आप Claude Code CLI का उपयोग **बिना किसी विन्यास** के कर सकते हैं (OpenClaw एक अंतर्निहित डिफ़ॉल्ट प्रदान करता है):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI भी तुरंत काम करता है:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

यदि आपका Gateway launchd/systemd के अंतर्गत चलता है और PATH न्यूनतम है, तो केवल
कमांड पथ जोड़ें:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

40. बस इतना ही। 41. कोई keys नहीं, CLI के अलावा किसी अतिरिक्त auth config की आवश्यकता नहीं।

## इसे फ़ॉलबैक के रूप में उपयोग करना

अपने फ़ॉलबैक सूची में एक CLI बैकएंड जोड़ें ताकि यह केवल तब चले जब प्राथमिक मॉडल विफल हों:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

टिप्पणियाँ:

- यदि आप `agents.defaults.models` (allowlist) का उपयोग करते हैं, तो आपको `claude-cli/...` शामिल करना होगा।
- यदि प्राथमिक प्रदाता विफल होता है (प्रमाणीकरण, रेट सीमाएँ, टाइमआउट), तो OpenClaw
  अगला प्रयास CLI बैकएंड के साथ करेगा।

## विन्यास अवलोकन

सभी CLI बैकएंड यहाँ स्थित होते हैं:

```
agents.defaults.cliBackends
```

42. प्रत्येक entry एक **provider id** द्वारा keyed होती है (उदाहरण: `claude-cli`, `my-cli`)।
43. provider id आपके model ref के बाएँ हिस्से में बदल जाता है:

```
<provider>/<model>
```

### उदाहरण विन्यास

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## यह कैसे काम करता है

1. **एक बैकएंड चुनता है** provider प्रीफ़िक्स के आधार पर (`claude-cli/...`)।
2. **सिस्टम प्रॉम्प्ट बनाता है** वही OpenClaw प्रॉम्प्ट + वर्कस्पेस संदर्भ उपयोग करके।
3. **CLI निष्पादित करता है** एक सत्र आईडी के साथ (यदि समर्थित हो) ताकि इतिहास सुसंगत रहे।
4. **आउटपुट पार्स करता है** (JSON या सादा पाठ) और अंतिम पाठ लौटाता है।
5. **सत्र आईडी सहेजता है** प्रति बैकएंड, ताकि फ़ॉलो-अप उसी CLI सत्र का पुनः उपयोग करें।

## सत्र

- 44. यदि CLI sessions का समर्थन करता है, तो `sessionArg` (उदाहरण: `--session-id`) या
      `sessionArgs` (placeholder `{sessionId}`) सेट करें जब ID को कई flags में insert करना हो।
- यदि CLI अलग फ़्लैग्स के साथ **resume सबकमांड** का उपयोग करता है, तो
  `resumeArgs` सेट करें (resume करते समय `args` को प्रतिस्थापित करता है) और वैकल्पिक रूप से `resumeOutput`
  (गैर-JSON resume के लिए)।
- `sessionMode`:
  - `always`: हमेशा एक सत्र आईडी भेजें (यदि कोई संग्रहीत न हो तो नया UUID)।
  - `existing`: केवल तभी सत्र आईडी भेजें जब पहले से कोई संग्रहीत हो।
  - `none`: कभी भी सत्र आईडी न भेजें।

## छवियाँ (पास-थ्रू)

यदि आपका CLI छवि पथ स्वीकार करता है, तो `imageArg` सेट करें:

```json5
imageArg: "--image",
imageMode: "repeat"
```

45. OpenClaw base64 images को temp files में लिखेगा। 46. यदि `imageArg` सेट है, तो वे
    paths CLI args के रूप में पास किए जाते हैं। 47. यदि `imageArg` मौजूद नहीं है, तो OpenClaw
    file paths को prompt में append करता है (path injection), जो उन CLIs के लिए पर्याप्त है जो plain paths से local files को auto‑load करते हैं (Claude Code CLI का व्यवहार)।

## इनपुट / आउटपुट

- `output: "json"` (डिफ़ॉल्ट) JSON पार्स करने का प्रयास करता है और पाठ + सत्र आईडी निकालता है।
- `output: "jsonl"` JSONL स्ट्रीम पार्स करता है (Codex CLI `--json`) और
  अंतिम एजेंट संदेश के साथ `thread_id` निकालता है जब उपलब्ध हो।
- `output: "text"` stdout को अंतिम प्रतिक्रिया मानता है।

इनपुट मोड:

- `input: "arg"` (डिफ़ॉल्ट) प्रॉम्प्ट को अंतिम CLI आर्ग के रूप में पास करता है।
- `input: "stdin"` stdin के माध्यम से प्रॉम्प्ट भेजता है।
- यदि प्रॉम्प्ट बहुत लंबा है और `maxPromptArgChars` सेट है, तो stdin का उपयोग किया जाता है।

## डिफ़ॉल्ट्स (अंतर्निहित)

OpenClaw `claude-cli` के लिए एक डिफ़ॉल्ट प्रदान करता है:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw `codex-cli` के लिए भी एक डिफ़ॉल्ट प्रदान करता है:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

केवल आवश्यकता होने पर ही ओवरराइड करें (सामान्य: पूर्ण `command` पथ)।

## सीमाएँ

- 48. **कोई OpenClaw tools नहीं** (CLI backend को कभी tool calls नहीं मिलते)। 49. कुछ CLIs
      अभी भी अपना स्वयं का agent tooling चला सकते हैं।
- **स्ट्रीमिंग नहीं** (CLI आउटपुट एकत्र किया जाता है और फिर लौटाया जाता है)।
- **संरचित आउटपुट** CLI के JSON प्रारूप पर निर्भर करते हैं।
- 50. **Codex CLI sessions** टेक्स्ट आउटपुट के माध्यम से resume होते हैं (कोई JSONL नहीं), जो प्रारंभिक `--json` रन की तुलना में कम structured होता है। 1. OpenClaw सेशंस अभी भी
      सामान्य रूप से काम करते हैं।

## समस्या-निवारण

- **CLI नहीं मिला**: `command` को पूर्ण पथ पर सेट करें।
- **गलत मॉडल नाम**: `modelAliases` का उपयोग करके `provider/model` → CLI मॉडल मैप करें।
- **सत्र निरंतरता नहीं**: सुनिश्चित करें कि `sessionArg` सेट है और `sessionMode`
  `none` नहीं है (Codex CLI वर्तमान में JSON आउटपुट के साथ resume नहीं कर सकता)।
- **छवियाँ अनदेखी की जा रही हैं**: `imageArg` सेट करें (और सत्यापित करें कि CLI फ़ाइल पथों का समर्थन करता है)।
