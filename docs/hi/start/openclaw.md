---
summary: "सुरक्षा सावधानियों के साथ OpenClaw को एक व्यक्तिगत सहायक के रूप में चलाने के लिए एंड-टू-एंड मार्गदर्शिका"
read_when:
  - एक नए सहायक इंस्टेंस का ऑनबोर्डिंग
  - सुरक्षा/अनुमति प्रभावों की समीक्षा
title: "पर्सनल असिस्टेंट सेटअप"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:54Z
---

# OpenClaw के साथ एक व्यक्तिगत सहायक बनाना

OpenClaw **Pi** एजेंट्स के लिए WhatsApp + Telegram + Discord + iMessage Gateway है। Plugins से Mattermost जोड़ा जाता है। यह मार्गदर्शिका “पर्सनल असिस्टेंट” सेटअप के लिए है: एक समर्पित WhatsApp नंबर जो आपके हमेशा-ऑन एजेंट की तरह व्यवहार करता है।

## ⚠️ सुरक्षा पहले

आप एक एजेंट को ऐसी स्थिति में रख रहे हैं जहाँ वह:

- आपकी मशीन पर कमांड चला सकता है (आपके Pi टूल सेटअप पर निर्भर)
- आपके वर्कस्पेस में फ़ाइलें पढ़/लिख सकता है
- WhatsApp/Telegram/Discord/Mattermost (plugin) के माध्यम से संदेश वापस भेज सकता है

संयम से शुरू करें:

- हमेशा `channels.whatsapp.allowFrom` सेट करें (अपने व्यक्तिगत Mac पर कभी भी ओपन-टू-द-वर्ल्ड न चलाएँ)।
- सहायक के लिए एक समर्पित WhatsApp नंबर उपयोग करें।
- हार्टबीट्स अब डिफ़ॉल्ट रूप से हर 30 मिनट पर होते हैं। सेटअप पर भरोसा होने तक `agents.defaults.heartbeat.every: "0m"` सेट करके इन्हें अक्षम करें।

## पूर्वापेक्षाएँ

- OpenClaw इंस्टॉल और ऑनबोर्ड किया हुआ — यदि अभी तक नहीं किया है तो [Getting Started](/start/getting-started) देखें
- सहायक के लिए एक दूसरा फ़ोन नंबर (SIM/eSIM/प्रीपेड)

## दो-फ़ोन सेटअप (अनुशंसित)

आप यह चाहते हैं:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

यदि आप अपने व्यक्तिगत WhatsApp को OpenClaw से लिंक करते हैं, तो आपके पास आने वाला हर संदेश “एजेंट इनपुट” बन जाता है। यह शायद ही कभी वांछित होता है।

## 5-मिनट त्वरित प्रारंभ

1. WhatsApp Web को पेयर करें (QR दिखेगा; सहायक फ़ोन से स्कैन करें):

```bash
openclaw channels login
```

2. Gateway शुरू करें (इसे चलता रहने दें):

```bash
openclaw gateway --port 18789
```

3. `~/.openclaw/openclaw.json` में एक न्यूनतम config रखें:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

अब allowlist किए गए फ़ोन से सहायक नंबर पर संदेश भेजें।

ऑनबोर्डिंग पूरी होने पर, हम अपने आप डैशबोर्ड खोलते हैं और एक साफ़ (नॉन-टोकनाइज़्ड) लिंक प्रिंट करते हैं। यदि यह auth के लिए पूछे, तो `gateway.auth.token` से टोकन को Control UI सेटिंग्स में पेस्ट करें। बाद में फिर से खोलने के लिए: `openclaw dashboard`।

## एजेंट को एक वर्कस्पेस दें (AGENTS)

OpenClaw अपने वर्कस्पेस डायरेक्टरी से ऑपरेटिंग निर्देश और “मेमोरी” पढ़ता है।

डिफ़ॉल्ट रूप से, OpenClaw एजेंट वर्कस्पेस के रूप में `~/.openclaw/workspace` का उपयोग करता है, और सेटअप/पहली एजेंट रन पर इसे (साथ ही शुरुआती `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) अपने आप बना देता है। `BOOTSTRAP.md` केवल तब बनता है जब वर्कस्पेस बिल्कुल नया हो (इसे हटाने के बाद वापस नहीं आना चाहिए)। `MEMORY.md` वैकल्पिक है (अपने आप नहीं बनता); मौजूद होने पर, इसे सामान्य सत्रों के लिए लोड किया जाता है। सबएजेंट सत्र केवल `AGENTS.md` और `TOOLS.md` इंजेक्ट करते हैं।

सुझाव: इस फ़ोल्डर को OpenClaw की “मेमोरी” की तरह मानें और इसे एक git repo (आदर्श रूप से निजी) बनाएं ताकि आपकी `AGENTS.md` + मेमोरी फ़ाइलें बैकअप हों। यदि git इंस्टॉल है, तो बिल्कुल नए वर्कस्पेस अपने आप इनिशियलाइज़ हो जाते हैं।

```bash
openclaw setup
```

पूरा वर्कस्पेस लेआउट + बैकअप गाइड: [Agent workspace](/concepts/agent-workspace)  
मेमोरी वर्कफ़्लो: [Memory](/concepts/memory)

वैकल्पिक: `agents.defaults.workspace` के साथ एक अलग वर्कस्पेस चुनें (समर्थन करता है `~`)।

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

यदि आप पहले से किसी repo से अपने वर्कस्पेस फ़ाइलें शिप करते हैं, तो आप बूटस्ट्रैप फ़ाइल निर्माण को पूरी तरह अक्षम कर सकते हैं:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## “एक असिस्टेंट” बनाने वाला config

OpenClaw डिफ़ॉल्ट रूप से एक अच्छा असिस्टेंट सेटअप देता है, लेकिन आमतौर पर आप यह ट्यून करना चाहेंगे:

- `SOUL.md` में persona/निर्देश
- थिंकिंग डिफ़ॉल्ट्स (यदि वांछित)
- हार्टबीट्स (जब भरोसा हो जाए)

उदाहरण:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## सत्र और मेमोरी

- सत्र फ़ाइलें: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- सत्र मेटाडेटा (टोकन उपयोग, अंतिम रूट, आदि): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` या `/reset` उस चैट के लिए एक नया सत्र शुरू करता है ( `resetTriggers` के माध्यम से कॉन्फ़िगर योग्य)। यदि अकेले भेजा जाए, तो एजेंट रीसेट की पुष्टि के लिए एक छोटा अभिवादन भेजता है।
- `/compact [instructions]` सत्र संदर्भ को संक्षिप्त करता है और शेष संदर्भ बजट की रिपोर्ट करता है।

## हार्टबीट्स (प्रोएक्टिव मोड)

डिफ़ॉल्ट रूप से, OpenClaw हर 30 मिनट पर इस प्रॉम्प्ट के साथ एक हार्टबीट चलाता है:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`  
अक्षम करने के लिए `agents.defaults.heartbeat.every: "0m"` सेट करें।

- यदि `HEARTBEAT.md` मौजूद है लेकिन प्रभावी रूप से खाली है (केवल खाली पंक्तियाँ और markdown हेडर्स जैसे `# Heading`), तो API कॉल बचाने के लिए OpenClaw हार्टबीट रन छोड़ देता है।
- यदि फ़ाइल गायब है, तो हार्टबीट फिर भी चलता है और मॉडल तय करता है कि क्या करना है।
- यदि एजेंट `HEARTBEAT_OK` के साथ उत्तर देता है (वैकल्पिक रूप से छोटा padding; देखें `agents.defaults.heartbeat.ackMaxChars`), तो OpenClaw उस हार्टबीट के लिए आउटबाउंड डिलीवरी को दबा देता है।
- हार्टबीट्स पूर्ण एजेंट टर्न चलाते हैं — कम अंतराल अधिक टोकन खर्च करते हैं।

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## मीडिया इन और आउट

इनबाउंड अटैचमेंट्स (छवियाँ/ऑडियो/डॉक्स) टेम्पलेट्स के माध्यम से आपके कमांड तक पहुँचाए जा सकते हैं:

- `{{MediaPath}}` (local temp फ़ाइल पथ)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (यदि ऑडियो ट्रांसक्रिप्शन सक्षम है)

एजेंट से आउटबाउंड अटैचमेंट्स: अपनी अलग पंक्ति में (बिना स्पेस) `MEDIA:<path-or-url>` शामिल करें। उदाहरण:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw इन्हें निकालता है और टेक्स्ट के साथ मीडिया के रूप में भेजता है।

## संचालन चेकलिस्ट

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

लॉग्स `/tmp/openclaw/` के अंतर्गत रहते हैं (डिफ़ॉल्ट: `openclaw-YYYY-MM-DD.log`)।

## अगले कदम

- WebChat: [WebChat](/web/webchat)
- Gateway ops: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- macOS मेनू बार सहचर: [OpenClaw macOS app](/platforms/macos)
- iOS नोड ऐप: [iOS app](/platforms/ios)
- Android नोड ऐप: [Android app](/platforms/android)
- Windows स्थिति: [Windows (WSL2)](/platforms/windows)
- Linux स्थिति: [Linux app](/platforms/linux)
- सुरक्षा: [Security](/gateway/security)
