---
summary: "CLI آن بورڈنگ وزارڈ: گیٹ وے، ورک اسپیس، چینلز، اور Skills کے لیے رہنمائی کے ساتھ سیٹ اپ"
read_when:
  - آن بورڈنگ وزارڈ چلانا یا کنفیگر کرنا
  - نئی مشین سیٹ اپ کرنا
title: "آن بورڈنگ وزارڈ (CLI)"
sidebarTitle: "آن بورڈنگ: CLI"
x-i18n:
  source_path: start/wizard.md
  source_hash: 5495d951a2d78ffb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:45Z
---

# آن بورڈنگ وزارڈ (CLI)

آن بورڈنگ وزارڈ macOS،
Linux، یا Windows (WSL2 کے ذریعے؛ سختی سے سفارش کردہ) پر OpenClaw سیٹ اپ کرنے کا **سفارش کردہ** طریقہ ہے۔
یہ ایک ہی رہنمائی شدہ عمل میں مقامی Gateway یا ریموٹ Gateway کنکشن، نیز چینلز، Skills،
اور ورک اسپیس کی طے شدہ ترتیبات کنفیگر کرتا ہے۔

```bash
openclaw onboard
```

<Info>
سب سے تیز پہلا چیٹ: Control UI کھولیں (چینل سیٹ اپ درکار نہیں)۔ چلائیں
`openclaw dashboard` اور براؤزر میں چیٹ کریں۔ دستاویزات: [Dashboard](/web/dashboard)۔
</Info>

بعد میں دوبارہ کنفیگر کرنے کے لیے:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` کا مطلب غیر تعاملی موڈ نہیں ہے۔ اسکرپٹس کے لیے `--non-interactive` استعمال کریں۔
</Note>

<Tip>
سفارش کردہ: Brave Search API کلید سیٹ اپ کریں تاکہ ایجنٹ `web_search` استعمال کر سکے
(`web_fetch` کلید کے بغیر بھی کام کرتا ہے)۔ سب سے آسان راستہ: `openclaw configure --section web`
جو `tools.web.search.apiKey` محفوظ کرتا ہے۔ دستاویزات: [Web tools](/tools/web)۔
</Tip>

## QuickStart بمقابلہ Advanced

وزارڈ **QuickStart** (ڈیفالٹس) بمقابلہ **Advanced** (مکمل کنٹرول) سے شروع ہوتا ہے۔

<Tabs>
  <Tab title="QuickStart (defaults)">
    - مقامی gateway (loopback)
    - ورک اسپیس ڈیفالٹ (یا موجودہ ورک اسپیس)
    - Gateway پورٹ **18789**
    - Gateway تصدیق **Token** (خودکار طور پر تیار شدہ، حتیٰ کہ loopback پر بھی)
    - Tailscale ایکسپوژر **Off**
    - Telegram + WhatsApp DMs بطورِ ڈیفالٹ **allowlist** پر (آپ سے فون نمبر پوچھا جائے گا)
  </Tab>
  <Tab title="Advanced (full control)">
    - ہر مرحلہ ظاہر کرتا ہے (موڈ، ورک اسپیس، گیٹ وے، چینلز، ڈیمون، Skills)۔
  </Tab>
</Tabs>

## وزارڈ کیا کنفیگر کرتا ہے

**Local mode (default)** آپ کو ان مراحل سے گزارتا ہے:

1. **Model/Auth** — Anthropic API کلید (سفارش کردہ)، OAuth، OpenAI، یا دیگر فراہم کنندگان۔ ایک ڈیفالٹ ماڈل منتخب کریں۔
2. **Workspace** — ایجنٹ فائلوں کے لیے مقام (ڈیفالٹ `~/.openclaw/workspace`)۔ بوٹ اسٹرَیپ فائلیں شامل کرتا ہے۔
3. **Gateway** — پورٹ، بائنڈ ایڈریس، تصدیقی موڈ، Tailscale ایکسپوژر۔
4. **Channels** — WhatsApp، Telegram، Discord، Google Chat، Mattermost، Signal، BlueBubbles، یا iMessage۔
5. **Daemon** — LaunchAgent (macOS) یا systemd یوزر یونٹ (Linux/WSL2) انسٹال کرتا ہے۔
6. **Health check** — Gateway شروع کرتا ہے اور تصدیق کرتا ہے کہ یہ چل رہا ہے۔
7. **Skills** — سفارش کردہ Skills اور اختیاری dependencies انسٹال کرتا ہے۔

<Note>
وزارڈ کو دوبارہ چلانے سے **کچھ بھی** حذف نہیں ہوتا جب تک آپ واضح طور پر **Reset** منتخب نہ کریں (یا `--reset` پاس نہ کریں)۔
اگر کنفیگ غلط ہو یا اس میں legacy کیز شامل ہوں، تو وزارڈ آپ سے پہلے `openclaw doctor` چلانے کو کہتا ہے۔
</Note>

**Remote mode** صرف مقامی کلائنٹ کو کسی اور جگہ موجود Gateway سے کنیکٹ کرنے کے لیے کنفیگر کرتا ہے۔
یہ ریموٹ ہوسٹ پر کچھ بھی انسٹال یا تبدیل **نہیں** کرتا۔

## ایک اور ایجنٹ شامل کریں

`openclaw agents add <name>` استعمال کریں تاکہ الگ ورک اسپیس،
سیشنز، اور تصدیقی پروفائلز کے ساتھ ایک علیحدہ ایجنٹ بنایا جا سکے۔ `--workspace` کے بغیر چلانے سے وزارڈ لانچ ہو جاتا ہے۔

یہ کیا سیٹ کرتا ہے:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

نوٹس:

- ڈیفالٹ ورک اسپیسز `~/.openclaw/workspace-<agentId>` کی پیروی کرتی ہیں۔
- آنے والے پیغامات روٹ کرنے کے لیے `bindings` شامل کریں (وزارڈ یہ کر سکتا ہے)۔
- غیر تعاملی فلیگز: `--model`, `--agent-dir`, `--bind`, `--non-interactive`۔

## مکمل حوالہ

تفصیلی مرحلہ وار وضاحتوں، غیر تعاملی اسکرپٹنگ، Signal سیٹ اپ،
RPC API، اور ان تمام کنفیگ فیلڈز کی مکمل فہرست کے لیے جو وزارڈ لکھتا ہے، ملاحظہ کریں
[Wizard Reference](/reference/wizard)۔

## متعلقہ دستاویزات

- CLI کمانڈ حوالہ: [`openclaw onboard`](/cli/onboard)
- macOS ایپ آن بورڈنگ: [Onboarding](/start/onboarding)
- ایجنٹ فرسٹ رن رسم: [Agent Bootstrapping](/start/bootstrapping)
