---
summary: "मल्टी-एजेंट रूटिंग: अलग-थलग एजेंट, चैनल खाते, और बाइंडिंग्स"
title: मल्टी-एजेंट रूटिंग
read_when: "आप एक ही Gateway प्रक्रिया में कई अलग-थलग एजेंट (वर्कस्पेस + प्रमाणीकरण) चाहते हैं।"
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:25Z
---

# मल्टी-एजेंट रूटिंग

लक्ष्य: एक ही चल रहे Gateway में कई _अलग-थलग_ एजेंट (अलग वर्कस्पेस + `agentDir` + सत्र), साथ ही कई चैनल खाते (जैसे दो WhatsApp)। इनबाउंड संदेश बाइंडिंग्स के माध्यम से किसी एजेंट तक रूट किए जाते हैं।

## “एक एजेंट” क्या है?

एक **एजेंट** एक पूर्ण-स्कोप “ब्रेन” है, जिसके पास अपना:

- **वर्कस्पेस** (फ़ाइलें, AGENTS.md/SOUL.md/USER.md, स्थानीय नोट्स, पर्सोना नियम)।
- **स्टेट डायरेक्टरी** (`agentDir`) जिसमें auth प्रोफ़ाइल, मॉडल रजिस्ट्री, और प्रति-एजेंट विन्यास होता है।
- **सत्र स्टोर** (चैट इतिहास + रूटिंग स्टेट) जो `~/.openclaw/agents/<agentId>/sessions` के अंतर्गत होता है।

Auth प्रोफ़ाइल **प्रति-एजेंट** होती हैं। प्रत्येक एजेंट अपने स्वयं के निम्न से पढ़ता है:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

मुख्य एजेंट की क्रेडेंशियल्स स्वतः साझा **नहीं** होतीं। कभी भी `agentDir` को
एजेंटों के बीच पुनः उपयोग न करें (इससे auth/सत्र टकराव होते हैं)। यदि आप क्रेडेंशियल्स साझा करना चाहते हैं,
तो `auth-profiles.json` को दूसरे एजेंट के `agentDir` में कॉपी करें।

Skills प्रति-एजेंट होती हैं, प्रत्येक वर्कस्पेस के `skills/` फ़ोल्डर के माध्यम से, जबकि साझा Skills
`~/.openclaw/skills` से उपलब्ध होती हैं। देखें [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills)।

Gateway **एक एजेंट** (डिफ़ॉल्ट) या **कई एजेंट** साइड‑बाय‑साइड होस्ट कर सकता है।

**वर्कस्पेस नोट:** प्रत्येक एजेंट का वर्कस्पेस **डिफ़ॉल्ट cwd** होता है, कोई कठोर
sandbox नहीं। रिलेटिव पाथ वर्कस्पेस के भीतर रेज़ॉल्व होते हैं, लेकिन एब्सोल्यूट पाथ
sandboxing सक्षम न होने पर होस्ट की अन्य लोकेशनों तक पहुँच सकते हैं। देखें
[Sandboxing](/gateway/sandboxing)।

## पाथ्स (त्वरित मानचित्र)

- विन्यास: `~/.openclaw/openclaw.json` (या `OPENCLAW_CONFIG_PATH`)
- स्टेट डायरेक्टरी: `~/.openclaw` (या `OPENCLAW_STATE_DIR`)
- वर्कस्पेस: `~/.openclaw/workspace` (या `~/.openclaw/workspace-<agentId>`)
- एजेंट डायरेक्टरी: `~/.openclaw/agents/<agentId>/agent` (या `agents.list[].agentDir`)
- सत्र: `~/.openclaw/agents/<agentId>/sessions`

### सिंगल-एजेंट मोड (डिफ़ॉल्ट)

यदि आप कुछ नहीं करते, तो OpenClaw एक ही एजेंट चलाता है:

- `agentId` का डिफ़ॉल्ट **`main`** होता है।
- सत्रों की कुंजी `agent:main:<mainKey>` के रूप में होती है।
- वर्कस्पेस का डिफ़ॉल्ट `~/.openclaw/workspace` होता है (या `~/.openclaw/workspace-<profile>` जब `OPENCLAW_PROFILE` सेट हो)।
- स्टेट का डिफ़ॉल्ट `~/.openclaw/agents/main/agent` होता है।

## एजेंट हेल्पर

नया अलग-थलग एजेंट जोड़ने के लिए एजेंट विज़ार्ड का उपयोग करें:

```bash
openclaw agents add work
```

फिर इनबाउंड संदेशों को रूट करने के लिए `bindings` जोड़ें (या विज़ार्ड को करने दें)।

सत्यापित करें:

```bash
openclaw agents list --bindings
```

## कई एजेंट = कई लोग, कई व्यक्तित्व

**कई एजेंटों** के साथ, प्रत्येक `agentId` एक **पूरी तरह अलग-थलग पर्सोना** बन जाता है:

- **अलग फ़ोन नंबर/खाते** (प्रति चैनल `accountId`)।
- **अलग व्यक्तित्व** (प्रति-एजेंट वर्कस्पेस फ़ाइलें जैसे `AGENTS.md` और `SOUL.md`)।
- **अलग auth + सत्र** (स्पष्ट रूप से सक्षम किए बिना कोई क्रॉस‑टॉक नहीं)।

इससे **कई लोग** एक ही Gateway सर्वर साझा कर सकते हैं, जबकि उनके AI “ब्रेन” और डेटा अलग-थलग रहते हैं।

## एक WhatsApp नंबर, कई लोग (DM विभाजन)

आप **एक WhatsApp खाते** पर रहते हुए **अलग‑अलग WhatsApp DMs** को अलग एजेंटों तक रूट कर सकते हैं।
प्रेषक E.164 (जैसे `+15551234567`) पर `peer.kind: "dm"` के साथ मिलान करें। उत्तर उसी WhatsApp नंबर से आते हैं
(प्रति‑एजेंट प्रेषक पहचान नहीं होती)।

महत्वपूर्ण विवरण: डायरेक्ट चैट एजेंट की **मुख्य सत्र कुंजी** में सिमट जाती हैं,
इसलिए वास्तविक अलगाव के लिए **प्रति व्यक्ति एक एजेंट** आवश्यक है।

उदाहरण:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

नोट्स:

- DM प्रवेश नियंत्रण **प्रति WhatsApp खाता वैश्विक** होता है (पेयरिंग/अलाउलिस्ट), प्रति एजेंट नहीं।
- साझा समूहों के लिए, समूह को एक एजेंट से बाँधें या [Broadcast groups](/channels/broadcast-groups) का उपयोग करें।

## रूटिंग नियम (संदेश किसी एजेंट को कैसे चुनते हैं)

बाइंडिंग्स **निर्धारित** होती हैं और **सबसे विशिष्ट नियम जीतता है**:

1. `peer` मिलान (सटीक DM/समूह/चैनल आईडी)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. किसी चैनल के लिए `accountId` मिलान
5. चैनल-स्तरीय मिलान (`accountId: "*"`)
6. डिफ़ॉल्ट एजेंट पर फ़ॉलबैक (`agents.list[].default`, अन्यथा सूची की पहली प्रविष्टि, डिफ़ॉल्ट: `main`)

## कई खाते / फ़ोन नंबर

जो चैनल **कई खाते** समर्थित करते हैं (जैसे WhatsApp), वे प्रत्येक लॉगिन की पहचान के लिए `accountId` का उपयोग करते हैं।
प्रत्येक `accountId` को अलग एजेंट पर रूट किया जा सकता है, इसलिए एक सर्वर
सत्रों को मिलाए बिना कई फ़ोन नंबर होस्ट कर सकता है।

## अवधारणाएँ

- `agentId`: एक “ब्रेन” (वर्कस्पेस, प्रति-एजेंट auth, प्रति-एजेंट सत्र स्टोर)।
- `accountId`: एक चैनल खाता इंस्टेंस (जैसे WhatsApp खाता `"personal"` बनाम `"biz"`)।
- `binding`: `(channel, accountId, peer)` और वैकल्पिक रूप से guild/team IDs के आधार पर इनबाउंड संदेशों को किसी `agentId` तक रूट करता है।
- डायरेक्ट चैट `agent:<agentId>:<mainKey>` में सिमट जाती हैं (प्रति‑एजेंट “मुख्य”; `session.mainKey`)।

## उदाहरण: दो WhatsApp → दो एजेंट

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## उदाहरण: WhatsApp दैनिक चैट + Telegram गहन कार्य

चैनल के आधार पर विभाजन: WhatsApp को तेज़ दैनिक एजेंट पर और Telegram को Opus एजेंट पर रूट करें।

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

नोट्स:

- यदि किसी चैनल के लिए आपके पास कई खाते हैं, तो बाइंडिंग में `accountId` जोड़ें (उदाहरण के लिए `{ channel: "whatsapp", accountId: "personal" }`)।
- बाकी को चैट पर रखते हुए किसी एक DM/समूह को Opus पर रूट करने के लिए, उस पीयर के लिए `match.peer` बाइंडिंग जोड़ें; पीयर मिलान हमेशा चैनल‑व्यापी नियमों से जीतता है।

## उदाहरण: वही चैनल, एक पीयर Opus पर

WhatsApp को तेज़ एजेंट पर रखें, लेकिन एक DM को Opus पर रूट करें:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

पीयर बाइंडिंग्स हमेशा जीतती हैं, इसलिए उन्हें चैनल‑व्यापी नियम से ऊपर रखें।

## WhatsApp समूह से बँधा पारिवारिक एजेंट

एक समर्पित पारिवारिक एजेंट को एक ही WhatsApp समूह से बाँधें, मेंशन गेटिंग
और कड़े टूल नीति के साथ:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

नोट्स:

- टूल allow/deny सूचियाँ **tools** होती हैं, Skills नहीं। यदि किसी Skill को
  कोई बाइनरी चलानी है, तो सुनिश्चित करें कि `exec` अनुमति में है और बाइनरी sandbox में मौजूद है।
- अधिक कड़े गेटिंग के लिए, `agents.list[].groupChat.mentionPatterns` सेट करें और
  चैनल के लिए समूह अलाउलिस्ट सक्षम रखें।

## प्रति‑एजेंट Sandbox और टूल विन्यास

v2026.1.6 से शुरू होकर, प्रत्येक एजेंट का अपना sandbox और टूल प्रतिबंध हो सकता है:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

टिप्पणी: `setupCommand` `sandbox.docker` के अंतर्गत रहता है और कंटेनर निर्माण पर एक बार चलता है।
जब रेज़ॉल्व्ड स्कोप `"shared"` हो, तब प्रति‑एजेंट `sandbox.docker.*` ओवरराइड्स को अनदेखा किया जाता है।

**लाभ:**

- **सुरक्षा अलगाव**: अविश्वसनीय एजेंटों के लिए टूल्स सीमित करें
- **संसाधन नियंत्रण**: कुछ एजेंटों को sandbox करें जबकि अन्य को होस्ट पर रखें
- **लचीली नीतियाँ**: प्रति एजेंट अलग अनुमतियाँ

नोट: `tools.elevated` **वैश्विक** और प्रेषक‑आधारित है; इसे प्रति एजेंट विन्यस्त नहीं किया जा सकता।
यदि आपको प्रति‑एजेंट सीमाएँ चाहिए, तो `agents.list[].tools` का उपयोग करके `exec` को अस्वीकार करें।
समूह लक्ष्यीकरण के लिए, `agents.list[].groupChat.mentionPatterns` का उपयोग करें ताकि @mentions साफ़ तौर पर इच्छित एजेंट से मैप हों।

विस्तृत उदाहरणों के लिए [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) देखें।
