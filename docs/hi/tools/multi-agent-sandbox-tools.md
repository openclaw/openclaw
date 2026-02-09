---
summary: "प्रति-एजेंट sandbox और टूल प्रतिबंध, प्राथमिकता, और उदाहरण"
title: मल्टी-एजेंट Sandbox और Tools
read_when: "जब आप मल्टी-एजेंट Gateway में प्रति-एजेंट sandboxing या प्रति-एजेंट टूल allow/deny नीतियाँ चाहते हों।"
status: active
---

# मल्टी-एजेंट Sandbox और Tools विन्यास

## अवलोकन

मल्टी-एजेंट सेटअप में प्रत्येक एजेंट के पास अब अपना स्वयं का हो सकता है:

- **Sandbox विन्यास** (`agents.list[].sandbox` `agents.defaults.sandbox` को ओवरराइड करता है)
- **टूल प्रतिबंध** (`tools.allow` / `tools.deny`, तथा `agents.list[].tools`)

यह आपको विभिन्न सुरक्षा प्रोफ़ाइल वाले कई एजेंट चलाने की अनुमति देता है:

- पूर्ण एक्सेस वाला व्यक्तिगत सहायक
- सीमित टूल वाले परिवार/कार्य एजेंट
- sandbox में चलने वाले सार्वजनिक एजेंट

`setupCommand` `sandbox.docker` (वैश्विक या प्रति-एजेंट) के अंतर्गत आता है और कंटेनर बनने पर केवल एक बार चलता है।

प्रमाणीकरण प्रति-एजेंट है: प्रत्येक एजेंट अपने स्वयं के `agentDir` auth स्टोर से पढ़ता है, जो यहाँ स्थित है:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credentials एजेंट्स के बीच **shared नहीं** होते। कभी भी `agentDir` को एजेंट्स के बीच reuse न करें।
यदि आप creds साझा करना चाहते हैं, तो `auth-profiles.json` को दूसरे एजेंट के `agentDir` में कॉपी करें।

runtime पर sandboxing कैसे व्यवहार करता है, इसके लिए देखें [Sandboxing](/gateway/sandboxing)।
“यह blocked क्यों है?” के debugging के लिए, देखें [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) और `openclaw sandbox explain`।

---

## विन्यास उदाहरण

### उदाहरण 1: व्यक्तिगत + प्रतिबंधित पारिवारिक एजेंट

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**परिणाम:**

- `main` एजेंट: होस्ट पर चलता है, पूर्ण टूल एक्सेस
- `family` एजेंट: Docker में चलता है (प्रति एजेंट एक कंटेनर), केवल `read` टूल

---

### उदाहरण 2: साझा Sandbox के साथ कार्य एजेंट

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### उदाहरण 2b: वैश्विक कोडिंग प्रोफ़ाइल + केवल मैसेजिंग एजेंट

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**परिणाम:**

- डिफ़ॉल्ट एजेंटों को कोडिंग टूल मिलते हैं
- `support` एजेंट केवल मैसेजिंग के लिए है (+ Slack टूल)

---

### उदाहरण 3: प्रति एजेंट अलग Sandbox मोड

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## विन्यास की प्राथमिकता

जब वैश्विक (`agents.defaults.*`) और एजेंट-विशिष्ट (`agents.list[].*`) दोनों विन्यास मौजूद हों:

### Sandbox विन्यास

एजेंट-विशिष्ट सेटिंग्स वैश्विक को ओवरराइड करती हैं:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**टिप्पणियाँ:**

- उस एजेंट के लिए `agents.list[].sandbox.{docker,browser,prune}.*`, `agents.defaults.sandbox.{docker,browser,prune}.*` को ओवरराइड करता है (जब sandbox स्कोप `"shared"` पर रेज़ॉल्व होता है, तब अनदेखा किया जाता है)।

### टूल प्रतिबंध

फ़िल्टरिंग क्रम इस प्रकार है:

1. **टूल प्रोफ़ाइल** (`tools.profile` या `agents.list[].tools.profile`)
2. **प्रदाता टूल प्रोफ़ाइल** (`tools.byProvider[provider].profile` या `agents.list[].tools.byProvider[provider].profile`)
3. **वैश्विक टूल नीति** (`tools.allow` / `tools.deny`)
4. **प्रदाता टूल नीति** (`tools.byProvider[provider].allow/deny`)
5. **एजेंट-विशिष्ट टूल नीति** (`agents.list[].tools.allow/deny`)
6. **एजेंट प्रदाता नीति** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox टूल नीति** (`tools.sandbox.tools` या `agents.list[].tools.sandbox.tools`)
8. **सबएजेंट टूल नीति** (`tools.subagents.tools`, यदि लागू हो)

प्रत्येक स्तर टूल्स को और सीमित कर सकता है, लेकिन पहले के स्तरों से denied किए गए टूल्स को वापस grant नहीं कर सकता।
यदि `agents.list[].tools.sandbox.tools` सेट है, तो यह उस एजेंट के लिए `tools.sandbox.tools` को replace करता है।
यदि `agents.list[].tools.profile` सेट है, तो यह उस एजेंट के लिए `tools.profile` को override करता है।
Provider टूल keys `provider` (जैसे `google-antigravity`) या `provider/model` (जैसे `openai/gpt-5.2`) में से किसी को भी स्वीकार करती हैं।

### टूल समूह (शॉर्टहैंड)

टूल नीतियाँ (वैश्विक, एजेंट, sandbox) `group:*` प्रविष्टियों का समर्थन करती हैं, जो कई ठोस टूल्स में विस्तारित होती हैं:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: सभी अंतर्निहित OpenClaw टूल्स (प्रदाता प्लगइन्स शामिल नहीं)

### Elevated मोड

`tools.elevated` global baseline है (sender-based allowlist)। `agents.list[].tools.elevated` specific एजेंट्स के लिए elevated को और सीमित कर सकता है (दोनों को allow करना होगा)।

निवारण पैटर्न:

- अविश्वसनीय एजेंटों के लिए `exec` को अस्वीकार करें (`agents.list[].tools.deny: ["exec"]`)
- ऐसे प्रेषकों को allowlist करने से बचें जो प्रतिबंधित एजेंटों तक रूट होते हों
- यदि आप केवल sandboxed निष्पादन चाहते हैं, तो वैश्विक रूप से elevated अक्षम करें (`tools.elevated.enabled: false`)
- संवेदनशील प्रोफ़ाइल के लिए प्रति एजेंट elevated अक्षम करें (`agents.list[].tools.elevated.enabled: false`)

---

## सिंगल एजेंट से माइग्रेशन

**पहले (सिंगल एजेंट):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**बाद में (विभिन्न प्रोफ़ाइल के साथ मल्टी-एजेंट):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

लीगेसी `agent.*` विन्यासों को `openclaw doctor` द्वारा माइग्रेट किया जाता है; आगे के लिए `agents.defaults` + `agents.list` को प्राथमिकता दें।

---

## टूल प्रतिबंध उदाहरण

### केवल-पठन एजेंट

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### सुरक्षित निष्पादन एजेंट (फ़ाइल संशोधन नहीं)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### केवल-संचार एजेंट

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## सामान्य समस्या: "non-main"

`agents.defaults.sandbox.mode: "non-main"` `session.mainKey` (default `"main"`) पर आधारित है,
agent id पर नहीं। Group/channel sessions को हमेशा अपने अलग keys मिलते हैं, इसलिए उन्हें non-main माना जाता है और वे sandboxed होंगे। यदि आप चाहते हैं कि कोई एजेंट कभी
sandbox न हो, तो `agents.list[].sandbox.mode: "off"` सेट करें।

---

## परीक्षण

मल्टी-एजेंट sandbox और tools कॉन्फ़िगर करने के बाद:

1. **एजेंट रेज़ॉल्यूशन जाँचें:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Sandbox कंटेनरों की पुष्टि करें:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **टूल प्रतिबंधों का परीक्षण करें:**
   - ऐसे संदेश भेजें जिनमें प्रतिबंधित टूल्स की आवश्यकता हो
   - सत्यापित करें कि एजेंट अस्वीकृत टूल्स का उपयोग नहीं कर सकता

4. **लॉग्स की निगरानी करें:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## समस्या-निवारण

### `mode: "all"` के बावजूद एजेंट sandboxed नहीं है

- जाँचें कि कहीं कोई वैश्विक `agents.defaults.sandbox.mode` तो नहीं है जो इसे ओवरराइड कर रहा हो
- एजेंट-विशिष्ट विन्यास को प्राथमिकता मिलती है, इसलिए `agents.list[].sandbox.mode: "all"` सेट करें

### deny सूची के बावजूद टूल उपलब्ध हैं

- टूल फ़िल्टरिंग क्रम जाँचें: वैश्विक → एजेंट → sandbox → सबएजेंट
- प्रत्येक स्तर केवल और अधिक प्रतिबंधित कर सकता है, वापस अनुमति नहीं दे सकता
- लॉग्स से सत्यापित करें: `[tools] filtering tools for agent:${agentId}`

### प्रति एजेंट कंटेनर पृथक नहीं है

- एजेंट-विशिष्ट sandbox विन्यास में `scope: "agent"` सेट करें
- डिफ़ॉल्ट `"session"` है, जो प्रति सत्र एक कंटेनर बनाता है

---

## यह भी देखें

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
