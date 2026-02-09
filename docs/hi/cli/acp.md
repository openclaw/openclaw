---
summary: "IDE एकीकरणों के लिए ACP ब्रिज चलाएँ"
read_when:
  - ACP-आधारित IDE एकीकरण सेट करते समय
  - Gateway तक ACP सत्र रूटिंग का डिबग करते समय
title: "acp"
---

# acp

ACP (Agent Client Protocol) ब्रिज चलाएँ जो OpenClaw Gateway से संवाद करता है।

यह कमांड IDEs के लिए stdio पर ACP बोलता है और प्रॉम्प्ट्स को WebSocket के माध्यम से Gateway तक अग्रेषित करता है
। यह ACP सत्रों को Gateway सत्र कुंजियों से मैप रखता है।

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## ACP client (debug)

IDE के बिना ब्रिज की जाँच के लिए बिल्ट-इन ACP क्लाइंट का उपयोग करें।
यह ACP ब्रिज शुरू करता है और आपको इंटरैक्टिव रूप से प्रॉम्प्ट टाइप करने देता है।

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## How to use this

ACP का उपयोग तब करें जब कोई IDE (या अन्य क्लाइंट) Agent Client Protocol बोलता हो और आप उससे OpenClaw Gateway सत्र को ड्राइव कराना चाहते हों।

1. सुनिश्चित करें कि Gateway चल रहा है (स्थानीय या दूरस्थ)।
2. Gateway लक्ष्य को कॉन्फ़िगर करें (विन्यास या फ़्लैग्स)।
3. अपने IDE को stdio पर `openclaw acp` चलाने के लिए इंगित करें।

उदाहरण विन्यास (स्थायी):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

उदाहरण प्रत्यक्ष रन (कोई विन्यास लिखे बिना):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selecting agents

ACP सीधे एजेंट्स का चयन नहीं करता। यह Gateway सत्र कुंजी द्वारा रूट करता है।

किसी विशिष्ट एजेंट को लक्षित करने के लिए एजेंट-स्कोप्ड सत्र कुंजियों का उपयोग करें:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

प्रत्येक ACP सत्र एकल Gateway सत्र कुंजी से मैप होता है। एक एजेंट के कई सत्र हो सकते हैं;
ACP डिफ़ॉल्ट रूप से एक पृथक `acp:<uuid>` सत्र का उपयोग करता है जब तक आप
कुंजी या लेबल को ओवरराइड न करें।

## Zed editor setup

`~/.config/zed/settings.json` में एक कस्टम ACP एजेंट जोड़ें (या Zed के Settings UI का उपयोग करें):

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

किसी विशिष्ट Gateway या एजेंट को लक्षित करने के लिए:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

Zed में, Agent पैनल खोलें और एक थ्रेड शुरू करने के लिए “OpenClaw ACP” चुनें।

## Session mapping

डिफ़ॉल्ट रूप से, ACP सत्रों को `acp:` उपसर्ग के साथ एक पृथक Gateway सत्र कुंजी मिलती है।
किसी ज्ञात सत्र का पुन: उपयोग करने के लिए, एक सत्र कुंजी या लेबल पास करें:

- `--session <key>`: एक विशिष्ट Gateway सत्र कुंजी का उपयोग करें।
- `--session-label <label>`: लेबल द्वारा किसी मौजूदा सत्र को रेज़ॉल्व करें।
- `--reset-session`: उस कुंजी के लिए एक नया सत्र आईडी बनाएँ (वही कुंजी, नया ट्रांसक्रिप्ट)।

यदि आपका ACP क्लाइंट मेटाडेटा का समर्थन करता है, तो आप प्रति सत्र ओवरराइड कर सकते हैं:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

सत्र कुंजियों के बारे में अधिक जानें: [/concepts/session](/concepts/session)।

## Options

- `--url <url>`: Gateway WebSocket URL (कॉन्फ़िगर होने पर gateway.remote.url का डिफ़ॉल्ट)।
- `--token <token>`: Gateway प्रमाणीकरण टोकन।
- `--password <password>`: Gateway प्रमाणीकरण पासवर्ड।
- `--session <key>`: डिफ़ॉल्ट सत्र कुंजी।
- `--session-label <label>`: रेज़ॉल्व करने के लिए डिफ़ॉल्ट सत्र लेबल।
- `--require-existing`: यदि सत्र कुंजी/लेबल मौजूद न हो तो विफल करें।
- `--reset-session`: पहले उपयोग से पहले सत्र कुंजी रीसेट करें।
- `--no-prefix-cwd`: कार्यशील निर्देशिका के साथ प्रॉम्प्ट्स को प्रीफ़िक्स न करें।
- `--verbose, -v`: stderr पर विस्तृत लॉगिंग।

### `acp client` options

- `--cwd <dir>`: ACP सत्र के लिए कार्यशील निर्देशिका।
- `--server <command>`: ACP सर्वर कमांड (डिफ़ॉल्ट: `openclaw`)।
- `--server-args <args...>`: ACP सर्वर को पास किए गए अतिरिक्त आर्ग्युमेंट्स।
- `--server-verbose`: ACP सर्वर पर विस्तृत लॉगिंग सक्षम करें।
- `--verbose, -v`: विस्तृत क्लाइंट लॉगिंग।
