---
summary: "Checklist release macOS OpenClaw (flux Sparkle, packaging, signature)"
read_when:
  - Coupe ou validation release macOS OpenClaw
  - Mise à jour appcast Sparkle ou actifs flux
title: "Release macOS"
---

# Release macOS OpenClaw (Sparkle)

Cette app ship maintenant mises à jour auto Sparkle. Les builds release doivent être Developer ID–signés, zippés et publiés avec une entrée appcast signée.

## Prérequis

- Certificat Developer ID Application installé (exemple : `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Chemin clé privée Sparkle défini dans environnement comme `SPARKLE_PRIVATE_KEY_FILE` (chemin vers votre clé privée ed25519 Sparkle ; clé publique intégrée dans Info.plist). S'il manque, vérifiez `~/.profile`.
- Credentials notary (profil keychain ou clé API) pour `xcrun notarytool` si vous voulez distribution DMG/zip Gatekeeper-safe.
  - Nous utilisons un profil Keychain nommé `openclaw-notary`, créé depuis vars env clé API App Store Connect dans votre profil shell :
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Deps `pnpm` installées (`pnpm install --config.node-linker=hoisted`).
- Outils Sparkle sont fetch automatiquement via SwiftPM à `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).

## Build & package

Notes :

- `APP_BUILD` map à `CFBundleVersion`/`sparkle:version` ; gardez-le numérique + monotonique (pas `-beta`), ou Sparkle le compare comme égal.
- Défaut à l'architecture courante (`$(uname -m)`). Pour builds release/universal, définissez `BUILD_ARCHS="arm64 x86_64"` (ou `BUILD_ARCHS=all`).
- Utilisez `scripts/package-mac-dist.sh` pour artifacts release (zip + DMG + notarization). Utilisez `scripts/package-mac-app.sh` pour packaging local/dev.

```bash
# Depuis racine repo ; définir IDs release donc flux Sparkle est activé.
# APP_BUILD doit être numérique + monotonique pour comparaison Sparkle.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.15 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip pour distribution (inclut resource forks pour support delta Sparkle)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.15.zip

# Optionnel : aussi construire DMG stylé pour humains (glisser vers /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.15.dmg

# Recommandé : construire + notarize/staple zip + DMG
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.15 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh
```

## Entrée Appcast

Utilisez le générateur note release donc Sparkle rend notes HTML formatées :

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.15.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Génère notes release HTML depuis `CHANGELOG.md` et les embarque dans l'entrée appcast. Commitez le `appcast.xml` mis à jour aux côtés des actifs release (zip + dSYM) lors de la publication.

## Publier & vérifier

- Uploadez `OpenClaw-2026.2.15.zip` (et `OpenClaw-2026.2.15.dSYM.zip`) vers la release GitHub pour tag `v2026.2.15`.
- Assurez-vous que l'URL appcast raw correspond au flux baked : `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.

Voir aussi :

- [Passerelle Bundled](/fr-FR/platforms/mac/bundled-gateway)
- [Permissions macOS](/fr-FR/platforms/mac/permissions)
- [Installation](/fr-FR/install/index)
