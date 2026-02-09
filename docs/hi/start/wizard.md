---
summary: "CLI ऑनबोर्डिंग विज़ार्ड: गेटवे, वर्कस्पेस, चैनल और Skills के लिए निर्देशित सेटअप"
read_when:
  - ऑनबोर्डिंग विज़ार्ड चलाते या विन्यस्त करते समय
  - नई मशीन सेट अप करते समय
title: "ऑनबोर्डिंग विज़ार्ड (CLI)"
sidebarTitle: "ऑनबोर्डिंग: CLI"
---

# ऑनबोर्डिंग विज़ार्ड (CLI)

The onboarding wizard is the **recommended** way to set up OpenClaw on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

```bash
openclaw onboard
```

<Info>
Fastest first chat: open the Control UI (no channel setup needed). चलाएँ
`openclaw dashboard` और ब्राउज़र में चैट करें। Docs: [Dashboard](/web/dashboard).
</Info>

बाद में पुनः विन्यास करने के लिए:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` का अर्थ नॉन-इंटरैक्टिव मोड नहीं होता। स्क्रिप्ट्स के लिए, `--non-interactive` का उपयोग करें।
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). सबसे आसान तरीका: `openclaw configure --section web`
जो `tools.web.search.apiKey` को सहेजता है। Docs: [Web tools](/tools/web).
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

1. **Model/Auth** — Anthropic API key (recommended), OAuth, OpenAI, or other providers. Pick a default model.
2. **Workspace** — Location for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
3. **Gateway** — पोर्ट, बाइंड पता, प्रमाणीकरण मोड, Tailscale एक्सपोज़र।
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, या iMessage।
5. **Daemon** — LaunchAgent (macOS) या systemd user unit (Linux/WSL2) स्थापित करता है।
6. **Health check** — Gateway प्रारंभ करता है और सत्यापित करता है कि यह चल रहा है।
7. **Skills** — अनुशंसित Skills और वैकल्पिक निर्भरताएँ स्थापित करता है।

<Note>
Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset** (or pass `--reset`).
If the config is invalid or contains legacy keys, the wizard asks you to run `openclaw doctor` first.
</Note>

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

## एक और एजेंट जोड़ें

Use `openclaw agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches the wizard.

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
