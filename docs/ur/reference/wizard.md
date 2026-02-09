---
summary: "CLI آن بورڈنگ وزارڈ کے لیے مکمل حوالہ: ہر مرحلہ، فلیگ، اور کنفیگ فیلڈ"
read_when:
  - کسی مخصوص وزارڈ مرحلے یا فلیگ کو تلاش کرتے وقت
  - نان اِنٹرایکٹو موڈ کے ساتھ آن بورڈنگ کو خودکار بناتے وقت
  - وزارڈ کے رویّے کی خرابیوں کا ازالہ کرتے وقت
title: "آن بورڈنگ وزارڈ حوالہ"
sidebarTitle: "وزارڈ حوالہ"
---

# آن بورڈنگ وزارڈ حوالہ

47. یہ `openclaw onboard` CLI ویزرڈ کے لیے مکمل حوالہ ہے۔
48. اعلیٰ سطحی جائزے کے لیے، دیکھیں [Onboarding Wizard](/start/wizard)۔

## فلو کی تفصیلات (لوکل موڈ)

<Steps>
  <Step title="Existing config detection">
    49. - اگر `~/.openclaw/openclaw.json` موجود ہو تو **Keep / Modify / Reset** منتخب کریں۔
    50. - ویزرڈ کو دوبارہ چلانے سے کچھ بھی **صاف نہیں ہوتا** جب تک کہ آپ واضح طور پر **Reset** منتخب نہ کریں
      (یا `--reset` پاس نہ کریں)۔
    - اگر کنفیگ غلط ہو یا اس میں لیگیسی کیز شامل ہوں تو وزارڈ رک جاتا ہے اور آپ سے کہتا ہے کہ آگے بڑھنے سے پہلے `openclaw doctor` چلائیں۔
    - ری سیٹ میں `trash` استعمال ہوتا ہے (`rm` کبھی نہیں) اور اسکوپس فراہم کیے جاتے ہیں:
      - صرف کنفیگ
      - کنفیگ + اسناد + سیشنز
      - مکمل ری سیٹ (ورک اسپیس بھی ہٹا دی جاتی ہے)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (تجویز کردہ)**: اگر موجود ہو تو `ANTHROPIC_API_KEY` استعمال کرتا ہے یا کلید مانگتا ہے، پھر اسے ڈیمون کے استعمال کے لیے محفوظ کر لیتا ہے۔
    - **Anthropic OAuth (Claude Code CLI)**: macOS پر وزارڈ Keychain آئٹم "Claude Code-credentials" چیک کرتا ہے ("Always Allow" منتخب کریں تاکہ launchd اسٹارٹس بلاک نہ ہوں)؛ Linux/Windows پر اگر موجود ہو تو `~/.claude/.credentials.json` دوبارہ استعمال کرتا ہے۔
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).
    - **OpenAI Code (Codex) سبسکرپشن (Codex CLI)**: اگر `~/.codex/auth.json` موجود ہو تو وزارڈ اسے دوبارہ استعمال کر سکتا ہے۔
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
      - جب ماڈل سیٹ نہ ہو یا `openai/*` ہو تو `agents.defaults.model` کو `openai-codex/gpt-5.2` پر سیٹ کرتا ہے۔
    - **OpenAI API key**: اگر موجود ہو تو `OPENAI_API_KEY` استعمال کرتا ہے یا کلید مانگتا ہے، پھر اسے `~/.openclaw/.env` میں محفوظ کرتا ہے تاکہ launchd اسے پڑھ سکے۔
    - **xAI (Grok) API key**: `XAI_API_KEY` کے لیے پرامپٹ کرتا ہے اور xAI کو ماڈل فراہم کنندہ کے طور پر کنفیگر کرتا ہے۔
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
    - **API key**: آپ کے لیے کلید محفوظ کرتا ہے۔
    - **Vercel AI Gateway (ملٹی-ماڈل پراکسی)**: `AI_GATEWAY_API_KEY` کے لیے پرامپٹ کرتا ہے۔
    - مزید تفصیل: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: اکاؤنٹ ID، گیٹ وے ID، اور `CLOUDFLARE_AI_GATEWAY_API_KEY` کے لیے پرامپٹ کرتا ہے۔
    - مزید تفصیل: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: کنفیگ خودکار طور پر لکھی جاتی ہے۔
    - مزید تفصیل: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: `SYNTHETIC_API_KEY` کے لیے پرامپٹ کرتا ہے۔
    - مزید تفصیل: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: کنفیگ خودکار طور پر لکھی جاتی ہے۔
    - **Kimi Coding**: کنفیگ خودکار طور پر لکھی جاتی ہے۔
    - مزید تفصیل: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: ابھی کوئی آتھنٹیکیشن کنفیگر نہیں کی جاتی۔
    - دریافت شدہ آپشنز میں سے ڈیفالٹ ماڈل منتخب کریں (یا فراہم کنندہ/ماڈل دستی طور پر درج کریں)۔
    - وزارڈ ماڈل چیک چلاتا ہے اور اگر کنفیگر کیا گیا ماڈل نامعلوم ہو یا آتھنٹیکیشن غائب ہو تو وارن کرتا ہے۔
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - مزید تفصیل: [/concepts/oauth](/concepts/oauth)    
<Note>
    ہیڈلیس/سرور مشورہ: براؤزر والی مشین پر OAuth مکمل کریں، پھر
    `~/.openclaw/credentials/oauth.json` (یا `$OPENCLAW_STATE_DIR/credentials/oauth.json`) کو
    گیٹ وے ہوسٹ پر کاپی کریں۔
    </Note>
  </Step>
  <Step title="Workspace">
    - ڈیفالٹ `~/.openclaw/workspace` (کنفیگریبل)۔
    - Seeds the workspace files needed for the agent bootstrap ritual.
    - مکمل ورک اسپیس لے آؤٹ + بیک اپ گائیڈ: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - پورٹ، بائنڈ، آتھ موڈ، ٹیل اسکیل ایکسپوژر۔
    - آتھ کی سفارش: لوپ بیک کے لیے بھی **Token** برقرار رکھیں تاکہ لوکل WS کلائنٹس کو آتھنٹیکیٹ کرنا پڑے۔
    - آتھ صرف اسی صورت میں غیر فعال کریں جب آپ ہر لوکل پروسیس پر مکمل بھروسہ رکھتے ہوں۔
    - نان-لوپ بیک بائنڈز کے لیے بھی آتھ درکار ہے۔
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): اختیاری QR لاگ اِن۔
    - [Telegram](/channels/telegram): بوٹ ٹوکن۔
    - [Discord](/channels/discord): بوٹ ٹوکن۔
    - [Google Chat](/channels/googlechat): سروس اکاؤنٹ JSON + ویب ہوک آڈیئنس۔
    - [Mattermost](/channels/mattermost) (پلگ اِن): بوٹ ٹوکن + بیس URL۔
    - [Signal](/channels/signal): اختیاری `signal-cli` انسٹال + اکاؤنٹ کنفیگ۔
    - [BlueBubbles](/channels/bluebubbles): **iMessage کے لیے تجویز کردہ**؛ سرور URL + پاس ورڈ + ویب ہوک۔
    - [iMessage](/channels/imessage): لیگیسی `imsg` CLI پاتھ + DB ایکسس۔
    - DM سیکیورٹی: ڈیفالٹ پیئرنگ ہے۔ پہلا DM ایک کوڈ بھیجتا ہے؛ `openclaw pairing approve <channel><code>` کے ذریعے منظوری دیں یا allowlists استعمال کریں۔
  </Step><code>` or use allowlists.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - لاگ اِن شدہ یوزر سیشن درکار؛ ہیڈلیس کے لیے کسٹم LaunchDaemon استعمال کریں (شپ نہیں کیا گیا)۔
    - Linux (اور Windows بذریعہ WSL2): systemd یوزر یونٹ
      - وزارڈ `loginctl enable-linger <user>` کے ذریعے لِنگرنگ فعال کرنے کی کوشش کرتا ہے تاکہ لاگ آؤٹ کے بعد بھی گیٹ وے چلتا رہے۔
      - sudo کے لیے پرامپٹ ہو سکتا ہے (`/var/lib/systemd/linger` لکھتا ہے)؛ پہلے sudo کے بغیر کوشش کرتا ہے۔
    - **Runtime انتخاب:** Node (تجویز کردہ؛ WhatsApp/Telegram کے لیے درکار)۔ Bun **تجویز نہیں کیا جاتا**۔
  </Step>
  <Step title="Health check">
    - گیٹ وے شروع کرتا ہے (اگر ضرورت ہو) اور `openclaw health` چلاتا ہے۔
    - ٹِپ: `openclaw status --deep` اسٹیٹس آؤٹ پٹ میں گیٹ وے ہیلتھ پروبز شامل کرتا ہے (قابلِ رسائی گیٹ وے درکار)۔
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - اختیاری ڈیپنڈنسیز انسٹال کرتا ہے (کچھ macOS پر Homebrew استعمال کرتی ہیں)۔
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
</Note>

## نان اِنٹرایکٹو موڈ

آن بورڈنگ کو خودکار یا اسکرپٹ کرنے کے لیے `--non-interactive` استعمال کریں:

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

مشین‑ریڈیبل خلاصہ کے لیے `--json` شامل کریں۔

<Note>
`--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.
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

### ایجنٹ شامل کریں (نان اِنٹرایکٹو)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway وزارڈ RPC

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.

## Signal سیٹ اپ (signal-cli)

وزارڈ GitHub ریلیزز سے `signal-cli` انسٹال کر سکتا ہے:

- مناسب ریلیز اثاثہ ڈاؤن لوڈ کرتا ہے۔
- اسے `~/.openclaw/tools/signal-cli/<version>/` کے تحت محفوظ کرتا ہے۔
- آپ کی کنفیگ میں `channels.signal.cliPath` لکھتا ہے۔

نوٹس:

- JVM بلڈز کے لیے **Java 21** درکار ہے۔
- جہاں دستیاب ہو، نیٹو بلڈز استعمال کیے جاتے ہیں۔
- Windows WSL2 استعمال کرتا ہے؛ signal-cli انسٹال WSL کے اندر Linux فلو کے مطابق ہوتی ہے۔

## وزارڈ کیا لکھتا ہے

`~/.openclaw/openclaw.json` میں عام فیلڈز:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (اگر Minimax منتخب ہو)
- `gateway.*` (موڈ، bind، auth، tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- چینل allowlists (Slack/Discord/Matrix/Microsoft Teams) جب آپ پرامپٹس کے دوران opt in کریں (نام جہاں ممکن ہو IDs میں resolve ہوتے ہیں)۔
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`، `agents.list[]` اور اختیاری `bindings` لکھتا ہے۔

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. When you pick one during onboarding, the wizard
will prompt to install it (npm or a local path) before it can be configured.

## متعلقہ دستاویزات

- وزارڈ جائزہ: [Onboarding Wizard](/start/wizard)
- macOS ایپ آن بورڈنگ: [Onboarding](/start/onboarding)
- کنفیگ حوالہ: [Gateway configuration](/gateway/configuration)
- فراہم کنندگان: [WhatsApp](/channels/whatsapp)، [Telegram](/channels/telegram)، [Discord](/channels/discord)، [Google Chat](/channels/googlechat)، [Signal](/channels/signal)، [BlueBubbles](/channels/bluebubbles) (iMessage)، [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills)، [Skills config](/tools/skills-config)
