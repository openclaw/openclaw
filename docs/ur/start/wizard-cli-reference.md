---
summary: "CLI آن بورڈنگ فلو، تصدیق/ماڈل سیٹ اپ، آؤٹ پٹس، اور اندرونی پہلوؤں کے لیے مکمل حوالہ"
read_when:
  - آپ کو openclaw آن بورڈ کے لیے تفصیلی رویّہ درکار ہو
  - آپ آن بورڈنگ کے نتائج ڈیبگ کر رہے ہوں یا آن بورڈنگ کلائنٹس ضم کر رہے ہوں
title: "CLI آن بورڈنگ حوالہ"
sidebarTitle: "CLI حوالہ"
---

# CLI آن بورڈنگ حوالہ

This page is the full reference for `openclaw onboard`.
For the short guide, see [Onboarding Wizard (CLI)](/start/wizard).

## وزارڈ کیا کرتا ہے

لوکل موڈ (بطورِ طے شدہ) آپ کو درج ذیل مراحل سے گزارتا ہے:

- ماڈل اور تصدیق سیٹ اپ (OpenAI Code سبسکرپشن OAuth، Anthropic API کلید یا سیٹ اپ ٹوکن، نیز MiniMax، GLM، Moonshot، اور AI Gateway کے اختیارات)
- ورک اسپیس کا مقام اور بوٹ اسٹرَیپ فائلیں
- Gateway سیٹنگز (پورٹ، بائنڈ، تصدیق، tailscale)
- چینلز اور فراہم کنندگان (Telegram، WhatsApp، Discord، Google Chat، Mattermost پلگ اِن، Signal)
- ڈیمَن انسٹال (LaunchAgent یا systemd یوزر یونٹ)
- ہیلتھ چیک
- Skills سیٹ اپ

ریموٹ موڈ اس مشین کو کہیں اور موجود gateway سے منسلک کرنے کے لیے کنفیگر کرتا ہے۔
It does not install or modify anything on the remote host.

## لوکل فلو کی تفصیلات

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose Keep, Modify, or Reset.
    - Re-running the wizard does not wipe anything unless you explicitly choose Reset (or pass `--reset`).
    - If config is invalid or contains legacy keys, the wizard stops and asks you to run `openclaw doctor` before continuing.
    - Reset uses `trash` and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model and auth">
    - مکمل اختیارات کی فہرست [Auth and model options](#auth-and-model-options) میں ہے۔
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds workspace files needed for first-run bootstrap ritual.
    - ورک اسپیس لے آؤٹ: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Prompts for port, bind, auth mode, and tailscale exposure.
    - Recommended: keep token auth enabled even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non-loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): optional `signal-cli` install + account config
    - [BlueBubbles](/channels/bluebubbles): recommended for iMessage; server URL + password + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access
    - DM security: default is pairing. First DM sends a code; approve via
      `openclaw pairing approve <channel><code>` کے ذریعے یا allowlists استعمال کریں۔
  </Step><code>` or use allowlists.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux and Windows via WSL2: systemd user unit
      - Wizard attempts `loginctl enable-linger <user>` so gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - Runtime selection: Node (recommended; required for WhatsApp and Telegram). Bun is not recommended.
  </Step>
  <Step title="Health check">
    - Starts gateway (if needed) and runs `openclaw health`.
    - `openclaw status --deep` adds gateway health probes to status output.
  </Step>
  <Step title="Skills">
    - Reads available skills and checks requirements.
    - Lets you choose node manager: npm or pnpm (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary and next steps, including iOS, Android, and macOS app options.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
</Note>

## ریموٹ موڈ کی تفصیلات

ریموٹ موڈ اس مشین کو کہیں اور موجود gateway سے منسلک کرنے کے لیے کنفیگر کرتا ہے۔

<Info>
ریموٹ موڈ ریموٹ ہوسٹ پر کچھ بھی انسٹال یا ترمیم نہیں کرتا۔
</Info>

جو آپ سیٹ کرتے ہیں:

- ریموٹ gateway URL (`ws://...`)
- اگر ریموٹ gateway تصدیق درکار کرے تو ٹوکن (سفارش کردہ)

<Note>
- If gateway is loopback-only, use SSH tunneling or a tailnet.
- Discovery hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## تصدیق اور ماڈل کے اختیارات

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    اگر موجود ہو تو `ANTHROPIC_API_KEY` استعمال کرتا ہے یا کلید کے لیے پرامپٹ کرتا ہے، پھر ڈیمَن کے استعمال کے لیے محفوظ کرتا ہے۔
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: Keychain آئٹم "Claude Code-credentials" چیک کرتا ہے
    - Linux اور Windows: اگر موجود ہو تو `~/.claude/.credentials.json` دوبارہ استعمال کرتا ہے

    ```
    macOS پر "Always Allow" منتخب کریں تاکہ launchd اسٹارٹس بلاک نہ ہوں۔
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Run `claude setup-token` on any machine, then paste the token.
    You can name it; blank uses default.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    اگر `~/.codex/auth.json` موجود ہو تو وزارڈ اسے دوبارہ استعمال کر سکتا ہے۔
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    براؤزر فلو؛ `code#state` پیسٹ کریں۔

    ```
    جب ماڈل غیر سیٹ ہو یا `openai/*` ہو تو `agents.defaults.model` کو `openai-codex/gpt-5.3-codex` پر سیٹ کرتا ہے۔
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    اگر موجود ہو تو `OPENAI_API_KEY` استعمال کرتا ہے یا کلید کے لیے پرامپٹ کرتا ہے، پھر اسے
    `~/.openclaw/.env` میں محفوظ کرتا ہے تاکہ launchd اسے پڑھ سکے۔

    ```
    جب ماڈل غیر سیٹ ہو، `openai/*` ہو، یا `openai-codex/*` ہو تو `agents.defaults.model` کو `openai/gpt-5.1-codex` پر سیٹ کرتا ہے۔
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY` کے لیے پرامپٹ کرتا ہے اور xAI کو ماڈل فراہم کنندہ کے طور پر کنفیگر کرتا ہے۔
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    کلید آپ کے لیے محفوظ کرتا ہے۔
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Prompts for `AI_GATEWAY_API_KEY`.
    More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Prompts for account ID, gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config is auto-written.
    More detail: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prompts for `SYNTHETIC_API_KEY`.
    More detail: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) and Kimi Coding configs are auto-written.
    More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    تصدیق کو غیر کنفیگرڈ چھوڑ دیتا ہے۔
  </Accordion>
</AccordionGroup>

ماڈل کا رویّہ:

- شناخت شدہ اختیارات میں سے ڈیفالٹ ماڈل منتخب کریں، یا فراہم کنندہ اور ماڈل دستی طور پر درج کریں۔
- وزارڈ ماڈل چیک چلاتا ہے اور اگر کنفیگرڈ ماڈل نامعلوم ہو یا تصدیق غائب ہو تو انتباہ دیتا ہے۔

اسناد اور پروفائل پاتھس:

- OAuth اسناد: `~/.openclaw/credentials/oauth.json`
- تصدیقی پروفائلز (API کلیدیں + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
ہیڈلیس اور سرور ٹِپ: براؤزر والی مشین پر OAuth مکمل کریں، پھر
`~/.openclaw/credentials/oauth.json` (یا `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
کو gateway ہوسٹ پر کاپی کریں۔
</Note>

## آؤٹ پٹس اور اندرونی پہلو

`~/.openclaw/openclaw.json` میں عام فیلڈز:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (اگر Minimax منتخب کیا گیا ہو)
- `gateway.*` (موڈ، بائنڈ، تصدیق، tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- چینل allowlists (Slack، Discord، Matrix، Microsoft Teams) جب آپ پرامپٹس کے دوران آپٹ اِن کریں (نام جہاں ممکن ہو IDs میں ریزولو ہو جاتے ہیں)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`، `agents.list[]` اور اختیاری `bindings` لکھتا ہے۔

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Some channels are delivered as plugins. When selected during onboarding, the wizard
prompts to install the plugin (npm or local path) before channel configuration.
</Note>

Gateway وزارڈ RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

کلائنٹس (macOS ایپ اور Control UI) آن بورڈنگ لاجک دوبارہ نافذ کیے بغیر مراحل رینڈر کر سکتے ہیں۔

Signal سیٹ اپ کا رویّہ:

- مناسب ریلیز اثاثہ ڈاؤن لوڈ کرتا ہے
- اسے `~/.openclaw/tools/signal-cli/<version>/` کے تحت محفوظ کرتا ہے
- کنفیگ میں `channels.signal.cliPath` لکھتا ہے
- JVM بلڈز کے لیے Java 21 درکار ہے
- جہاں دستیاب ہوں، نیٹو بلڈز استعمال کیے جاتے ہیں
- Windows WSL2 استعمال کرتا ہے اور WSL کے اندر Linux signal-cli فلو کی پیروی کرتا ہے

## متعلقہ دستاویزات

- آن بورڈنگ ہب: [Onboarding Wizard (CLI)](/start/wizard)
- آٹومیشن اور اسکرپٹس: [CLI Automation](/start/wizard-cli-automation)
- کمانڈ حوالہ: [`openclaw onboard`](/cli/onboard)
