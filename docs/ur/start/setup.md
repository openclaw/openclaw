---
summary: "OpenClaw کے لیے جدید سیٹ اپ اور ڈویلپمنٹ ورک فلو"
read_when:
  - نئی مشین سیٹ اپ کرتے وقت
  - آپ اپنی ذاتی سیٹ اپ کو متاثر کیے بغیر “تازہ ترین + بہترین” چاہتے ہوں
title: "سیٹ اپ"
---

# سیٹ اپ

<Note>
9. ایجنٹ کی طرف سے بھیجی جانے والی آؤٹ باؤنڈ اٹیچمنٹس: اپنی الگ لائن میں `MEDIA:<path-or-url>` شامل کریں (بغیر اسپیس کے)۔
10. اگر آپ پہلی بار سیٹ اپ کر رہے ہیں تو [Getting Started](/start/getting-started) سے آغاز کریں۔
</Note>

آخری تازہ کاری: 2026-01-01

## TL;DR

- **حسبِ ضرورت تبدیلیاں ریپو کے باہر رکھیں:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config)۔
- **مستحکم ورک فلو:** macOS ایپ انسٹال کریں؛ اسے بنڈل شدہ Gateway چلانے دیں۔
- **انتہائی جدید ورک فلو:** `pnpm gateway:watch` کے ذریعے Gateway خود چلائیں، پھر macOS ایپ کو Local موڈ میں اٹیچ ہونے دیں۔

## پیشگی تقاضے (سورس سے)

- Node `>=22`
- `pnpm`
- Docker (اختیاری؛ صرف کنٹینرائزڈ سیٹ اپ/e2e کے لیے — [Docker](/install/docker) دیکھیں)

## حسبِ ضرورت بنانے کی حکمتِ عملی (تاکہ اپ ڈیٹس نقصان نہ پہنچائیں)

اگر آپ “100% میرے مطابق” _اور_ آسان اپ ڈیٹس چاہتے ہیں، تو اپنی تخصیصات یہاں رکھیں:

- **کنفیگ:** `~/.openclaw/openclaw.json` (JSON/JSON5 طرز)
- **ورک اسپیس:** `~/.openclaw/workspace` (skills، prompts، memories؛ اسے نجی git ریپو بنائیں)

ایک بار بوٹ اسٹرَیپ کریں:

```bash
openclaw setup
```

اسی ریپو کے اندر سے مقامی CLI انٹری استعمال کریں:

```bash
openclaw setup
```

اگر ابھی عالمی انسٹال موجود نہیں، تو اسے `pnpm openclaw setup` کے ذریعے چلائیں۔

## اس ریپو سے Gateway چلائیں

`pnpm build` کے بعد، آپ پیکج شدہ CLI براہِ راست چلا سکتے ہیں:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## مستحکم ورک فلو (macOS ایپ پہلے)

1. **OpenClaw.app** انسٹال کریں اور لانچ کریں (مینو بار)۔
2. آن بورڈنگ/اجازتوں کی چیک لسٹ مکمل کریں (TCC پرامپٹس)۔
3. یقینی بنائیں کہ Gateway **Local** ہے اور چل رہا ہے (ایپ اسے منیج کرتی ہے)۔
4. سرفیسز لنک کریں (مثال: WhatsApp):

```bash
openclaw channels login
```

5. سینیٹی چیک:

```bash
openclaw health
```

اگر آپ کی بلڈ میں آن بورڈنگ دستیاب نہیں:

- `openclaw setup` چلائیں، پھر `openclaw channels login`، پھر Gateway دستی طور پر شروع کریں (`openclaw gateway`)۔

## انتہائی جدید ورک فلو (Gateway ٹرمینل میں)

مقصد: TypeScript Gateway پر کام کرنا، ہاٹ ری لوڈ حاصل کرنا، اور macOS ایپ UI کو منسلک رکھنا۔

### 0. (اختیاری) macOS ایپ بھی سورس سے چلائیں

اگر آپ macOS ایپ کو بھی جدید ترین رکھنا چاہتے ہیں:

```bash
./scripts/restart-mac.sh
```

### 1. ڈیو Gateway شروع کریں

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` واچ موڈ میں gateway چلاتا ہے اور TypeScript تبدیلیوں پر ری لوڈ کرتا ہے۔

### 2. macOS ایپ کو اپنے چلتے ہوئے Gateway کی طرف پوائنٹ کریں

**OpenClaw.app** میں:

- کنکشن موڈ: **Local**
  ایپ کنفیگر شدہ پورٹ پر چلتے ہوئے gateway سے اٹیچ ہو جائے گی۔

### 3. تصدیق کریں

- ایپ کے اندر Gateway اسٹیٹس **“Using existing gateway …”** دکھانا چاہیے
- یا CLI کے ذریعے:

```bash
openclaw health
```

### عام مسائل

- **غلط پورٹ:** Gateway WS بطورِ طے شدہ `ws://127.0.0.1:18789` ہے؛ ایپ + CLI کو ایک ہی پورٹ پر رکھیں۔
- **اسٹیٹ کہاں رہتی ہے:**
  - اسناد: `~/.openclaw/credentials/`
  - سیشنز: `~/.openclaw/agents/<agentId>/sessions/`
  - لاگز: `/tmp/openclaw/`

## اسناد کے ذخیرے کا نقشہ

تصدیق کی ڈیبگنگ یا بیک اپ کا فیصلہ کرتے وقت اس کا استعمال کریں:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram بوٹ ٹوکن**: کنفیگ/env یا `channels.telegram.tokenFile`
- **Discord بوٹ ٹوکن**: کنفیگ/env (ٹوکن فائل ابھی سپورٹڈ نہیں)
- **Slack ٹوکنز**: کنفیگ/env (`channels.slack.*`)
- **جوڑی بنانے کی اجازت فہرستیں**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **ماڈل آتھنٹیکیشن پروفائلز**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **لیگیسی OAuth امپورٹ**: `~/.openclaw/credentials/oauth.json`
  مزید تفصیل: [سکیورٹی](/gateway/security#credential-storage-map)۔

## اپ ڈیٹنگ (آپ کی سیٹ اپ کو نقصان پہنچائے بغیر)

- `~/.openclaw/workspace` اور `~/.openclaw/` کو “آپ کا مواد” رکھیں؛ ذاتی prompts/کنفیگ کو `openclaw` ریپو میں مت ڈالیں۔
- سورس اپ ڈیٹ کرنا: `git pull` + `pnpm install` (جب لاک فائل بدلی ہو) + `pnpm gateway:watch` استعمال کرتے رہیں۔

## Linux (systemd یوزر سروس)

11. وزرڈ کی تفصیلات کے لیے [Onboarding Wizard](/start/wizard) دیکھیں۔ 12. لینکس انسٹالز systemd **user** سروس استعمال کرتے ہیں۔ 13. ڈیفالٹ طور پر، systemd لاگ آؤٹ/آئیڈل پر یوزر سروسز بند کر دیتا ہے، جس سے گیٹ وے ختم ہو جاتا ہے۔ 14. آن بورڈنگ آپ کے لیے lingering کو فعال کرنے کی کوشش کرتا ہے (sudo کا مطالبہ ہو سکتا ہے)۔

```bash
sudo loginctl enable-linger $USER
```

15. اگر یہ اب بھی بند ہو تو چلائیں: See [Gateway runbook](/gateway) for the systemd notes.

## متعلقہ دستاویزات

- [Gateway runbook](/gateway) (فلیگز، نگرانی، پورٹس)
- [Gateway configuration](/gateway/configuration) (کنفیگ اسکیما + مثالیں)
- [Discord](/channels/discord) اور [Telegram](/channels/telegram) (reply tags + replyToMode سیٹنگز)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway لائف سائیکل)
