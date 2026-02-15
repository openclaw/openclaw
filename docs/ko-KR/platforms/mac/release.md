---
summary: "OpenClaw macOS release checklist (Sparkle feed, packaging, signing)"
read_when:
  - Cutting or validating a OpenClaw macOS release
  - Updating the Sparkle appcast or feed assets
title: "macOS Release"
x-i18n:
  source_hash: 1654fc55b3c17edce9ff42ed2ffd7a3f637e855e1b1b7830a5f9e75c673bbe4a
---

# OpenClaw macOS 릴리스(Sparkle)

이제 이 앱은 Sparkle 자동 업데이트를 제공합니다. 릴리스 빌드는 개발자 ID로 서명되고 압축되어 서명된 앱캐스트 항목과 함께 게시되어야 합니다.

## 전제조건

- 개발자 ID 애플리케이션 인증서가 설치되었습니다(예: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- 환경에 `SPARKLE_PRIVATE_KEY_FILE`로 설정된 Sparkle 개인 키 경로(Sparkle ed25519 개인 키의 경로, Info.plist에 구운 공개 키). 누락된 경우 `~/.profile`를 확인하세요.
- Gatekeeper-safe DMG/zip 배포를 원하는 경우 `xcrun notarytool`에 대한 공증인 자격 증명(키체인 프로필 또는 API 키)입니다.
  - 쉘 프로필의 App Store Connect API 키 환경 변수에서 생성된 `openclaw-notary`라는 키체인 프로필을 사용합니다.
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` deps가 설치되었습니다(`pnpm install --config.node-linker=hoisted`).
- Sparkle 도구는 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast` 등)에서 SwiftPM을 통해 자동으로 가져옵니다.

## 빌드 및 패키지

참고:

- `APP_BUILD`는 `CFBundleVersion`/`sparkle:version`에 매핑됩니다. 숫자 + 단조로움(`-beta` 없음)을 유지하거나 Sparkle이 이를 동일하게 비교합니다.
- 기본값은 현재 아키텍처(`$(uname -m)`)입니다. 릴리스/유니버설 빌드의 경우 `BUILD_ARCHS="arm64 x86_64"`(또는 `BUILD_ARCHS=all`)를 설정합니다.
- 릴리스 아티팩트(zip + DMG + 공증)에는 `scripts/package-mac-dist.sh`를 사용하십시오. 로컬/개발자 패키징에는 `scripts/package-mac-app.sh`를 사용하세요.

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.13 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.13.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.13.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.13 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.13.dSYM.zip
```

## 앱캐스트 항목

Sparkle이 형식화된 HTML 노트를 렌더링하도록 릴리스 노트 생성기를 사용하세요.

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.13.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

`CHANGELOG.md`([`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)를 통해)에서 HTML 릴리스 노트를 생성하고 이를 앱캐스트 항목에 포함합니다.
게시할 때 릴리스 자산(zip + dSYM)과 함께 업데이트된 `appcast.xml`을 커밋합니다.

## 게시 및 확인

- 태그 `v2026.2.13`에 대한 GitHub 릴리스에 `OpenClaw-2026.2.13.zip`(및 `OpenClaw-2026.2.13.dSYM.zip`)를 업로드합니다.
- 원시 앱캐스트 URL이 구운 피드 `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`와 일치하는지 확인하세요.
- 온전성 검사:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`는 200을 반환합니다.
  - `curl -I <enclosure url>`는 자산 업로드 후 200을 반환합니다.
  - 이전 공개 빌드의 경우 정보 탭에서 "업데이트 확인..."을 실행하고 Sparkle이 새 빌드를 깔끔하게 설치하는지 확인하세요.

완료의 정의: 서명된 앱 + 앱캐스트가 게시되고, 업데이트 흐름이 이전에 설치된 버전에서 작동하며, 릴리스 자산이 GitHub 릴리스에 첨부됩니다.
