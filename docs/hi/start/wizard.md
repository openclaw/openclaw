---
summary: "CLI ऑनबोर्डिंग विज़ार्ड: गेटवे, वर्कस्पेस, चैनल और Skills के लिए निर्देशित सेटअप"
read_when:
  - ऑनबोर्डिंग विज़ार्ड चलाते या विन्यस्त करते समय
  - नई मशीन सेट अप करते समय
title: "ऑनबोर्डिंग विज़ार्ड (CLI)"
sidebarTitle: "ऑनबोर्डिंग: CLI"
x-i18n:
  source_path: start/wizard.md
  source_hash: 5495d951a2d78ffb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:46Z
---

# ऑनबोर्डिंग विज़ार्ड (CLI)

ऑनबोर्डिंग विज़ार्ड macOS,
Linux, या Windows (WSL2 के माध्यम से; दृढ़ता से अनुशंसित) पर OpenClaw सेट अप करने का **अनुशंसित** तरीका है।
यह एक ही निर्देशित प्रवाह में स्थानीय Gateway या दूरस्थ Gateway कनेक्शन, साथ ही चैनल, Skills,
और वर्कस्पेस डिफ़ॉल्ट्स को विन्यस्त करता है।

```bash
openclaw onboard
```

<Info>
सबसे तेज़ पहला चैट: Control UI खोलें (चैनल सेटअप की आवश्यकता नहीं)। चलाएँ
`openclaw dashboard` और ब्राउज़र में चैट करें। दस्तावेज़: [Dashboard](/web/dashboard).
</Info>

बाद में पुनः विन्यास करने के लिए:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` का अर्थ नॉन‑इंटरैक्टिव मोड नहीं है। स्क्रिप्ट्स के लिए, `--non-interactive` का उपयोग करें।
</Note>

<Tip>
अनुशंसित: Brave Search API कुंजी सेट अप करें ताकि एजेंट `web_search` का उपयोग कर सके
(`web_fetch` बिना कुंजी के काम करता है)। सबसे आसान मार्ग: `openclaw configure --section web`
जो `tools.web.search.apiKey` को सहेजता है। दस्तावेज़: [Web tools](/tools/web).
</Tip>

## त्वरित प्रारंभ बनाम उन्नत

विज़ार्ड **QuickStart** (डिफ़ॉल्ट्स) बनाम **Advanced** (पूर्ण नियंत्रण) से शुरू होता है।

<Tabs>
  <Tab title="QuickStart (defaults)">
    - स्थानीय गेटवे (loopback)
    - वर्कस्पेस डिफ़ॉल्ट (या मौजूदा वर्कस्पेस)
    - Gateway पोर्ट **18789**
    - Gateway प्रमाणीकरण **Token** (loopback पर भी स्वतः‑उत्पन्न)
    - Tailscale एक्सपोज़र **Off**
    - Telegram + WhatsApp DMs डिफ़ॉल्ट रूप से **allowlist** (आपसे आपका फ़ोन नंबर पूछा जाएगा)
  </Tab>
  <Tab title="Advanced (full control)">
    - प्रत्येक चरण को उजागर करता है (मोड, वर्कस्पेस, गेटवे, चैनल, डेमन, Skills)।
  </Tab>
</Tabs>

## विज़ार्ड क्या विन्यस्त करता है

**Local mode (default)** आपको इन चरणों से होकर ले जाता है:

1. **Model/Auth** — Anthropic API कुंजी (अनुशंसित), OAuth, OpenAI, या अन्य प्रदाता। एक डिफ़ॉल्ट मॉडल चुनें।
2. **Workspace** — एजेंट फ़ाइलों के लिए स्थान (डिफ़ॉल्ट `~/.openclaw/workspace`)। बूटस्ट्रैप फ़ाइलें सीड करता है।
3. **Gateway** — पोर्ट, बाइंड पता, प्रमाणीकरण मोड, Tailscale एक्सपोज़र।
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, या iMessage।
5. **Daemon** — LaunchAgent (macOS) या systemd user unit (Linux/WSL2) स्थापित करता है।
6. **Health check** — Gateway प्रारंभ करता है और सत्यापित करता है कि यह चल रहा है।
7. **Skills** — अनुशंसित Skills और वैकल्पिक निर्भरताएँ स्थापित करता है।

<Note>
विज़ार्ड को पुनः चलाने से **कुछ भी** नहीं मिटता जब तक आप स्पष्ट रूप से **Reset** नहीं चुनते (या `--reset` पास नहीं करते)।
यदि विन्यास अमान्य है या उसमें legacy कुंजियाँ हैं, तो विज़ार्ड पहले `openclaw doctor` चलाने के लिए कहता है।
</Note>

**Remote mode** केवल स्थानीय क्लाइंट को कहीं और स्थित Gateway से कनेक्ट करने के लिए विन्यस्त करता है।
यह दूरस्थ होस्ट पर कुछ भी स्थापित या परिवर्तित **नहीं** करता।

## एक और एजेंट जोड़ें

`openclaw agents add <name>` का उपयोग करके अपना स्वयं का वर्कस्पेस,
सत्र, और प्रमाणीकरण प्रोफ़ाइल के साथ एक अलग एजेंट बनाएँ। `--workspace` के बिना चलाने पर विज़ार्ड लॉन्च होता है।

यह क्या सेट करता है:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

नोट्स:

- डिफ़ॉल्ट वर्कस्पेस `~/.openclaw/workspace-<agentId>` का अनुसरण करते हैं।
- इनबाउंड संदेशों को रूट करने के लिए `bindings` जोड़ें (विज़ार्ड यह कर सकता है)।
- नॉन‑इंटरैक्टिव फ़्लैग्स: `--model`, `--agent-dir`, `--bind`, `--non-interactive`।

## पूर्ण संदर्भ

विस्तृत चरण‑दर‑चरण विवरण, नॉन‑इंटरैक्टिव स्क्रिप्टिंग, Signal सेटअप,
RPC API, और उन सभी विन्यास फ़ील्ड्स की पूरी सूची के लिए जिन्हें विज़ार्ड लिखता है, देखें
[Wizard Reference](/reference/wizard).

## संबंधित दस्तावेज़

- CLI कमांड संदर्भ: [`openclaw onboard`](/cli/onboard)
- macOS ऐप ऑनबोर्डिंग: [Onboarding](/start/onboarding)
- एजेंट प्रथम‑रन अनुष्ठान: [Agent Bootstrapping](/start/bootstrapping)
