---
summary: "OpenClaw کو محفوظ طریقے سے اپ ڈیٹ کرنا (گلوبل انسٹال یا سورس)، نیز رول بیک کی حکمتِ عملی"
read_when:
  - OpenClaw کو اپ ڈیٹ کرنا
  - اپ ڈیٹ کے بعد کچھ خراب ہو جائے
title: "اپ ڈیٹنگ"
---

# اپ ڈیٹنگ

OpenClaw تیزی سے آگے بڑھ رہا ہے ("1.0" سے پہلے)۔ اپڈیٹس کو انفراسٹرکچر شپنگ کی طرح سمجھیں: اپڈیٹ → چیکس چلائیں → ری اسٹارٹ (یا `openclaw update` استعمال کریں، جو ری اسٹارٹ کرتا ہے) → تصدیق کریں۔

## سفارش کردہ: ویب سائٹ انسٹالر دوبارہ چلائیں (اسی جگہ اپ گریڈ)

**ترجیحی** اپڈیٹ راستہ ویب سائٹ سے انسٹالر کو دوبارہ چلانا ہے۔ یہ
موجودہ انسٹالز کو ڈٹیکٹ کرتا ہے، جگہ پر اپگریڈ کرتا ہے، اور ضرورت پڑنے پر `openclaw doctor` چلاتا ہے۔

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

نوٹس:

- اگر آپ نہیں چاہتے کہ آن بورڈنگ وزرڈ دوبارہ چلے تو `--no-onboard` شامل کریں۔

- **سورس انسٹالز** کے لیے استعمال کریں:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  انسٹالر **صرف** اسی صورت میں `git pull --rebase` کرے گا جب ریپو صاف ہو۔

- **گلوبل انسٹالز** کے لیے، اسکرپٹ اندرونی طور پر `npm install -g openclaw@latest` استعمال کرتا ہے۔

- لیگیسی نوٹ: `clawdbot` مطابقتی شِم کے طور پر دستیاب رہتا ہے۔

## اپ ڈیٹ سے پہلے

- جانیں کہ آپ نے کیسے انسٹال کیا: **گلوبل** (npm/pnpm) بمقابلہ **سورس سے** (git clone)۔
- جانیں کہ آپ کا Gateway کیسے چل رہا ہے: **فرنٹ گراؤنڈ ٹرمینل** بمقابلہ **نگرانی شدہ سروس** (launchd/systemd)۔
- اپنی تخصیصات کا اسنیپ شاٹ لیں:
  - کنفیگ: `~/.openclaw/openclaw.json`
  - اسناد: `~/.openclaw/credentials/`
  - ورک اسپیس: `~/.openclaw/workspace`

## اپ ڈیٹ (گلوبل انسٹال)

گلوبل انسٹال (ایک منتخب کریں):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

ہم Gateway رَن ٹائم کے لیے Bun کی **سفارش نہیں** کرتے (WhatsApp/Telegram بگز)۔

اپ ڈیٹ چینلز تبدیل کرنے کے لیے (git + npm انسٹالز):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

کسی ایک بار کے انسٹال ٹیگ/ورژن کے لیے `--tag <dist-tag|version>` استعمال کریں۔

چینل کی معنویت اور ریلیز نوٹس کے لیے [Development channels](/install/development-channels) دیکھیں۔

نوٹ: npm انسٹالز میں، گیٹ وے اسٹارٹ اپ پر ایک اپڈیٹ ہنٹ لاگ کرتا ہے (موجودہ چینل ٹیگ چیک کرتا ہے)۔ `update.checkOnStart: false` کے ذریعے غیر فعال کریں۔

پھر:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

نوٹس:

- اگر آپ کا Gateway بطور سروس چل رہا ہے، تو PIDs کو ختم کرنے کے بجائے `openclaw gateway restart` ترجیحی ہے۔
- اگر آپ کسی مخصوص ورژن پر پن ہیں، تو نیچے “Rollback / pinning” دیکھیں۔

## اپ ڈیٹ (`openclaw update`)

**سورس انسٹالز** (git checkout) کے لیے ترجیح دیں:

```bash
openclaw update
```

یہ ایک نسبتاً محفوظ اپ ڈیٹ فلو چلاتا ہے:

- صاف ورک ٹری درکار ہے۔
- منتخب چینل (ٹیگ یا برانچ) پر سوئچ کرتا ہے۔
- کنفیگرڈ اپ اسٹریم (dev چینل) کے خلاف فِیچ + ری بیس کرتا ہے۔
- ڈپس انسٹال کرتا ہے، بلڈ کرتا ہے، کنٹرول UI بناتا ہے، اور `openclaw doctor` چلاتا ہے۔
- بطورِ طے شدہ gateway ری اسٹارٹ کرتا ہے (اسکِپ کرنے کے لیے `--no-restart` استعمال کریں)۔

اگر آپ نے **npm/pnpm** کے ذریعے انسٹال کیا ہے (git میٹا ڈیٹا کے بغیر)، تو `openclaw update` آپ کے پیکیج مینیجر کے ذریعے اپڈیٹ کرنے کی کوشش کرے گا۔ اگر یہ انسٹال کو ڈٹیکٹ نہیں کر سکتا تو اس کے بجائے “Update (global install)” استعمال کریں۔

## اپ ڈیٹ (Control UI / RPC)

The Control UI has **Update & Restart** (RPC: `update.run`). It:

1. `openclaw update` جیسا ہی سورس-اپ ڈیٹ فلو چلاتا ہے (صرف git checkout)۔
2. ایک اسٹرکچرڈ رپورٹ (stdout/stderr ٹیل) کے ساتھ ری اسٹارٹ سینٹینل لکھتا ہے۔
3. gateway کو ری اسٹارٹ کرتا ہے اور رپورٹ کے ساتھ آخری فعال سیشن کو پِنگ کرتا ہے۔

اگر ری بیس ناکام ہو جائے، تو gateway اپ ڈیٹ لاگو کیے بغیر ابورٹ کر کے ری اسٹارٹ ہو جاتا ہے۔

## اپ ڈیٹ (سورس سے)

ریپو checkout سے:

ترجیحی:

```bash
openclaw update
```

دستی (تقریباً مساوی):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

نوٹس:

- `pnpm build` اس وقت اہم ہے جب آپ پیکج شدہ `openclaw` بائنری ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) چلاتے ہیں یا Node کے ذریعے `dist/` چلاتے ہیں۔
- اگر آپ گلوبل انسٹال کے بغیر ریپو checkout سے چلا رہے ہیں، تو CLI کمانڈز کے لیے `pnpm openclaw ...` استعمال کریں۔
- اگر آپ براہِ راست TypeScript سے چلاتے ہیں (`pnpm openclaw ...`)، تو عام طور پر ری بلڈ ضروری نہیں، لیکن **کنفیگ مائیگریشنز اب بھی لاگو ہوتی ہیں** → doctor چلائیں۔
- گلوبل اور git انسٹالز کے درمیان سوئچ کرنا آسان ہے: دوسرا فلیور انسٹال کریں، پھر `openclaw doctor` چلائیں تاکہ gateway سروس اینٹری پوائنٹ موجودہ انسٹال پر دوبارہ لکھا جائے۔

## ہمیشہ چلائیں: `openclaw doctor`

Doctor ایک “محفوظ اپڈیٹ” کمانڈ ہے۔ یہ جان بوجھ کر بورنگ ہے: مرمت + مائیگریٹ + وارن۔

نوٹ: اگر آپ **سورس انسٹال** (git checkout) پر ہیں، تو `openclaw doctor` پہلے `openclaw update` چلانے کی پیشکش کرے گا۔

عام طور پر یہ یہ کام کرتا ہے:

- متروک کنفیگ کیز / لیگیسی کنفیگ فائل مقامات کی مائیگریشن۔
- DM پالیسیوں کا آڈٹ اور خطرناک “اوپن” سیٹنگز پر وارننگ۔
- Gateway کی صحت چیک کرتا ہے اور ری اسٹارٹ کی پیشکش کر سکتا ہے۔
- پرانی gateway سروسز (launchd/systemd؛ لیگیسی schtasks) کو موجودہ OpenClaw سروسز میں ڈیٹیکٹ اور مائیگریٹ کرتا ہے۔
- Linux پر systemd یوزر lingering کو یقینی بناتا ہے (تاکہ Gateway لاگ آؤٹ کے بعد بھی چلتا رہے)۔

تفصیلات: [Doctor](/gateway/doctor)

## Gateway کو شروع / بند / ری اسٹارٹ کریں

CLI (OS سے قطع نظر کام کرتا ہے):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

اگر آپ نگرانی شدہ ہیں:

- macOS launchd (ایپ-بنڈلڈ LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (استعمال کریں `bot.molt.<profile>``; پرانا `com.openclaw.\*\` اب بھی کام کرتا ہے)
- Linux systemd یوزر سروس: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` صرف اسی صورت میں کام کرتے ہیں جب سروس انسٹال ہو؛ ورنہ `openclaw gateway install` چلائیں۔

رن بک + عین سروس لیبلز: [Gateway runbook](/gateway)

## رول بیک / پننگ (جب کچھ خراب ہو جائے)

### پن (گلوبل انسٹال)

ایک معلوم-درست ورژن انسٹال کریں (`<version>` کو آخری کام کرنے والے سے بدلیں):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

مشورہ: موجودہ شائع شدہ ورژن دیکھنے کے لیے `npm view openclaw version` چلائیں۔

پھر ری اسٹارٹ کریں + doctor دوبارہ چلائیں:

```bash
openclaw doctor
openclaw gateway restart
```

### تاریخ کے مطابق پن (سورس)

کسی تاریخ سے کمٹ منتخب کریں (مثال: “2026-01-01 تک main کی حالت”):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

پھر ڈپس دوبارہ انسٹال کریں + ری اسٹارٹ:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

اگر بعد میں تازہ ترین پر واپس جانا ہو:

```bash
git checkout main
git pull
```

## اگر آپ پھنس گئے ہیں

- `openclaw doctor` دوبارہ چلائیں اور آؤٹ پٹ غور سے پڑھیں (اکثر یہ حل بتا دیتا ہے)۔
- دیکھیں: [خرابیوں کا ازالہ](/gateway/troubleshooting)
- Discord میں پوچھیں: [https://discord.gg/clawd](https://discord.gg/clawd)
