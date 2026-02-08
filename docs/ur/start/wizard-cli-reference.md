---
summary: "CLI آن بورڈنگ فلو، تصدیق/ماڈل سیٹ اپ، آؤٹ پٹس، اور اندرونی پہلوؤں کے لیے مکمل حوالہ"
read_when:
  - آپ کو openclaw آن بورڈ کے لیے تفصیلی رویّہ درکار ہو
  - آپ آن بورڈنگ کے نتائج ڈیبگ کر رہے ہوں یا آن بورڈنگ کلائنٹس ضم کر رہے ہوں
title: "CLI آن بورڈنگ حوالہ"
sidebarTitle: "CLI حوالہ"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:04Z
---

# CLI آن بورڈنگ حوالہ

یہ صفحہ `openclaw onboard` کے لیے مکمل حوالہ ہے۔
مختصر رہنمائی کے لیے، [Onboarding Wizard (CLI)](/start/wizard) دیکھیں۔

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
یہ ریموٹ ہوسٹ پر کچھ بھی انسٹال یا ترمیم نہیں کرتا۔

## لوکل فلو کی تفصیلات

<Steps>
  <Step title="موجودہ کنفیگ کی شناخت">
    - اگر `~/.openclaw/openclaw.json` موجود ہو تو Keep، Modify، یا Reset منتخب کریں۔
    - وزارڈ کو دوبارہ چلانے سے کچھ بھی حذف نہیں ہوتا جب تک آپ واضح طور پر Reset منتخب نہ کریں (یا `--reset` پاس نہ کریں)۔
    - اگر کنفیگ غیر معتبر ہو یا اس میں پرانی keys ہوں تو وزارڈ رک جاتا ہے اور جاری رکھنے سے پہلے `openclaw doctor` چلانے کا کہتا ہے۔
    - Reset میں `trash` استعمال ہوتا ہے اور دائرہ کار کے اختیارات پیش کیے جاتے ہیں:
      - صرف کنفیگ
      - کنفیگ + اسناد + سیشنز
      - مکمل ری سیٹ (ورک اسپیس بھی حذف کرتا ہے)
  </Step>
  <Step title="ماڈل اور تصدیق">
    - مکمل اختیارات کی فہرست [Auth and model options](#auth-and-model-options) میں ہے۔
  </Step>
  <Step title="ورک اسپیس">
    - بطورِ طے شدہ `~/.openclaw/workspace` (قابلِ کنفیگریشن)۔
    - پہلی بار رَن کے بوٹ اسٹرَیپ رِچول کے لیے درکار ورک اسپیس فائلیں سیڈ کرتا ہے۔
    - ورک اسپیس لے آؤٹ: [Agent workspace](/concepts/agent-workspace)۔
  </Step>
  <Step title="Gateway">
    - پورٹ، بائنڈ، تصدیقی موڈ، اور tailscale ایکسپوژر کے لیے پرامپٹ کرتا ہے۔
    - سفارش کردہ: لوکل loopback کے لیے بھی ٹوکن تصدیق فعال رکھیں تاکہ لوکل WS کلائنٹس کو تصدیق کرنا پڑے۔
    - تصدیق صرف اسی صورت غیر فعال کریں جب آپ ہر لوکل پروسیس پر مکمل اعتماد رکھتے ہوں۔
    - نان-loopback بائنڈز کے لیے بھی تصدیق لازم ہے۔
  </Step>
  <Step title="چینلز">
    - [WhatsApp](/channels/whatsapp): اختیاری QR لاگ اِن
    - [Telegram](/channels/telegram): بوٹ ٹوکن
    - [Discord](/channels/discord): بوٹ ٹوکن
    - [Google Chat](/channels/googlechat): سروس اکاؤنٹ JSON + ویب ہُک آڈیئنس
    - [Mattermost](/channels/mattermost) پلگ اِن: بوٹ ٹوکن + بیس URL
    - [Signal](/channels/signal): اختیاری `signal-cli` انسٹال + اکاؤنٹ کنفیگ
    - [BlueBubbles](/channels/bluebubbles): iMessage کے لیے سفارش کردہ؛ سرور URL + پاس ورڈ + ویب ہُک
    - [iMessage](/channels/imessage): لیگیسی `imsg` CLI پاتھ + DB رسائی
    - DM سکیورٹی: بطورِ طے شدہ pairing۔ پہلی DM ایک کوڈ بھیجتی ہے؛ منظوری دیں
      `openclaw pairing approve <channel> <code>` کے ذریعے یا allowlists استعمال کریں۔
  </Step>
  <Step title="ڈیمَن انسٹال">
    - macOS: LaunchAgent
      - لاگ اِن شدہ یوزر سیشن درکار؛ headless کے لیے کسٹم LaunchDaemon استعمال کریں (شامل نہیں)۔
    - Linux اور Windows بذریعہ WSL2: systemd یوزر یونٹ
      - وزارڈ `loginctl enable-linger <user>` کی کوشش کرتا ہے تاکہ لاگ آؤٹ کے بعد بھی gateway چلتا رہے۔
      - sudo کے لیے پرامپٹ ہو سکتا ہے (لکھتا ہے `/var/lib/systemd/linger`)؛ پہلے بغیر sudo کوشش کرتا ہے۔
    - رن ٹائم انتخاب: Node (سفارش کردہ؛ WhatsApp اور Telegram کے لیے لازم)۔ Bun سفارش نہیں کیا جاتا۔
  </Step>
  <Step title="ہیلتھ چیک">
    - gateway شروع کرتا ہے (اگر درکار ہو) اور `openclaw health` چلاتا ہے۔
    - `openclaw status --deep` اسٹیٹس آؤٹ پٹ میں gateway ہیلتھ پروبز شامل کرتا ہے۔
  </Step>
  <Step title="Skills">
    - دستیاب Skills پڑھتا ہے اور تقاضے چیک کرتا ہے۔
    - نوڈ مینیجر منتخب کرنے دیتا ہے: npm یا pnpm (bun سفارش نہیں کیا جاتا)۔
    - اختیاری dependencies انسٹال کرتا ہے (کچھ macOS پر Homebrew استعمال کرتے ہیں)۔
  </Step>
  <Step title="اختتام">
    - خلاصہ اور اگلے اقدامات، بشمول iOS، Android، اور macOS ایپ کے اختیارات۔
  </Step>
</Steps>

<Note>
اگر کوئی GUI شناخت نہ ہو تو وزارڈ براؤزر کھولنے کے بجائے Control UI کے لیے SSH پورٹ-فارورڈ ہدایات پرنٹ کرتا ہے۔
اگر Control UI اثاثے غائب ہوں تو وزارڈ انہیں بنانے کی کوشش کرتا ہے؛ فال بیک `pnpm ui:build` ہے (UI dependencies خودکار طور پر انسٹال کرتا ہے)۔
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
- اگر gateway صرف loopback تک محدود ہو تو SSH ٹنلنگ یا tailnet استعمال کریں۔
- ڈسکوری اشارے:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## تصدیق اور ماڈل کے اختیارات

<AccordionGroup>
  <Accordion title="Anthropic API کلید (سفارش کردہ)">
    اگر موجود ہو تو `ANTHROPIC_API_KEY` استعمال کرتا ہے یا کلید کے لیے پرامپٹ کرتا ہے، پھر ڈیمَن کے استعمال کے لیے محفوظ کرتا ہے۔
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: Keychain آئٹم "Claude Code-credentials" چیک کرتا ہے
    - Linux اور Windows: اگر موجود ہو تو `~/.claude/.credentials.json` دوبارہ استعمال کرتا ہے

    macOS پر "Always Allow" منتخب کریں تاکہ launchd اسٹارٹس بلاک نہ ہوں۔

  </Accordion>
  <Accordion title="Anthropic ٹوکن (setup-token پیسٹ)">
    کسی بھی مشین پر `claude setup-token` چلائیں، پھر ٹوکن پیسٹ کریں۔
    آپ اسے نام دے سکتے ہیں؛ خالی چھوڑنے پر ڈیفالٹ استعمال ہوتا ہے۔
  </Accordion>
  <Accordion title="OpenAI Code سبسکرپشن (Codex CLI ری یوز)">
    اگر `~/.codex/auth.json` موجود ہو تو وزارڈ اسے دوبارہ استعمال کر سکتا ہے۔
  </Accordion>
  <Accordion title="OpenAI Code سبسکرپشن (OAuth)">
    براؤزر فلو؛ `code#state` پیسٹ کریں۔

    جب ماڈل غیر سیٹ ہو یا `openai/*` ہو تو `agents.defaults.model` کو `openai-codex/gpt-5.3-codex` پر سیٹ کرتا ہے۔

  </Accordion>
  <Accordion title="OpenAI API کلید">
    اگر موجود ہو تو `OPENAI_API_KEY` استعمال کرتا ہے یا کلید کے لیے پرامپٹ کرتا ہے، پھر اسے
    `~/.openclaw/.env` میں محفوظ کرتا ہے تاکہ launchd اسے پڑھ سکے۔

    جب ماڈل غیر سیٹ ہو، `openai/*` ہو، یا `openai-codex/*` ہو تو `agents.defaults.model` کو `openai/gpt-5.1-codex` پر سیٹ کرتا ہے۔

  </Accordion>
  <Accordion title="xAI (Grok) API کلید">
    `XAI_API_KEY` کے لیے پرامپٹ کرتا ہے اور xAI کو ماڈل فراہم کنندہ کے طور پر کنفیگر کرتا ہے۔
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY` (یا `OPENCODE_ZEN_API_KEY`) کے لیے پرامپٹ کرتا ہے۔
    سیٹ اپ URL: [opencode.ai/auth](https://opencode.ai/auth)۔
  </Accordion>
  <Accordion title="API کلید (جنرل)">
    کلید آپ کے لیے محفوظ کرتا ہے۔
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` کے لیے پرامپٹ کرتا ہے۔
    مزید تفصیل: [Vercel AI Gateway](/providers/vercel-ai-gateway)۔
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    اکاؤنٹ ID، gateway ID، اور `CLOUDFLARE_AI_GATEWAY_API_KEY` کے لیے پرامپٹ کرتا ہے۔
    مزید تفصیل: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)۔
  </Accordion>
  <Accordion title="MiniMax M2.1">
    کنفیگ خودکار طور پر لکھی جاتی ہے۔
    مزید تفصیل: [MiniMax](/providers/minimax)۔
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY` کے لیے پرامپٹ کرتا ہے۔
    مزید تفصیل: [Synthetic](/providers/synthetic)۔
  </Accordion>
  <Accordion title="Moonshot اور Kimi Coding">
    Moonshot (Kimi K2) اور Kimi Coding کی کنفیگز خودکار طور پر لکھی جاتی ہیں۔
    مزید تفصیل: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)۔
  </Accordion>
  <Accordion title="اسکِپ">
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

WhatsApp اسناد `~/.openclaw/credentials/whatsapp/<accountId>/` کے تحت جاتی ہیں۔
سیشنز `~/.openclaw/agents/<agentId>/sessions/` کے تحت محفوظ ہوتے ہیں۔

<Note>
کچھ چینلز پلگ اِنز کے طور پر فراہم کیے جاتے ہیں۔ آن بورڈنگ کے دوران منتخب کرنے پر، وزارڈ
چینل کنفیگریشن سے پہلے پلگ اِن انسٹال کرنے کے لیے پرامپٹ کرتا ہے (npm یا لوکل پاتھ)۔
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
