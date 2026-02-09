---
summary: "OpenClaw macOS sürüm kontrol listesi (Sparkle feed, paketleme, imzalama)"
read_when:
  - Bir OpenClaw macOS sürümünü keserken veya doğrularken
  - Sparkle appcast’ini veya feed varlıklarını güncellerken
title: "macOS Sürümü"
---

# OpenClaw macOS sürümü (Sparkle)

Bu uygulama artık Sparkle otomatik güncellemeleriyle dağıtılmaktadır. Sürüm derlemeleri Developer ID ile imzalanmalı, ziplenmeli ve imzalı bir appcast girdisiyle yayımlanmalıdır.

## Ön koşullar

- Developer ID Application sertifikası yüklü (örnek: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle özel anahtar yolu ortamda `SPARKLE_PRIVATE_KEY_FILE` olarak ayarlanmış (Sparkle ed25519 özel anahtarınızın yolu; açık anahtar Info.plist içine gömülüdür). Eksikse `~/.profile` kontrol edin.
- Gatekeeper-uyumlu DMG/zip dağıtımı istiyorsanız `xcrun notarytool` için Notary kimlik bilgileri (anahtarlık profili veya API anahtarı).
  - App Store Connect API anahtarı ortam değişkenlerinden, kabuk profilinizde oluşturulmuş `openclaw-notary` adlı bir Anahtarlık profili kullanıyoruz:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` bağımlılıkları yüklü (`pnpm install --config.node-linker=hoisted`).
- Sparkle araçları SwiftPM üzerinden `apps/macos/.build/artifacts/sparkle/Sparkle/bin/`’te otomatik olarak alınır (`sign_update`, `generate_appcast`, vb.).

## Derleme ve paketleme

Notlar:

- `APP_BUILD`, `CFBundleVersion`/`sparkle:version`’a eşlenir; sayısal ve artan tutun (`-beta` yok), aksi halde Sparkle bunu eşit olarak karşılaştırır.
- Varsayılan olarak geçerli mimariyi (`$(uname -m)`) kullanır. Sürüm/evrensel derlemeler için `BUILD_ARCHS="arm64 x86_64"` (veya `BUILD_ARCHS=all`) ayarlayın.
- Sürüm artefaktları (zip + DMG + notarization) için `scripts/package-mac-dist.sh` kullanın. Yerel/geliştirme paketleme için `scripts/package-mac-app.sh` kullanın.

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

## Appcast girdisi

Sparkle’ın biçimlendirilmiş HTML notlarını oluşturması için sürüm notu oluşturucusunu kullanın:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

`CHANGELOG.md`’dan HTML sürüm notları üretir ([`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh) aracılığıyla) ve bunları appcast girdisine gömer.
Yayımlarken güncellenmiş `appcast.xml` dosyasını sürüm varlıklarıyla (zip + dSYM) birlikte commit edin.

## Yayımlama ve doğrulama

- `v2026.2.6` etiketi için GitHub sürümüne `OpenClaw-2026.2.6.zip`’u (ve `OpenClaw-2026.2.6.dSYM.zip`) yükleyin.
- Ham appcast URL’sinin gömülü feed ile eşleştiğinden emin olun: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Sağlamlık kontrolleri:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 200 döner.
  - Varlıklar yüklendikten sonra `curl -I <enclosure url>` 200 döner.
  - Önceki bir herkese açık derlemede, Hakkında sekmesinden “Güncellemeleri Denetle…”yi çalıştırın ve Sparkle’ın yeni derlemeyi sorunsuz kurduğunu doğrulayın.

Tamamlanma tanımı: imzalı uygulama + appcast yayımlanmıştır, güncelleme akışı daha eski yüklü bir sürümden çalışır ve sürüm varlıkları GitHub sürümüne eklenmiştir.
