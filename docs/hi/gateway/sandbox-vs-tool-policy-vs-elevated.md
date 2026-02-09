---
title: Sandbox बनाम Tool Policy बनाम Elevated
summary: "किस कारण कोई टूल ब्लॉक होता है: sandbox runtime, टूल allow/deny नीति, और elevated exec गेट्स"
read_when: "जब आप 'sandbox jail' में फँसें या किसी tool/elevated अस्वीकृति को देखें और बदलने के लिए सटीक config key जानना चाहें।"
status: active
---

# Sandbox बनाम Tool Policy बनाम Elevated

OpenClaw में तीन संबंधित (लेकिन अलग-अलग) नियंत्रण हैं:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) यह तय करता है कि **टूल कहाँ चलते हैं** (Docker बनाम होस्ट)।
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) यह तय करता है कि **कौन-से टूल उपलब्ध/अनुमत हैं**।
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) एक **केवल-exec एस्केप हैच** है, जिससे sandbox में होने पर होस्ट पर चलाया जा सके।

## त्वरित डिबग

OpenClaw वास्तव में क्या कर रहा है, यह देखने के लिए inspector का उपयोग करें:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

यह प्रिंट करता है:

- प्रभावी sandbox मोड/स्कोप/वर्कस्पेस एक्सेस
- क्या सत्र वर्तमान में sandboxed है (main बनाम non-main)
- प्रभावी sandbox टूल allow/deny (और क्या यह agent/global/default से आया है)
- elevated गेट्स और fix-it key पाथ्स

## Sandbox: टूल कहाँ चलते हैं

Sandboxing को `agents.defaults.sandbox.mode` द्वारा नियंत्रित किया जाता है:

- `"off"`: सब कुछ होस्ट पर चलता है।
- `"non-main"`: केवल non-main सत्र sandboxed होते हैं (समूह/चैनलों के लिए आम “सरप्राइज़”)।
- `"all"`: सब कुछ sandboxed होता है।

पूर्ण मैट्रिक्स (स्कोप, वर्कस्पेस माउंट्स, इमेजेज) के लिए [Sandboxing](/gateway/sandboxing) देखें।

### Bind mounts (सुरक्षा त्वरित जाँच)

- `docker.binds` sandbox फ़ाइलसिस्टम को _भेद_ देता है: जो भी आप माउंट करते हैं, वह कंटेनर के भीतर आपके सेट किए गए मोड (`:ro` या `:rw`) के साथ दिखाई देता है।
- यदि आप मोड छोड़ देते हैं तो डिफ़ॉल्ट read-write होता है; स्रोत/सीक्रेट्स के लिए `:ro` को प्राथमिकता दें।
- `scope: "shared"` प्रति-एजेंट बाइंड्स को अनदेखा करता है (केवल ग्लोबल बाइंड्स लागू होते हैं)।
- `/var/run/docker.sock` को बाइंड करना प्रभावी रूप से sandbox को होस्ट नियंत्रण दे देता है; यह केवल जानबूझकर करें।
- वर्कस्पेस एक्सेस (`workspaceAccess: "ro"`/`"rw"`) बाइंड मोड्स से स्वतंत्र है।

## Tool policy: कौन-से टूल मौजूद/कॉल किए जा सकते हैं

दो लेयर महत्वपूर्ण हैं:

- **Tool profile**: `tools.profile` और `agents.list[].tools.profile` (बेस allowlist)
- **Provider tool profile**: `tools.byProvider[provider].profile` और `agents.list[].tools.byProvider[provider].profile`
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` और `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` और `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox tool policy** (केवल sandboxed होने पर लागू): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` और `agents.list[].tools.sandbox.tools.*`

अनुभवजन्य नियम:

- `deny` हमेशा जीतता है।
- यदि `allow` खाली नहीं है, तो बाकी सब कुछ ब्लॉक माना जाता है।
- Tool policy अंतिम रोक है: `/exec` किसी अस्वीकृत `exec` टूल को ओवरराइड नहीं कर सकता।
- `/exec` केवल अधिकृत senders के लिए session defaults बदलता है; यह tool access प्रदान नहीं करता।
  Provider tool keys `provider` (जैसे `google-antigravity`) या `provider/model` (जैसे `openai/gpt-5.2`) दोनों स्वीकार करते हैं।

### Tool groups (शॉर्टहैंड)

Tool policies (global, agent, sandbox) `group:*` प्रविष्टियों का समर्थन करती हैं, जो कई टूल्स में विस्तारित होती हैं:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

उपलब्ध समूह:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: सभी बिल्ट-इन OpenClaw टूल्स (provider plugins शामिल नहीं)

## Elevated: केवल-exec “होस्ट पर चलाएँ”

Elevated अतिरिक्त टूल्स प्रदान **नहीं** करता; यह केवल `exec` को प्रभावित करता है।

- यदि आप sandboxed हैं, तो `/elevated on` (या `exec` के साथ `elevated: true`) होस्ट पर चलता है (अनुमोदन अभी भी लागू हो सकता है)।
- सत्र के लिए exec अनुमोदन छोड़ने हेतु `/elevated full` का उपयोग करें।
- यदि आप पहले से direct चल रहे हैं, तो elevated प्रभावी रूप से no-op है (फिर भी gated)।
- Elevated **skill-scoped नहीं** है और टूल allow/deny को **ओवरराइड नहीं** करता।
- `/exec` elevated से अलग है। यह केवल अधिकृत senders के लिए प्रति-session exec defaults समायोजित करता है।

गेट्स:

- Enablement: `tools.elevated.enabled` (और वैकल्पिक रूप से `agents.list[].tools.elevated.enabled`)
- Sender allowlists: `tools.elevated.allowFrom.<provider>`` (और वैकल्पिक रूप से `agents.list[].tools.elevated.allowFrom.<provider>\`\`)\`

देखें [Elevated Mode](/tools/elevated)।

## सामान्य “sandbox jail” सुधार

### “Tool X sandbox tool policy द्वारा ब्लॉक किया गया”

Fix-it कुंजियाँ (एक चुनें):

- Sandbox अक्षम करें: `agents.defaults.sandbox.mode=off` (या प्रति-एजेंट `agents.list[].sandbox.mode=off`)
- Sandbox के भीतर टूल को अनुमति दें:
  - इसे `tools.sandbox.tools.deny` से हटाएँ (या प्रति-एजेंट `agents.list[].tools.sandbox.tools.deny`)
  - या इसे `tools.sandbox.tools.allow` में जोड़ें (या प्रति-एजेंट allow)

### “मुझे लगा यह main है, फिर यह sandboxed क्यों है?”

`"non-main"` मोड में, group/channel keys _main_ नहीं होते। मुख्य session key का उपयोग करें (`sandbox explain` द्वारा दिखाया गया) या मोड को `"off"` पर स्विच करें।
