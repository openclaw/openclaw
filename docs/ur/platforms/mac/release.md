---
summary: "OpenClaw macOS ریلیز چیک لسٹ (Sparkle فیڈ، پیکیجنگ، سائننگ)"
read_when:
  - OpenClaw macOS ریلیز کو کاٹتے یا اس کی توثیق کرتے وقت
  - Sparkle appcast یا فیڈ اثاثوں کو اپ ڈیٹ کرتے وقت
title: "macOS ریلیز"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:30Z
---

# OpenClaw macOS ریلیز (Sparkle)

یہ ایپ اب Sparkle خودکار اپ ڈیٹس کے ساتھ فراہم کی جاتی ہے۔ ریلیز بلڈز کا Developer ID کے ساتھ سائن ہونا، زِپ ہونا، اور دستخط شدہ appcast اندراج کے ساتھ شائع ہونا لازم ہے۔

## پیشگی تقاضے

- Developer ID Application سرٹیفکیٹ انسٹال ہو (مثال: `Developer ID Application: <Developer Name> (<TEAMID>)`)۔
- Sparkle نجی کلید کا راستہ ماحول میں `SPARKLE_PRIVATE_KEY_FILE` کے طور پر سیٹ ہو (آپ کی Sparkle ed25519 نجی کلید کا راستہ؛ عوامی کلید Info.plist میں شامل ہوتی ہے)۔ اگر یہ موجود نہ ہو تو `~/.profile` چیک کریں۔
- `xcrun notarytool` کے لیے نوٹری اسناد (کی چین پروفائل یا API کلید)، اگر آپ Gatekeeper-محفوظ DMG/zip تقسیم چاہتے ہیں۔
  - ہم `openclaw-notary` نامی Keychain پروفائل استعمال کرتے ہیں، جو App Store Connect API کلید کے env vars سے آپ کے شیل پروفائل میں بنایا گیا ہے:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` کی deps انسٹال ہوں (`pnpm install --config.node-linker=hoisted`)۔
- Sparkle ٹولز SwiftPM کے ذریعے خودکار طور پر `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` پر حاصل کیے جاتے ہیں (`sign_update`, `generate_appcast`، وغیرہ)۔

## بلڈ اور پیکیج

نوٹس:

- `APP_BUILD`، `CFBundleVersion`/`sparkle:version` سے میپ ہوتا ہے؛ اسے عددی اور یک سمت (monotonic) رکھیں (`-beta` نہیں)، ورنہ Sparkle اسے برابر سمجھتا ہے۔
- بطورِ طے شدہ موجودہ آرکیٹیکچر (`$(uname -m)`) استعمال ہوتا ہے۔ ریلیز/یونیورسل بلڈز کے لیے `BUILD_ARCHS="arm64 x86_64"` (یا `BUILD_ARCHS=all`) سیٹ کریں۔
- ریلیز اثاثوں (zip + DMG + نوٹرائزیشن) کے لیے `scripts/package-mac-dist.sh` استعمال کریں۔ لوکل/ڈیولپمنٹ پیکیجنگ کے لیے `scripts/package-mac-app.sh` استعمال کریں۔

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.6.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.6.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.6.dSYM.zip
```

## Appcast اندراج

ریلیز نوٹ جنریٹر استعمال کریں تاکہ Sparkle فارمیٹ شدہ HTML نوٹس رینڈر کرے:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

یہ `CHANGELOG.md` سے HTML ریلیز نوٹس بناتا ہے ([`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh) کے ذریعے) اور انہیں appcast اندراج میں شامل کرتا ہے۔
شائع کرتے وقت اپ ڈیٹ شدہ `appcast.xml` کو ریلیز اثاثوں (zip + dSYM) کے ساتھ کمٹ کریں۔

## شائع کریں اور توثیق کریں

- `OpenClaw-2026.2.6.zip` (اور `OpenClaw-2026.2.6.dSYM.zip`) کو ٹیگ `v2026.2.6` کے لیے GitHub ریلیز پر اپ لوڈ کریں۔
- یقینی بنائیں کہ raw appcast URL بیک کی ہوئی فیڈ سے مطابقت رکھتا ہو: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`۔
- جانچ:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`، 200 ریٹرن کرے۔
  - اثاثوں کے اپ لوڈ کے بعد `curl -I <enclosure url>`، 200 ریٹرن کرے۔
  - کسی پچھلے عوامی بلڈ پر، About ٹیب سے “Check for Updates…” چلائیں اور تصدیق کریں کہ Sparkle نیا بلڈ صاف طور پر انسٹال کرتا ہے۔

تعریفِ تکمیل: سائن شدہ ایپ اور appcast شائع ہوں، پرانی انسٹال شدہ ورژن سے اپ ڈیٹ فلو درست کام کرے، اور ریلیز اثاثے GitHub ریلیز کے ساتھ منسلک ہوں۔
