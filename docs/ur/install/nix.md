---
summary: "Nix کے ساتھ OpenClaw کو اعلامی انداز میں انسٹال کریں"
read_when:
  - آپ قابلِ اعادہ اور رول بیک کے قابل انسٹالز چاہتے ہیں
  - آپ پہلے ہی Nix/NixOS/Home Manager استعمال کر رہے ہیں
  - آپ چاہتے ہیں کہ ہر چیز پن شدہ ہو اور اعلامی طور پر منظم ہو
title: "Nix"
---

# Nix انسٹالیشن

Nix کے ساتھ OpenClaw چلانے کا تجویز کردہ طریقہ **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** کے ذریعے ہے — ایک batteries-included Home Manager ماڈیول۔

## فوری آغاز

یہ اپنے AI ایجنٹ (Claude، Cursor، وغیرہ) میں پیسٹ کریں:

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 مکمل رہنمائی: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw ریپو Nix انسٹالیشن کے لیے ماخذِ حقیقت ہے۔ یہ صفحہ صرف ایک فوری جائزہ ہے۔

## آپ کو کیا ملتا ہے

- Gateway + macOS ایپ + اوزار (whisper، spotify، cameras) — سب پن شدہ
- Launchd سروس جو ریبوٹس کے بعد بھی برقرار رہتی ہے
- اعلامی کنفیگ کے ساتھ پلگ اِن سسٹم
- فوری رول بیک: `home-manager switch --rollback`

---

## Nix موڈ رن ٹائم رویہ

جب `OPENCLAW_NIX_MODE=1` سیٹ ہو (nix-openclaw کے ساتھ خودکار):

OpenClaw ایک **Nix mode** کو سپورٹ کرتا ہے جو کنفیگریشن کو متعین (deterministic) بناتا ہے اور آٹو-انسٹال فلو کو غیر فعال کرتا ہے۔
اسے ایکسپورٹ کر کے فعال کریں:

```bash
OPENCLAW_NIX_MODE=1
```

On macOS, the GUI app does not automatically inherit shell env vars. آپ
defaults کے ذریعے بھی Nix mode فعال کر سکتے ہیں:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### کنفیگ + اسٹیٹ کے راستے

OpenClaw JSON5 کنفیگ `OPENCLAW_CONFIG_PATH` سے پڑھتا ہے اور قابلِ تغیر ڈیٹا `OPENCLAW_STATE_DIR` میں محفوظ کرتا ہے۔

- `OPENCLAW_STATE_DIR` (بطورِ طے شدہ: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (بطورِ طے شدہ: `$OPENCLAW_STATE_DIR/openclaw.json`)

Nix کے تحت چلانے پر، انہیں واضح طور پر Nix-منظم مقامات پر سیٹ کریں تاکہ رن ٹائم اسٹیٹ اور کنفیگ
غیر قابلِ تغیر اسٹور سے باہر رہیں۔

### Nix موڈ میں رن ٹائم رویہ

- خودکار انسٹال اور خود ترمیمی فلو غیر فعال ہوتے ہیں
- گمشدہ ڈیپنڈنسیز Nix-خصوصی حل کے پیغامات کے ساتھ ظاہر ہوتی ہیں
- UI موجود ہونے پر صرف پڑھنے کے لیے Nix موڈ بینر دکھاتا ہے

## پیکیجنگ نوٹ (macOS)

macOS پیکیجنگ فلو ایک مستحکم Info.plist ٹیمپلیٹ کی توقع کرتا ہے، جو یہاں موجود ہے:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) اس ٹیمپلیٹ کو ایپ بنڈل میں کاپی کرتا ہے اور متحرک فیلڈز کو پیچ کرتا ہے
(بنڈل ID، ورژن/بلڈ، Git SHA، Sparkle keys)۔ اس سے plist، SwiftPM پیکیجنگ اور Nix builds کے لیے متعین رہتا ہے
(جو مکمل Xcode ٹول چین پر انحصار نہیں کرتے)۔

## متعلقہ

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — مکمل سیٹ اپ رہنمائی
- [Wizard](/start/wizard) — نان-Nix CLI سیٹ اپ
- [Docker](/install/docker) — کنٹینرائزڈ سیٹ اپ
