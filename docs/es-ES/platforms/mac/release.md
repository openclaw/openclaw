---
summary: "Checklist de release de OpenClaw para macOS (feed de Sparkle, empaquetado, firma)"
read_when:
  - Cortando o validando un release de OpenClaw para macOS
  - Actualizando el appcast de Sparkle o los assets del feed
title: "Release de macOS"
---

# Release de OpenClaw para macOS (Sparkle)

Esta app ahora incluye actualizaciones automáticas de Sparkle. Las compilaciones de release deben estar firmadas con Developer ID, comprimidas y publicadas con una entrada de appcast firmada.

## Prerrequisitos

- Certificado Developer ID Application instalado (ejemplo: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Ruta de clave privada de Sparkle configurada en el entorno como `SPARKLE_PRIVATE_KEY_FILE` (ruta a tu clave privada ed25519 de Sparkle; clave pública integrada en Info.plist). Si falta, verifica `~/.profile`.
- Credenciales de notario (perfil de keychain o clave API) para `xcrun notarytool` si deseas distribución de DMG/zip segura con Gatekeeper.
  - Usamos un perfil de Keychain llamado `openclaw-notary`, creado desde variables de entorno de clave API de App Store Connect en tu perfil de shell:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Dependencias de `pnpm` instaladas (`pnpm install --config.node-linker=hoisted`).
- Las herramientas de Sparkle se obtienen automáticamente vía SwiftPM en `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).

## Compilar y empaquetar

Notas:

- `APP_BUILD` mapea a `CFBundleVersion`/`sparkle:version`; mantenlo numérico + monotónico (sin `-beta`), o Sparkle lo compara como igual.
- Por defecto es la arquitectura actual (`$(uname -m)`). Para compilaciones de release/universal, establece `BUILD_ARCHS="arm64 x86_64"` (o `BUILD_ARCHS=all`).
- Usa `scripts/package-mac-dist.sh` para artefactos de release (zip + DMG + notarización). Usa `scripts/package-mac-app.sh` para empaquetado local/dev.

```bash
# Desde la raíz del repo; establece IDs de release para que el feed de Sparkle esté habilitado.
# APP_BUILD debe ser numérico + monotónico para la comparación de Sparkle.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.16 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Comprimir para distribución (incluye resource forks para soporte de delta de Sparkle)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.16.zip

# Opcional: también construir un DMG estilizado para humanos (arrastrar a /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.16.dmg

# Recomendado: construir + notarizar/grapar zip + DMG
# Primero, crea un perfil de keychain una vez:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.16 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Opcional: enviar dSYM junto con el release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.16.dSYM.zip
```

## Entrada de appcast

Usa el generador de notas de release para que Sparkle renderice notas HTML formateadas:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.16.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Genera notas de release HTML desde `CHANGELOG.md` (vía [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) y las incrusta en la entrada del appcast.
Haz commit del `appcast.xml` actualizado junto con los assets de release (zip + dSYM) al publicar.

## Publicar y verificar

- Sube `OpenClaw-2026.2.16.zip` (y `OpenClaw-2026.2.16.dSYM.zip`) al release de GitHub para el tag `v2026.2.16`.
- Asegúrate de que la URL del appcast raw coincida con el feed integrado: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Verificaciones de cordura:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` devuelve 200.
  - `curl -I <enclosure url>` devuelve 200 después de subir los assets.
  - En una compilación pública anterior, ejecuta "Check for Updates…" desde la pestaña About y verifica que Sparkle instale la nueva compilación limpiamente.

Definición de hecho: app firmada + appcast están publicados, el flujo de actualización funciona desde una versión instalada anterior, y los assets de release están adjuntos al release de GitHub.
