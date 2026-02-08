---
summary: "Lista kontrolna wydania OpenClaw na macOS (kanał Sparkle, pakowanie, podpisywanie)"
read_when:
  - Przy tworzeniu lub weryfikacji wydania OpenClaw na macOS
  - Przy aktualizacji appcastu Sparkle lub zasobów kanału
title: "Wydanie macOS"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:28Z
---

# Wydanie OpenClaw na macOS (Sparkle)

Ta aplikacja korzysta teraz z automatycznych aktualizacji Sparkle. Wydania muszą być podpisane certyfikatem Developer ID, spakowane do ZIP i opublikowane z podpisanym wpisem appcastu.

## Wymagania wstępne

- Zainstalowany certyfikat Developer ID Application (przykład: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Ustawiona w środowisku ścieżka do klucza prywatnego Sparkle jako `SPARKLE_PRIVATE_KEY_FILE` (ścieżka do prywatnego klucza ed25519 Sparkle; klucz publiczny wbudowany w Info.plist). Jeśli jej brakuje, sprawdź `~/.profile`.
- Poświadczenia notaryzacji (profil pęku kluczy lub klucz API) dla `xcrun notarytool`, jeśli chcesz dystrybuować DMG/ZIP bezpieczne dla Gatekeepera.
  - Używamy profilu pęku kluczy o nazwie `openclaw-notary`, utworzonego z użyciem zmiennych środowiskowych klucza API App Store Connect w profilu powłoki:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Zainstalowane zależności `pnpm` (`pnpm install --config.node-linker=hoisted`).
- Narzędzia Sparkle są pobierane automatycznie przez SwiftPM w `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast` itd.).

## Budowanie i pakowanie

Uwagi:

- `APP_BUILD` mapuje się na `CFBundleVersion`/`sparkle:version`; zachowaj wartość numeryczną i monotoniczną (bez `-beta`), w przeciwnym razie Sparkle porówna ją jako równą.
- Domyślnie używana jest bieżąca architektura (`$(uname -m)`). Dla wydań/universal ustaw `BUILD_ARCHS="arm64 x86_64"` (lub `BUILD_ARCHS=all`).
- Użyj `scripts/package-mac-dist.sh` dla artefaktów wydania (ZIP + DMG + notaryzacja). Użyj `scripts/package-mac-app.sh` dla pakowania lokalnego/deweloperskiego.

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

## Wpis appcastu

Użyj generatora notatek wydania, aby Sparkle renderował sformatowane notatki HTML:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Generuje notatki wydania w HTML z `CHANGELOG.md` (przez [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) i osadza je we wpisie appcastu.
Zacommituj zaktualizowany `appcast.xml` razem z artefaktami wydania (ZIP + dSYM) podczas publikacji.

## Publikacja i weryfikacja

- Prześlij `OpenClaw-2026.2.6.zip` (oraz `OpenClaw-2026.2.6.dSYM.zip`) do wydania GitHub dla taga `v2026.2.6`.
- Upewnij się, że surowy URL appcastu odpowiada wbudowanemu kanałowi: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Kontrole sanity:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` zwraca 200.
  - `curl -I <enclosure url>` zwraca 200 po przesłaniu zasobów.
  - Na poprzednim publicznym buildzie uruchom „Check for Updates…” z karty About i zweryfikuj, że Sparkle instaluje nowe wydanie bez problemów.

Definicja ukończenia: podpisana aplikacja i appcast są opublikowane, proces aktualizacji działa z wcześniejszej zainstalowanej wersji, a artefakty wydania są dołączone do wydania GitHub.
