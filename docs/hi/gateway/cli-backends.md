---
summary: "CLI बैकएंड्स: स्थानीय AI CLI के माध्यम से केवल-पाठ फ़ॉलबैक"
read_when:
  - आप चाहते हैं कि API प्रदाता विफल होने पर एक विश्वसनीय फ़ॉलबैक उपलब्ध हो
  - आप Claude Code CLI या अन्य स्थानीय AI CLI चला रहे हैं और उन्हें पुनः उपयोग करना चाहते हैं
  - आपको एक केवल-पाठ, टूल-रहित मार्ग चाहिए जो फिर भी सत्रों और छवियों का समर्थन करता हो
title: "CLI बैकएंड्स"
x-i18n:
  source_path: gateway/cli-backends.md
  source_hash: 8285f4829900bc81
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:26Z
---

# CLI बैकएंड्स (फ़ॉलबैक रनटाइम)

OpenClaw **स्थानीय AI CLI** को **केवल-पाठ फ़ॉलबैक** के रूप में चला सकता है जब API प्रदाता डाउन हों,
रेट-सीमित हों, या अस्थायी रूप से ठीक से व्यवहार न कर रहे हों। यह जानबूझकर रूढ़िवादी है:

- **टूल्स अक्षम हैं** (कोई टूल कॉल नहीं)।
- **पाठ इन → पाठ आउट** (विश्वसनीय)।
- **सत्र समर्थित हैं** (ताकि फ़ॉलो-अप टर्न सुसंगत रहें)।
- **छवियाँ पास-थ्रू की जा सकती हैं** यदि CLI छवि पथ स्वीकार करता हो।

इसे प्राथमिक मार्ग के बजाय एक **सुरक्षा-जाल** के रूप में डिज़ाइन किया गया है। इसका उपयोग तब करें जब
आप बाहरी API पर निर्भर किए बिना “हमेशा काम करता है” पाठ प्रतिक्रियाएँ चाहते हों।

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

बस इतना ही। CLI के अलावा किसी कुंजी या अतिरिक्त प्रमाणीकरण विन्यास की आवश्यकता नहीं है।

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

प्रत्येक प्रविष्टि एक **provider id** द्वारा कुंजीबद्ध होती है (उदा. `claude-cli`, `my-cli`)।
provider id आपके मॉडल संदर्भ के बाएँ भाग के रूप में उपयोग होता है:

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

- यदि CLI सत्रों का समर्थन करता है, तो `sessionArg` सेट करें (उदा. `--session-id`) या
  `sessionArgs` (प्लेसहोल्डर `{sessionId}`) जब आईडी को कई फ़्लैग्स में डालने की आवश्यकता हो।
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

OpenClaw base64 छवियों को अस्थायी फ़ाइलों में लिखेगा। यदि `imageArg` सेट है, तो वे
पथ CLI आर्ग्स के रूप में पास किए जाते हैं। यदि `imageArg` अनुपस्थित है, तो OpenClaw
फ़ाइल पथों को प्रॉम्प्ट में जोड़ देता है (path injection), जो उन CLI के लिए पर्याप्त है
जो सादे पथों से स्थानीय फ़ाइलों को स्वतः लोड करते हैं (Claude Code CLI का व्यवहार)।

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

- **कोई OpenClaw टूल्स नहीं** (CLI बैकएंड को कभी टूल कॉल प्राप्त नहीं होते)। कुछ CLI
  अपने स्वयं के एजेंट टूलिंग चला सकते हैं।
- **स्ट्रीमिंग नहीं** (CLI आउटपुट एकत्र किया जाता है और फिर लौटाया जाता है)।
- **संरचित आउटपुट** CLI के JSON प्रारूप पर निर्भर करते हैं।
- **Codex CLI सत्र** पाठ आउटपुट के माध्यम से resume होते हैं (कोई JSONL नहीं), जो
  प्रारंभिक `--json` रन की तुलना में कम संरचित है। OpenClaw सत्र फिर भी सामान्य रूप से काम करते हैं।

## समस्या-निवारण

- **CLI नहीं मिला**: `command` को पूर्ण पथ पर सेट करें।
- **गलत मॉडल नाम**: `modelAliases` का उपयोग करके `provider/model` → CLI मॉडल मैप करें।
- **सत्र निरंतरता नहीं**: सुनिश्चित करें कि `sessionArg` सेट है और `sessionMode`
  `none` नहीं है (Codex CLI वर्तमान में JSON आउटपुट के साथ resume नहीं कर सकता)।
- **छवियाँ अनदेखी की जा रही हैं**: `imageArg` सेट करें (और सत्यापित करें कि CLI फ़ाइल पथों का समर्थन करता है)।
