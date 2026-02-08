---
summary: "CLI آن بورڈنگ وزارڈ کے لیے مکمل حوالہ: ہر مرحلہ، فلیگ، اور کنفیگ فیلڈ"
read_when:
  - کسی مخصوص وزارڈ مرحلے یا فلیگ کو تلاش کرتے وقت
  - نان اِنٹرایکٹو موڈ کے ساتھ آن بورڈنگ کو خودکار بناتے وقت
  - وزارڈ کے رویّے کی خرابیوں کا ازالہ کرتے وقت
title: "آن بورڈنگ وزارڈ حوالہ"
sidebarTitle: "وزارڈ حوالہ"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:59Z
---

# آن بورڈنگ وزارڈ حوالہ

یہ `openclaw onboard` CLI وزارڈ کا مکمل حوالہ ہے۔
اعلٰی سطحی جائزے کے لیے، دیکھیں [Onboarding Wizard](/start/wizard)۔

## فلو کی تفصیلات (لوکل موڈ)

<Steps>
  <Step title="موجودہ کنفیگ کی شناخت">
    - اگر `~/.openclaw/openclaw.json` موجود ہو، تو **Keep / Modify / Reset** میں سے انتخاب کریں۔
    - وزارڈ کو دوبارہ چلانے سے کچھ بھی **ختم نہیں** ہوتا جب تک آپ واضح طور پر **Reset** منتخب نہ کریں
      (یا `--reset` پاس نہ کریں)۔
    - اگر کنفیگ غیر معتبر ہو یا اس میں پرانی keys شامل ہوں، تو وزارڈ رک جاتا ہے اور
      آپ سے کہتا ہے کہ آگے بڑھنے سے پہلے `openclaw doctor` چلائیں۔
    - Reset میں `trash` استعمال ہوتا ہے (کبھی `rm` نہیں) اور اسکوپس پیش کیے جاتے ہیں:
      - صرف کنفیگ
      - کنفیگ + اسناد + سیشنز
      - مکمل ری سیٹ (ورک اسپیس بھی حذف کرتا ہے)
  </Step>
  <Step title="ماڈل/تصدیق">
    - **Anthropic API key (سفارش کردہ)**: اگر `ANTHROPIC_API_KEY` موجود ہو تو اسے استعمال کرتا ہے یا کلید کے لیے پوچھتا ہے، پھر اسے daemon کے استعمال کے لیے محفوظ کرتا ہے۔
    - **Anthropic OAuth (Claude Code CLI)**: macOS پر وزارڈ Keychain آئٹم "Claude Code-credentials" چیک کرتا ہے ( "Always Allow" منتخب کریں تاکہ launchd اسٹارٹس بلاک نہ ہوں)؛ Linux/Windows پر اگر `~/.claude/.credentials.json` موجود ہو تو اسی کو دوبارہ استعمال کرتا ہے۔
    - **Anthropic token (setup-token پیسٹ کریں)**: کسی بھی مشین پر `claude setup-token` چلائیں، پھر ٹوکن پیسٹ کریں (آپ نام دے سکتے ہیں؛ خالی = default)۔
    - **OpenAI Code (Codex) سبسکرپشن (Codex CLI)**: اگر `~/.codex/auth.json` موجود ہو تو وزارڈ اسے دوبارہ استعمال کر سکتا ہے۔
    - **OpenAI Code (Codex) سبسکرپشن (OAuth)**: براؤزر فلو؛ `code#state` پیسٹ کریں۔
      - جب ماڈل سیٹ نہ ہو یا `openai/*` ہو تو `agents.defaults.model` کو `openai-codex/gpt-5.2` پر سیٹ کرتا ہے۔
    - **OpenAI API key**: اگر `OPENAI_API_KEY` موجود ہو تو استعمال کرتا ہے یا کلید کے لیے پوچھتا ہے، پھر اسے `~/.openclaw/.env` میں محفوظ کرتا ہے تاکہ launchd اسے پڑھ سکے۔
    - **xAI (Grok) API key**: `XAI_API_KEY` کے لیے پوچھتا ہے اور xAI کو بطور ماڈل فراہم کنندہ کنفیگر کرتا ہے۔
    - **OpenCode Zen (ملٹی-ماڈل پراکسی)**: `OPENCODE_API_KEY` (یا `OPENCODE_ZEN_API_KEY`، اسے https://opencode.ai/auth پر حاصل کریں) کے لیے پوچھتا ہے۔
    - **API key**: کلید آپ کے لیے محفوظ کرتا ہے۔
    - **Vercel AI Gateway (ملٹی-ماڈل پراکسی)**: `AI_GATEWAY_API_KEY` کے لیے پوچھتا ہے۔
    - مزید تفصیل: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: Account ID، Gateway ID، اور `CLOUDFLARE_AI_GATEWAY_API_KEY` کے لیے پوچھتا ہے۔
    - مزید تفصیل: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: کنفیگ خودکار طور پر لکھی جاتی ہے۔
    - مزید تفصیل: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: `SYNTHETIC_API_KEY` کے لیے پوچھتا ہے۔
    - مزید تفصیل: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: کنفیگ خودکار طور پر لکھی جاتی ہے۔
    - **Kimi Coding**: کنفیگ خودکار طور پر لکھی جاتی ہے۔
    - مزید تفصیل: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: ابھی کوئی تصدیق کنفیگر نہیں کی جاتی۔
    - معلوم شدہ اختیارات میں سے ایک ڈیفالٹ ماڈل منتخب کریں (یا فراہم کنندہ/ماڈل دستی طور پر درج کریں)۔
    - وزارڈ ماڈل چیک چلاتا ہے اور اگر کنفیگر کیا گیا ماڈل نامعلوم ہو یا تصدیق غائب ہو تو وارننگ دیتا ہے۔
    - OAuth اسناد `~/.openclaw/credentials/oauth.json` میں رہتی ہیں؛ auth پروفائلز `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` میں (API keys + OAuth)۔
    - مزید تفصیل: [/concepts/oauth](/concepts/oauth)
    <Note>
    ہیڈلیس/سرور مشورہ: براؤزر والی مشین پر OAuth مکمل کریں، پھر
    `~/.openclaw/credentials/oauth.json` (یا `$OPENCLAW_STATE_DIR/credentials/oauth.json`) کو
    گیٹ وے ہوسٹ پر کاپی کریں۔
    </Note>
  </Step>
  <Step title="ورک اسپیس">
    - ڈیفالٹ `~/.openclaw/workspace` (قابلِ کنفیگریشن)۔
    - ایجنٹ bootstrap رسم کے لیے درکار ورک اسپیس فائلز سیڈ کرتا ہے۔
    - مکمل ورک اسپیس لے آؤٹ + بیک اپ گائیڈ: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - پورٹ، bind، auth موڈ، tailscale ایکسپوژر۔
    - auth کی سفارش: loopback کے لیے بھی **Token** برقرار رکھیں تاکہ لوکل WS کلائنٹس کو تصدیق کرنا پڑے۔
    - auth صرف اسی صورت غیر فعال کریں جب آپ ہر لوکل پروسیس پر مکمل اعتماد رکھتے ہوں۔
    - نان‑loopback binds میں پھر بھی auth درکار ہے۔
  </Step>
  <Step title="چینلز">
    - [WhatsApp](/channels/whatsapp): اختیاری QR لاگ اِن۔
    - [Telegram](/channels/telegram): بوٹ ٹوکن۔
    - [Discord](/channels/discord): بوٹ ٹوکن۔
    - [Google Chat](/channels/googlechat): سروس اکاؤنٹ JSON + ویب ہوک آڈینس۔
    - [Mattermost](/channels/mattermost) (پلگ اِن): بوٹ ٹوکن + بیس URL۔
    - [Signal](/channels/signal): اختیاری `signal-cli` انسٹال + اکاؤنٹ کنفیگ۔
    - [BlueBubbles](/channels/bluebubbles): **iMessage کے لیے سفارش کردہ**؛ سرور URL + پاس ورڈ + ویب ہوک۔
    - [iMessage](/channels/imessage): پرانا `imsg` CLI راستہ + DB رسائی۔
    - DM سکیورٹی: ڈیفالٹ pairing ہے۔ پہلی DM ایک کوڈ بھیجتی ہے؛ `openclaw pairing approve <channel> <code>` کے ذریعے منظوری دیں یا allowlists استعمال کریں۔
  </Step>
  <Step title="Daemon انسٹال">
    - macOS: LaunchAgent
      - لاگ اِن شدہ یوزر سیشن درکار؛ ہیڈلیس کے لیے کسٹم LaunchDaemon استعمال کریں (شامل نہیں)۔
    - Linux (اور Windows بذریعہ WSL2): systemd یوزر یونٹ
      - وزارڈ `loginctl enable-linger <user>` کے ذریعے lingering فعال کرنے کی کوشش کرتا ہے تاکہ لاگ آؤٹ کے بعد بھی Gateway چلتا رہے۔
      - sudo کے لیے پرامپٹ ہو سکتا ہے ( `/var/lib/systemd/linger` لکھتا ہے)؛ پہلے sudo کے بغیر کوشش کرتا ہے۔
    - **Runtime انتخاب:** Node (سفارش کردہ؛ WhatsApp/Telegram کے لیے لازم)۔ Bun **سفارش نہیں** کیا جاتا۔
  </Step>
  <Step title="ہیلتھ چیک">
    - Gateway شروع کرتا ہے (اگر درکار ہو) اور `openclaw health` چلاتا ہے۔
    - مشورہ: `openclaw status --deep` اسٹیٹس آؤٹ پٹ میں gateway ہیلتھ پروبز شامل کرتا ہے (قابلِ رسائی gateway درکار)۔
  </Step>
  <Step title="Skills (سفارش کردہ)">
    - دستیاب skills پڑھتا ہے اور تقاضے چیک کرتا ہے۔
    - node مینیجر منتخب کرنے دیتا ہے: **npm / pnpm** (bun سفارش نہیں)۔
    - اختیاری dependencies انسٹال کرتا ہے (کچھ macOS پر Homebrew استعمال کرتی ہیں)۔
  </Step>
  <Step title="اختتام">
    - خلاصہ + اگلے اقدامات، جن میں اضافی خصوصیات کے لیے iOS/Android/macOS ایپس شامل ہیں۔
  </Step>
</Steps>

<Note>
اگر کوئی GUI دریافت نہ ہو، تو وزارڈ براؤزر کھولنے کے بجائے Control UI کے لیے SSH پورٹ‑فارورڈ ہدایات پرنٹ کرتا ہے۔
اگر Control UI اثاثے موجود نہ ہوں، تو وزارڈ انہیں بنانے کی کوشش کرتا ہے؛ متبادل `pnpm ui:build` ہے (UI deps خودکار طور پر انسٹال کرتا ہے)۔
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
`--json` کا مطلب **نان اِنٹرایکٹو موڈ نہیں** ہے۔ اسکرپٹس کے لیے `--non-interactive` (اور `--workspace`) استعمال کریں۔
</Note>

<AccordionGroup>
  <Accordion title="Gemini مثال">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI مثال">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway مثال">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway مثال">
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
  <Accordion title="Moonshot مثال">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic مثال">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen مثال">
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

Gateway وزارڈ فلو کو RPC کے ذریعے ایکسپوز کرتا ہے (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`)۔
کلائنٹس (macOS ایپ، Control UI) آن بورڈنگ لاجک دوبارہ نافذ کیے بغیر مراحل رینڈر کر سکتے ہیں۔

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

WhatsApp اسناد `~/.openclaw/credentials/whatsapp/<accountId>/` کے تحت جاتی ہیں۔
سیشنز `~/.openclaw/agents/<agentId>/sessions/` کے تحت محفوظ ہوتے ہیں۔

کچھ چینلز پلگ اِنز کے طور پر فراہم کیے جاتے ہیں۔ آن بورڈنگ کے دوران جب آپ کسی ایک کا انتخاب کرتے ہیں، تو وزارڈ
اسے کنفیگر کرنے سے پہلے انسٹال کرنے (npm یا لوکل راستہ) کے لیے پرامپٹ کرے گا۔

## متعلقہ دستاویزات

- وزارڈ جائزہ: [Onboarding Wizard](/start/wizard)
- macOS ایپ آن بورڈنگ: [Onboarding](/start/onboarding)
- کنفیگ حوالہ: [Gateway configuration](/gateway/configuration)
- فراہم کنندگان: [WhatsApp](/channels/whatsapp)، [Telegram](/channels/telegram)، [Discord](/channels/discord)، [Google Chat](/channels/googlechat)، [Signal](/channels/signal)، [BlueBubbles](/channels/bluebubbles) (iMessage)، [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills)، [Skills config](/tools/skills-config)
