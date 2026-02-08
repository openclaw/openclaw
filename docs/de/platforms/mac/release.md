---
summary: „OpenClaw macOS‑Release‑Checkliste (Sparkle‑Feed, Packaging, Signierung)“
read_when:
  - Beim Erstellen oder Validieren eines OpenClaw macOS‑Releases
  - Beim Aktualisieren des Sparkle‑Appcasts oder der Feed‑Assets
title: „macOS‑Release“
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:56Z
---

# OpenClaw macOS‑Release (Sparkle)

Diese App wird jetzt mit Sparkle‑Auto‑Updates ausgeliefert. Release‑Builds müssen mit einer Developer ID signiert, gezippt und mit einem signierten Appcast‑Eintrag veröffentlicht werden.

## Voraussetzungen

- Developer ID Application‑Zertifikat installiert (Beispiel: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle‑Private‑Key‑Pfad in der Umgebung als `SPARKLE_PRIVATE_KEY_FILE` gesetzt (Pfad zu Ihrem Sparkle‑ed25519‑Private‑Key; der öffentliche Schlüssel ist in der Info.plist eingebettet). Falls er fehlt, prüfen Sie `~/.profile`.
- Notarisierungs‑Anmeldedaten (Schlüsselbund‑Profil oder API‑Schlüssel) für `xcrun notarytool`, wenn Sie eine Gatekeeper‑sichere DMG/ZIP‑Distribution wünschen.
  - Wir verwenden ein Schlüsselbund‑Profil mit dem Namen `openclaw-notary`, erstellt aus App Store Connect API‑Key‑Umgebungsvariablen in Ihrem Shell‑Profil:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm`‑Abhängigkeiten installiert (`pnpm install --config.node-linker=hoisted`).
- Sparkle‑Tools werden automatisch via SwiftPM unter `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` bezogen (`sign_update`, `generate_appcast` usw.).

## Build & Packaging

Hinweise:

- `APP_BUILD` wird auf `CFBundleVersion`/`sparkle:version` abgebildet; halten Sie es numerisch und monoton (kein `-beta`), sonst vergleicht Sparkle es als gleich.
- Standardmäßig wird die aktuelle Architektur verwendet (`$(uname -m)`). Für Release‑/Universal‑Builds setzen Sie `BUILD_ARCHS="arm64 x86_64"` (oder `BUILD_ARCHS=all`).
- Verwenden Sie `scripts/package-mac-dist.sh` für Release‑Artefakte (ZIP + DMG + Notarisierung). Verwenden Sie `scripts/package-mac-app.sh` für lokales/Dev‑Packaging.

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

## Appcast‑Eintrag

Verwenden Sie den Release‑Note‑Generator, damit Sparkle formatierte HTML‑Notizen rendert:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Erzeugt HTML‑Release‑Notes aus `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) und bettet sie in den Appcast‑Eintrag ein.
Committen Sie die aktualisierte `appcast.xml` zusammen mit den Release‑Assets (ZIP + dSYM) beim Veröffentlichen.

## Veröffentlichen & verifizieren

- Laden Sie `OpenClaw-2026.2.6.zip` (und `OpenClaw-2026.2.6.dSYM.zip`) in das GitHub‑Release für den Tag `v2026.2.6` hoch.
- Stellen Sie sicher, dass die Raw‑Appcast‑URL dem eingebetteten Feed entspricht: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Plausibilitätsprüfungen:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` liefert 200 zurück.
  - `curl -I <enclosure url>` liefert nach dem Hochladen der Assets 200 zurück.
  - Führen Sie in einer früheren öffentlichen Version „Nach Updates suchen…“ im Tab „Über“ aus und verifizieren Sie, dass Sparkle das neue Build sauber installiert.

Definition of done: Signierte App und Appcast sind veröffentlicht, der Update‑Flow funktioniert ausgehend von einer älteren installierten Version, und die Release‑Assets sind dem GitHub‑Release beigefügt.
