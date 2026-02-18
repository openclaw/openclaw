---
summary: "OpenClaw macOS ထုတ်ဝေမှု စစ်ဆေးစာရင်း (Sparkle feed, ပက်ကေ့ဂျ်လုပ်ခြင်း၊ လက်မှတ်ရေးထိုးခြင်း)"
read_when:
  - OpenClaw macOS ထုတ်ဝေမှုကို ဖြတ်တောက်ခြင်း သို့မဟုတ် အတည်ပြုခြင်း ပြုလုပ်နေစဉ်
  - Sparkle appcast သို့မဟုတ် feed အရင်းအမြစ်များကို အပ်ဒိတ်လုပ်နေစဉ်
title: "macOS ထုတ်ဝေမှု"
---

# OpenClaw macOS ထုတ်ဝေမှု (Sparkle)

47. ယခု အက်ပ်တွင် Sparkle auto-updates ပါဝင်လာပါသည်။ 48. Release builds များကို Developer ID ဖြင့် sign လုပ်ပြီး zip လုပ်ကာ signed appcast entry ဖြင့် publish လုပ်ရပါမည်။

## ကြိုတင်လိုအပ်ချက်များ

- Developer ID Application cert ကို ထည့်သွင်းထားရမည် (ဥပမာ: `Developer ID Application: <Developer Name> (<TEAMID>)`)။
- 49. Sparkle private key path ကို environment ထဲတွင် `SPARKLE_PRIVATE_KEY_FILE` အဖြစ် သတ်မှတ်ထားရပါမည် (သင်၏ Sparkle ed25519 private key သို့ path; public key ကို Info.plist ထဲတွင် ထည့်သွင်းထားပြီးသား)။ 50. မရှိပါက `~/.profile` ကို စစ်ဆေးပါ။
- Gatekeeper-လုံခြုံသော DMG/zip ဖြန့်ချိမှု ပြုလုပ်လိုပါက `xcrun notarytool` အတွက် Notary အထောက်အထားများ (keychain profile သို့မဟုတ် API key)။
  - ကျွန်ုပ်တို့သည် shell profile ထဲရှိ App Store Connect API key env vars များမှ ဖန်တီးထားသော `openclaw-notary` ဟု အမည်ပေးထားသည့် Keychain profile ကို အသုံးပြုပါသည်။
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` deps များ ထည့်သွင်းထားရမည် (`pnpm install --config.node-linker=hoisted`)။
- Sparkle ကိရိယာများကို SwiftPM မှတဆင့် `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` တွင် အလိုအလျောက် ရယူပါသည် (`sign_update`, `generate_appcast` စသည်)။

## Build & package

မှတ်ချက်များ—

- `APP_BUILD` သည် `CFBundleVersion`/`sparkle:version` သို့ မပ်ဖြစ်သည်; ကိန်းဂဏန်းသာ ဖြစ်ပြီး တဖြည်းဖြည်း တိုးတက်သည့် အစီအစဉ်ဖြစ်အောင် ထိန်းထားပါ (`-beta` မပါစေနှင့်)၊ မဟုတ်ပါက Sparkle က တူညီသည်ဟု နှိုင်းယှဉ်ပါလိမ့်မည်။
- လက်ရှိ architecture (`$(uname -m)`) ကို မူလသတ်မှတ်ထားသည်။ Release / universal build များအတွက် `BUILD_ARCHS="arm64 x86_64"` (သို့မဟုတ် `BUILD_ARCHS=all`) ကို သတ်မှတ်ပါ။
- Release artifact များ (zip + DMG + notarization) အတွက် `scripts/package-mac-dist.sh` ကို အသုံးပြုပါ။ Local / dev packaging အတွက် `scripts/package-mac-app.sh` ကို အသုံးပြုပါ။

```bash
21. # From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.9 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.9.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.9.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.9 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.9.dSYM.zip
```

## Appcast entry

Sparkle မှ ဖော်မတ်ထားသော HTML မှတ်စုများကို ပြသနိုင်ရန် release note generator ကို အသုံးပြုပါ—

```bash
22. SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.9.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

`CHANGELOG.md` မှ HTML release notes များကို (`scripts/changelog-to-html.sh` မှတစ်ဆင့်) ဖန်တီးပြီး appcast entry ထဲတွင် ထည့်သွင်းပါသည်။
Publish လုပ်ရာတွင် update လုပ်ထားသော `appcast.xml` ကို release asset များ (zip + dSYM) နှင့်အတူ commit လုပ်ပါ။

## ထုတ်ဝေခြင်း & အတည်ပြုခြင်း

- 23. `OpenClaw-2026.2.9.zip` (နှင့် `OpenClaw-2026.2.9.dSYM.zip`) ကို tag `v2026.2.9` အတွက် GitHub release သို့ တင်ပါ။
- raw appcast URL သည် baked feed နှင့် ကိုက်ညီကြောင်း သေချာပါစေ—`https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`။
- Sanity checks—
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` သည် 200 ပြန်ရပါသည်။
  - asset များ တင်ပြီးနောက် `curl -I <enclosure url>` သည် 200 ပြန်ရပါသည်။
  - အရင် public build တစ်ခုတွင် About tab မှ “Check for Updates…” ကို chạyပြီး Sparkle က build အသစ်ကို သန့်ရှင်းစွာ install လုပ်နိုင်ကြောင်း စစ်ဆေးပါ။

ပြီးစီးသတ်မှတ်ချက် (Definition of done): လက်မှတ်ရေးထိုးထားသော app နှင့် appcast ကို ထုတ်ဝေပြီးဖြစ်သည်၊ ယခင် ထည့်သွင်းထားသော ဗားရှင်းမှ အပ်ဒိတ် လုပ်ငန်းစဉ် အလုပ်လုပ်ပါသည်၊ ထုတ်ဝေမှု အရင်းအမြစ်များကို GitHub release တွင် ချိတ်ဆက်ထားပြီးဖြစ်သည်။
