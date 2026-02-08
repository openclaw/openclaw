---
summary: "CLI ऑनबोर्डिंग विज़ार्ड के लिए पूर्ण संदर्भ: हर चरण, फ़्लैग और विन्यास फ़ील्ड"
read_when:
  - किसी विशिष्ट विज़ार्ड चरण या फ़्लैग को देखना
  - गैर‑इंटरैक्टिव मोड के साथ ऑनबोर्डिंग को स्वचालित करना
  - विज़ार्ड के व्यवहार का डिबग करना
title: "ऑनबोर्डिंग विज़ार्ड संदर्भ"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:02Z
---

# ऑनबोर्डिंग विज़ार्ड संदर्भ

यह `openclaw onboard` CLI विज़ार्ड का पूर्ण संदर्भ है।
उच्च‑स्तरीय अवलोकन के लिए देखें [Onboarding Wizard](/start/wizard)।

## फ़्लो विवरण (स्थानीय मोड)

<Steps>
  <Step title="मौजूदा विन्यास का पता लगाना">
    - यदि `~/.openclaw/openclaw.json` मौजूद है, तो **Keep / Modify / Reset** चुनें।
    - विज़ार्ड को दोबारा चलाने पर **कुछ भी** मिटाया नहीं जाता जब तक आप स्पष्ट रूप से **Reset** न चुनें
      (या `--reset` पास न करें)।
    - यदि विन्यास अमान्य है या उसमें लेगेसी कुंजियाँ हैं, तो विज़ार्ड रुक जाता है और आपसे
      जारी रखने से पहले `openclaw doctor` चलाने को कहता है।
    - Reset में `trash` का उपयोग होता है (कभी भी `rm` नहीं) और स्कोप प्रदान किए जाते हैं:
      - केवल Config
      - Config + credentials + sessions
      - पूर्ण रीसेट (वर्कस्पेस भी हटाता है)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key (अनुशंसित)**: यदि `ANTHROPIC_API_KEY` मौजूद है तो उसका उपयोग करता है, अन्यथा कुंजी के लिए पूछता है, फिर इसे daemon उपयोग के लिए सहेजता है।
    - **Anthropic OAuth (Claude Code CLI)**: macOS पर विज़ार्ड Keychain आइटम "Claude Code-credentials" की जाँच करता है ("Always Allow" चुनें ताकि launchd स्टार्ट ब्लॉक न हों); Linux/Windows पर यदि मौजूद हो तो `~/.claude/.credentials.json` का पुन: उपयोग करता है।
    - **Anthropic token (setup-token पेस्ट करें)**: किसी भी मशीन पर `claude setup-token` चलाएँ, फिर टोकन पेस्ट करें (आप नाम दे सकते हैं; खाली = डिफ़ॉल्ट)।
    - **OpenAI Code (Codex) subscription (Codex CLI)**: यदि `~/.codex/auth.json` मौजूद है, तो विज़ार्ड उसका पुन: उपयोग कर सकता है।
    - **OpenAI Code (Codex) subscription (OAuth)**: ब्राउज़र फ़्लो; `code#state` पेस्ट करें।
      - जब मॉडल unset हो या `openai/*` हो, तब `agents.defaults.model` को `openai-codex/gpt-5.2` पर सेट करता है।
    - **OpenAI API key**: यदि `OPENAI_API_KEY` मौजूद है तो उसका उपयोग करता है, अन्यथा कुंजी के लिए पूछता है, फिर इसे `~/.openclaw/.env` में सहेजता है ताकि launchd इसे पढ़ सके।
    - **xAI (Grok) API key**: `XAI_API_KEY` के लिए पूछता है और xAI को एक मॉडल प्रदाता के रूप में विन्यस्त करता है।
    - **OpenCode Zen (multi-model proxy)**: `OPENCODE_API_KEY` (या `OPENCODE_ZEN_API_KEY`, इसे https://opencode.ai/auth पर प्राप्त करें) के लिए पूछता है।
    - **API key**: कुंजी को आपके लिए सहेजता है।
    - **Vercel AI Gateway (multi-model proxy)**: `AI_GATEWAY_API_KEY` के लिए पूछता है।
    - अधिक विवरण: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: Account ID, Gateway ID, और `CLOUDFLARE_AI_GATEWAY_API_KEY` के लिए पूछता है।
    - अधिक विवरण: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: विन्यास स्वचालित रूप से लिखा जाता है।
    - अधिक विवरण: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-संगत)**: `SYNTHETIC_API_KEY` के लिए पूछता है।
    - अधिक विवरण: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: विन्यास स्वचालित रूप से लिखा जाता है।
    - **Kimi Coding**: विन्यास स्वचालित रूप से लिखा जाता है।
    - अधिक विवरण: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: अभी कोई auth विन्यस्त नहीं।
    - पहचाने गए विकल्पों से एक डिफ़ॉल्ट मॉडल चुनें (या प्रदाता/मॉडल मैन्युअल रूप से दर्ज करें)।
    - विज़ार्ड मॉडल जाँच चलाता है और यदि विन्यस्त मॉडल अज्ञात है या auth अनुपलब्ध है तो चेतावनी देता है।
    - OAuth क्रेडेंशियल्स `~/.openclaw/credentials/oauth.json` में रहते हैं; auth प्रोफ़ाइल्स `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` में रहती हैं (API keys + OAuth)।
    - अधिक विवरण: [/concepts/oauth](/concepts/oauth)
    <Note>
    हेडलेस/सर्वर सुझाव: ब्राउज़र वाली मशीन पर OAuth पूरा करें, फिर
    `~/.openclaw/credentials/oauth.json` (या `$OPENCLAW_STATE_DIR/credentials/oauth.json`) को
    Gateway होस्ट पर कॉपी करें।
    </Note>
  </Step>
  <Step title="Workspace">
    - डिफ़ॉल्ट `~/.openclaw/workspace` (विन्यस्त करने योग्य)।
    - एजेंट बूटस्ट्रैप अनुष्ठान के लिए आवश्यक workspace फ़ाइलें सीड करता है।
    - पूर्ण workspace लेआउट + बैकअप गाइड: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - पोर्ट, bind, auth मोड, tailscale exposure।
    - Auth अनुशंसा: loopback के लिए भी **Token** बनाए रखें ताकि स्थानीय WS क्लाइंट्स को प्रमाणीकरण करना पड़े।
    - केवल तभी auth अक्षम करें जब आप हर स्थानीय प्रक्रिया पर पूर्ण भरोसा करते हों।
    - Non‑loopback binds में फिर भी auth आवश्यक है।
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): वैकल्पिक QR लॉगिन।
    - [Telegram](/channels/telegram): बॉट टोकन।
    - [Discord](/channels/discord): बॉट टोकन।
    - [Google Chat](/channels/googlechat): सेवा खाता JSON + webhook audience।
    - [Mattermost](/channels/mattermost) (प्लगइन): बॉट टोकन + बेस URL।
    - [Signal](/channels/signal): वैकल्पिक `signal-cli` इंस्टॉल + खाता विन्यास।
    - [BlueBubbles](/channels/bluebubbles): **iMessage के लिए अनुशंसित**; सर्वर URL + पासवर्ड + webhook।
    - [iMessage](/channels/imessage): लेगेसी `imsg` CLI पाथ + DB एक्सेस।
    - DM सुरक्षा: डिफ़ॉल्ट pairing है। पहला DM एक कोड भेजता है; `openclaw pairing approve <channel> <code>` के माध्यम से अनुमोदित करें या allowlists का उपयोग करें।
  </Step>
  <Step title="Daemon इंस्टॉल">
    - macOS: LaunchAgent
      - लॉग‑इन उपयोगकर्ता सत्र आवश्यक; हेडलेस के लिए कस्टम LaunchDaemon उपयोग करें (शिप नहीं किया गया)।
    - Linux (और Windows WSL2 के माध्यम से): systemd user unit
      - विज़ार्ड `loginctl enable-linger <user>` के माध्यम से lingering सक्षम करने का प्रयास करता है ताकि लॉगआउट के बाद भी Gateway चालू रहे।
      - sudo के लिए संकेत दे सकता है (`/var/lib/systemd/linger` लिखता है); पहले बिना sudo के प्रयास करता है।
    - **Runtime चयन:** Node (अनुशंसित; WhatsApp/Telegram के लिए आवश्यक)। Bun **अनुशंसित नहीं**।
  </Step>
  <Step title="Health check">
    - Gateway (यदि आवश्यक हो) शुरू करता है और `openclaw health` चलाता है।
    - सुझाव: `openclaw status --deep` स्थिति आउटपुट में gateway health probes जोड़ता है (एक पहुँच योग्य gateway आवश्यक)।
  </Step>
  <Step title="Skills (अनुशंसित)">
    - उपलब्ध Skills पढ़ता है और आवश्यकताओं की जाँच करता है।
    - node manager चुनने देता है: **npm / pnpm** (bun अनुशंसित नहीं)।
    - वैकल्पिक dependencies इंस्टॉल करता है (कुछ macOS पर Homebrew का उपयोग करती हैं)।
  </Step>
  <Step title="Finish">
    - सारांश + अगले कदम, जिनमें अतिरिक्त सुविधाओं के लिए iOS/Android/macOS ऐप्स शामिल हैं।
  </Step>
</Steps>

<Note>
यदि कोई GUI पता नहीं चलता, तो विज़ार्ड ब्राउज़र खोलने के बजाय Control UI के लिए SSH पोर्ट‑फ़ॉरवर्ड निर्देश प्रिंट करता है।
यदि Control UI एसेट्स गायब हैं, तो विज़ार्ड उन्हें बनाने का प्रयास करता है; फ़ॉलबैक `pnpm ui:build` है (UI deps को स्वतः इंस्टॉल करता है)।
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
`--json` का अर्थ **non-interactive मोड** नहीं होता। स्क्रिप्ट्स के लिए `--non-interactive` (और `--workspace`) का उपयोग करें।
</Note>

<AccordionGroup>
  <Accordion title="Gemini उदाहरण">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI उदाहरण">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway उदाहरण">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway उदाहरण">
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
  <Accordion title="Moonshot उदाहरण">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic उदाहरण">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen उदाहरण">
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

Gateway विज़ार्ड फ़्लो को RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`) के माध्यम से एक्सपोज़ करता है।
क्लाइंट्स (macOS ऐप, Control UI) ऑनबोर्डिंग लॉजिक को पुनः‑लागू किए बिना चरणों को रेंडर कर सकते हैं।

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

WhatsApp क्रेडेंशियल्स `~/.openclaw/credentials/whatsapp/<accountId>/` के अंतर्गत जाते हैं।
Sessions `~/.openclaw/agents/<agentId>/sessions/` के अंतर्गत संग्रहीत होती हैं।

कुछ चैनल प्लगइन्स के रूप में वितरित होते हैं। ऑनबोर्डिंग के दौरान जब आप किसी एक को चुनते हैं, तो विज़ार्ड
इसे कॉन्फ़िगर करने से पहले इंस्टॉल (npm या स्थानीय पाथ) करने के लिए प्रॉम्प्ट करेगा।

## संबंधित दस्तावेज़

- विज़ार्ड अवलोकन: [Onboarding Wizard](/start/wizard)
- macOS ऐप ऑनबोर्डिंग: [Onboarding](/start/onboarding)
- Config संदर्भ: [Gateway configuration](/gateway/configuration)
- प्रदाता: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
