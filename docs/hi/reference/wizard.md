---
summary: "CLI ऑनबोर्डिंग विज़ार्ड के लिए पूर्ण संदर्भ: हर चरण, फ़्लैग और विन्यास फ़ील्ड"
read_when:
  - किसी विशिष्ट विज़ार्ड चरण या फ़्लैग को देखना
  - गैर‑इंटरैक्टिव मोड के साथ ऑनबोर्डिंग को स्वचालित करना
  - विज़ार्ड के व्यवहार का डिबग करना
title: "ऑनबोर्डिंग विज़ार्ड संदर्भ"
sidebarTitle: "Wizard Reference"
---

# ऑनबोर्डिंग विज़ार्ड संदर्भ

This is the full reference for the `openclaw onboard` CLI wizard.
For a high-level overview, see [Onboarding Wizard](/start/wizard).

## फ़्लो विवरण (स्थानीय मोड)

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose **Keep / Modify / Reset**.
    - Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset**
      (or pass `--reset`).
    - If the config is invalid or contains legacy keys, the wizard stops and asks
      you to run `openclaw doctor` before continuing.
    - Reset uses `trash` (never `rm`) and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    - **Anthropic OAuth (Claude Code CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).
    - **OpenAI Code (Codex) सब्सक्रिप्शन (Codex CLI)**: यदि `~/.codex/auth.json` मौजूद है, तो विज़ार्ड इसे पुनः उपयोग कर सकता है।
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
      - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
    - **OpenAI API key**: यदि मौजूद हो तो `OPENAI_API_KEY` का उपयोग करता है या कुंजी के लिए पूछता है, फिर इसे `~/.openclaw/.env` में सहेजता है ताकि launchd इसे पढ़ सके।
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
    - **API key**: आपके लिए कुंजी सहेजता है।
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-written.
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: no auth configured yet.
    - Pick a default model from detected options (or enter provider/model manually).
    - Wizard runs a model check and warns if the configured model is unknown or missing auth.
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - अधिक विवरण: [/concepts/oauth](/concepts/oauth)    
<Note>
    हेडलेस/सर्वर सुझाव: ब्राउज़र वाली मशीन पर OAuth पूरा करें, फिर
    `~/.openclaw/credentials/oauth.json` (या `$OPENCLAW_STATE_DIR/credentials/oauth.json`) को
    Gateway होस्ट पर कॉपी करें।
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    - पूर्ण वर्कस्पेस लेआउट + बैकअप मार्गदर्शिका: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non‑loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **iMessage के लिए अनुशंसित**; सर्वर URL + पासवर्ड + वेबहुक।
    - [iMessage](/channels/imessage): लेगेसी `imsg` CLI पाथ + DB एक्सेस।
    - DM सुरक्षा: डिफ़ॉल्ट रूप से पेयरिंग। पहला DM एक कोड भेजता है; `openclaw pairing approve` के ज़रिए अनुमोदित करें <channel><code>` के माध्यम से अनुमोदित करें या allowlists का उपयोग करें।
  </Step><code>` या allowlists का उपयोग करें।
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - लॉग‑इन किया हुआ यूज़र सेशन आवश्यक; हेडलेस के लिए कस्टम LaunchDaemon उपयोग करें (शिप नहीं किया गया)।
      - Linux (और Windows via WSL2): systemd यूज़र यूनिट
      - विज़ार्ड `loginctl enable-linger <user>` के ज़रिए lingering सक्षम करने की कोशिश करता है ताकि लॉगआउट के बाद भी Gateway चालू रहे।
    - sudo के लिए पूछ सकता है (`/var/lib/systemd/linger` लिखता है); पहले बिना sudo के कोशिश करता है। - **Runtime चयन:** Node (अनुशंसित; WhatsApp/Telegram के लिए आवश्यक)।
  Bun **अनुशंसित नहीं** है।
    </Step>
  <Step title="Health check">
  - Gateway शुरू करता है (यदि आवश्यक हो) और `openclaw health` चलाता है।
    - टिप: `openclaw status --deep` स्टेटस आउटपुट में गेटवे हेल्थ प्रोब जोड़ता है (पहुंच योग्य गेटवे आवश्यक)।
    </Step>
  <Step title="Skills (recommended)">
  - उपलब्ध स्किल्स पढ़ता है और आवश्यकताओं की जाँच करता है।
  </Step>
</Steps>

<Note>
- आपको नोड मैनेजर चुनने देता है: **npm / pnpm** (bun अनुशंसित नहीं)।
- वैकल्पिक डिपेंडेंसीज़ इंस्टॉल करता है (कुछ macOS पर Homebrew का उपयोग करती हैं)।
</Note>

## Non-interactive मोड

ऑनबोर्डिंग को स्वचालित या स्क्रिप्ट करने के लिए `--non-interactive` का उपयोग करें:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

मशीन‑पठनीय सारांश के लिए `--json` जोड़ें।

<Note>
</Step>
  <Step title="Finish"> - सारांश + अगले कदम, जिनमें अतिरिक्त फीचर्स के लिए iOS/Android/macOS ऐप्स शामिल हैं।
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### एजेंट जोड़ें (non-interactive)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

यदि कोई GUI नहीं मिलता, तो विज़ार्ड ब्राउज़र खोलने के बजाय Control UI के लिए SSH पोर्ट‑फ़ॉरवर्ड निर्देश प्रिंट करता है।
यदि Control UI एसेट्स गायब हैं, तो विज़ार्ड उन्हें बिल्ड करने की कोशिश करता है; फ़ॉलबैक `pnpm ui:build` है (UI डिपेंडेंसीज़ ऑटो‑इंस्टॉल करता है)।

## Signal सेटअप (signal-cli)

विज़ार्ड GitHub releases से `signal-cli` इंस्टॉल कर सकता है:

- उपयुक्त release asset डाउनलोड करता है।
- इसे `~/.openclaw/tools/signal-cli/<version>/` के अंतर्गत संग्रहीत करता है।
- आपके विन्यास में `channels.signal.cliPath` लिखता है।

टिप्पणियाँ:

- JVM बिल्ड्स के लिए **Java 21** आवश्यक है।
- जहाँ उपलब्ध हो, native बिल्ड्स का उपयोग किया जाता है।
- Windows WSL2 का उपयोग करता है; signal-cli इंस्टॉल WSL के भीतर Linux फ़्लो का पालन करता है।

## विज़ार्ड क्या लिखता है

`~/.openclaw/openclaw.json` में सामान्य फ़ील्ड्स:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (यदि Minimax चुना गया हो)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- जब आप प्रॉम्प्ट्स के दौरान ऑप्ट‑इन करते हैं, तब चैनल allowlists (Slack/Discord/Matrix/Microsoft Teams) (जहाँ संभव हो नाम IDs में रेज़ॉल्व होते हैं)।
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` `agents.list[]` और वैकल्पिक `bindings` लिखता है।

`--json` का मतलब **नॉन‑इंटरएक्टिव मोड** नहीं होता।
स्क्रिप्ट्स के लिए `--non-interactive` (और `--workspace`) का उपयोग करें।

Gateway RPC के ज़रिए विज़ार्ड फ़्लो एक्सपोज़ करता है (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`)। क्लाइंट्स (macOS ऐप, Control UI) ऑनबोर्डिंग लॉजिक को दोबारा इम्प्लीमेंट किए बिना स्टेप्स रेंडर कर सकते हैं।

## संबंधित दस्तावेज़

- विज़ार्ड अवलोकन: [Onboarding Wizard](/start/wizard)
- macOS ऐप ऑनबोर्डिंग: [Onboarding](/start/onboarding)
- Config संदर्भ: [Gateway configuration](/gateway/configuration)
- प्रदाता: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
