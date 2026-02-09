---
summary: "OpenProse: OpenClaw में .prose वर्कफ़्लो, स्लैश कमांड, और स्टेट"
read_when:
  - आप .prose वर्कफ़्लो चलाना या लिखना चाहते हैं
  - आप OpenProse प्लगइन सक्षम करना चाहते हैं
  - आपको स्टेट स्टोरेज समझने की आवश्यकता है
title: "OpenProse"
---

# OpenProse

OpenProse is a portable, markdown-first workflow format for orchestrating AI sessions. In OpenClaw it ships as a plugin that installs an OpenProse skill pack plus a `/prose` slash command. Programs live in `.prose` files and can spawn multiple sub-agents with explicit control flow.

आधिकारिक साइट: [https://www.prose.md](https://www.prose.md)

## यह क्या कर सकता है

- स्पष्ट समानांतरता के साथ बहु-एजेंट अनुसंधान + संश्लेषण।
- दोहराने योग्य, अनुमोदन-सुरक्षित वर्कफ़्लो (कोड समीक्षा, घटना ट्रायेज, सामग्री पाइपलाइंस)।
- पुन: उपयोग योग्य `.prose` प्रोग्राम जिन्हें आप समर्थित एजेंट रनटाइम्स में चला सकते हैं।

## इंस्टॉल + सक्षम करें

Bundled plugins are disabled by default. Enable OpenProse:

```bash
openclaw plugins enable open-prose
```

प्लगइन सक्षम करने के बाद Gateway को पुनः प्रारंभ करें।

डेव/लोकल चेकआउट: `openclaw plugins install ./extensions/open-prose`

संबंधित दस्तावेज़: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## स्लैश कमांड

OpenProse registers `/prose` as a user-invocable skill command. It routes to the OpenProse VM instructions and uses OpenClaw tools under the hood.

सामान्य कमांड:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## उदाहरण: एक सरल `.prose` फ़ाइल

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## फ़ाइल स्थान

OpenProse आपके वर्कस्पेस में `.prose/` के अंतर्गत स्टेट रखता है:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

उपयोगकर्ता-स्तर के स्थायी एजेंट यहाँ रहते हैं:

```
~/.prose/agents/
```

## स्टेट मोड्स

OpenProse कई स्टेट बैकएंड्स का समर्थन करता है:

- **filesystem** (डिफ़ॉल्ट): `.prose/runs/...`
- **in-context**: क्षणिक, छोटे प्रोग्रामों के लिए
- **sqlite** (प्रायोगिक): `sqlite3` बाइनरी की आवश्यकता
- **postgres** (प्रायोगिक): `psql` और एक कनेक्शन स्ट्रिंग की आवश्यकता

टिप्पणियाँ:

- sqlite/postgres वैकल्पिक हैं और प्रायोगिक हैं।
- postgres क्रेडेंशियल्स उप-एजेंट लॉग्स में प्रवाहित होते हैं; एक समर्पित, न्यूनतम-अधिकार DB का उपयोग करें।

## रिमोट प्रोग्राम

`/prose run <handle/slug>` resolves to `https://p.prose.md/<handle>/<slug>`.
Direct URLs are fetched as-is. This uses the `web_fetch` tool (or `exec` for POST).

## OpenClaw रनटाइम मैपिंग

OpenProse प्रोग्राम OpenClaw प्रिमिटिव्स से मैप होते हैं:

| OpenProse अवधारणा         | OpenClaw टूल     |
| ------------------------- | ---------------- |
| Spawn session / Task tool | `sessions_spawn` |
| फ़ाइल पढ़ना/लिखना         | `read` / `write` |
| वेब फ़ेच                  | `web_fetch`      |

If your tool allowlist blocks these tools, OpenProse programs will fail. See [Skills config](/tools/skills-config).

## सुरक्षा + अनुमोदन

Treat `.prose` files like code. Review before running. Use OpenClaw tool allowlists and approval gates to control side effects.

निर्धारक, अनुमोदन-गेटेड वर्कफ़्लो के लिए, [Lobster](/tools/lobster) से तुलना करें।
