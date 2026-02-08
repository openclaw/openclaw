---
summary: "Checklist de lançamento do OpenClaw para macOS (feed do Sparkle, empacotamento, assinatura)"
read_when:
  - Ao cortar ou validar um lançamento do OpenClaw para macOS
  - Ao atualizar o appcast do Sparkle ou os ativos do feed
title: "Lançamento do macOS"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:31Z
---

# Lançamento do OpenClaw para macOS (Sparkle)

Este app agora envia atualizações automáticas via Sparkle. Builds de lançamento devem ser assinadas com Developer ID, compactadas em zip e publicadas com uma entrada de appcast assinada.

## Pré-requisitos

- Certificado Developer ID Application instalado (exemplo: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Caminho da chave privada do Sparkle definido no ambiente como `SPARKLE_PRIVATE_KEY_FILE` (caminho para sua chave privada ed25519 do Sparkle; chave pública embutida no Info.plist). Se estiver ausente, verifique `~/.profile`.
- Credenciais de notariação (perfil do Keychain ou chave de API) para `xcrun notarytool` se você quiser distribuição de DMG/zip segura pelo Gatekeeper.
  - Usamos um perfil do Keychain chamado `openclaw-notary`, criado a partir das variáveis de ambiente da chave de API do App Store Connect no seu perfil de shell:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Dependências do `pnpm` instaladas (`pnpm install --config.node-linker=hoisted`).
- As ferramentas do Sparkle são obtidas automaticamente via SwiftPM em `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).

## Build e empacotamento

Notas:

- `APP_BUILD` mapeia para `CFBundleVersion`/`sparkle:version`; mantenha numérico e monotônico (sem `-beta`), ou o Sparkle compara como igual.
- O padrão é a arquitetura atual (`$(uname -m)`). Para builds de lançamento/universais, defina `BUILD_ARCHS="arm64 x86_64"` (ou `BUILD_ARCHS=all`).
- Use `scripts/package-mac-dist.sh` para artefatos de lançamento (zip + DMG + notariação). Use `scripts/package-mac-app.sh` para empacotamento local/dev.

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

## Entrada do appcast

Use o gerador de notas de lançamento para que o Sparkle renderize notas em HTML formatado:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Gera notas de lançamento em HTML a partir de `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) e as incorpora na entrada do appcast.
Faça commit do `appcast.xml` atualizado junto com os ativos de lançamento (zip + dSYM) ao publicar.

## Publicar e verificar

- Envie `OpenClaw-2026.2.6.zip` (e `OpenClaw-2026.2.6.dSYM.zip`) para o release do GitHub da tag `v2026.2.6`.
- Garanta que a URL bruta do appcast corresponda ao feed embutido: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Verificações de sanidade:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` retorna 200.
  - `curl -I <enclosure url>` retorna 200 após o upload dos ativos.
  - Em uma build pública anterior, execute “Check for Updates…” na aba About e verifique se o Sparkle instala a nova build corretamente.

Definição de pronto: app assinado + appcast publicados, fluxo de atualização funciona a partir de uma versão instalada mais antiga, e os ativos de lançamento estão anexados ao release do GitHub.
