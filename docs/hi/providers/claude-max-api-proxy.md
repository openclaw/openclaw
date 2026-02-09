---
summary: "Claude Max/Pro सब्सक्रिप्शन को OpenAI-संगत API एंडपॉइंट के रूप में उपयोग करें"
read_when:
  - आप OpenAI-संगत टूल्स के साथ Claude Max सब्सक्रिप्शन का उपयोग करना चाहते हैं
  - आप Claude Code CLI को रैप करने वाला एक स्थानीय API सर्वर चाहते हैं
  - आप API कुंजियों के बजाय सब्सक्रिप्शन का उपयोग करके पैसे बचाना चाहते हैं
title: "Claude Max API प्रॉक्सी"
---

# Claude Max API प्रॉक्सी

**claude-max-api-proxy** is a community tool that exposes your Claude Max/Pro subscription as an OpenAI-compatible API endpoint. This allows you to use your subscription with any tool that supports the OpenAI API format.

## इसका उपयोग क्यों करें?

| तरीका                   | लागत                                                                                          | किसके लिए उपयुक्त                    |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| Anthropic API           | प्रति टोकन भुगतान (~$15/M इनपुट, $75/M आउटपुट Opus के लिए) | प्रोडक्शन ऐप्स, उच्च मात्रा          |
| Claude Max सब्सक्रिप्शन | $200/माह फ्लैट                                                                                | व्यक्तिगत उपयोग, विकास, असीमित उपयोग |

यदि आपके पास Claude Max सब्सक्रिप्शन है और आप इसे OpenAI-संगत टूल्स के साथ उपयोग करना चाहते हैं, तो यह प्रॉक्सी आपको उल्लेखनीय रूप से पैसे बचा सकता है।

## यह कैसे काम करता है

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

यह प्रॉक्सी:

1. `http://localhost:3456/v1/chat/completions` पर OpenAI-फ़ॉर्मेट अनुरोध स्वीकार करता है
2. उन्हें Claude Code CLI कमांड्स में परिवर्तित करता है
3. OpenAI फ़ॉर्मेट में प्रतिक्रियाएँ लौटाता है (स्ट्रीमिंग समर्थित)

## इंस्टॉलेशन

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## उपयोग

### सर्वर शुरू करें

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### परीक्षण करें

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw के साथ

आप OpenClaw को एक कस्टम OpenAI-संगत एंडपॉइंट के रूप में इस प्रॉक्सी की ओर निर्देशित कर सकते हैं:

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## उपलब्ध मॉडल

| मॉडल ID           | मैप होता है     |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS पर ऑटो-स्टार्ट

प्रॉक्सी को स्वचालित रूप से चलाने के लिए एक LaunchAgent बनाएँ:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## लिंक

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## टिप्पणियाँ

- यह एक **समुदाय द्वारा बनाया गया टूल** है, जिसे Anthropic या OpenClaw द्वारा आधिकारिक समर्थन प्राप्त नहीं है
- Claude Code CLI के साथ प्रमाणीकृत एक सक्रिय Claude Max/Pro सब्सक्रिप्शन आवश्यक है
- प्रॉक्सी स्थानीय रूप से चलता है और किसी भी तृतीय-पक्ष सर्वर को डेटा नहीं भेजता
- स्ट्रीमिंग प्रतिक्रियाएँ पूर्ण रूप से समर्थित हैं

## यह भी देखें

- [Anthropic provider](/providers/anthropic) - setup-token या API कुंजियों के साथ Claude के लिए नेटिव OpenClaw एकीकरण
- [OpenAI provider](/providers/openai) - OpenAI/Codex सब्सक्रिप्शन के लिए
