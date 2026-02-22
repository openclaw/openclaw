---
summary: "OpenClaw macOS 릴리스 체크리스트 (Sparkle 피드, 패키징, 서명)"
read_when:
  - OpenClaw macOS 릴리스를 생성하거나 검증할 때
  - Sparkle appcast 또는 피드 자산을 업데이트할 때
title: "macOS 릴리스"
---

# OpenClaw macOS 릴리스 (Sparkle)

이 앱은 이제 Sparkle 자동 업데이트를 제공합니다. 릴리스 빌드는 Developer ID로 서명되고, 압축된 후, 서명된 appcast 항목과 함께 게시되어야 합니다.

## Prereqs

- Developer ID Application 인증서가 설치되어 있어야 합니다 (예: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle 개인 키 경로가 환경 변수로 설정되어 있어야 합니다: `SPARKLE_PRIVATE_KEY_FILE` (귀하의 Sparkle ed25519 개인 키 경로; 공개 키는 Info.plist에 포함됨). 누락된 경우 `~/.profile`을 확인하세요.
- Gatekeeper-안전 DMG/zip 배포를 원하신다면 `xcrun notarytool`을 위한 공증 자격 증명 (키체인 프로필 또는 API key)이 필요합니다.
  - 우리는 `openclaw-notary`라는 이름의 Keychain 프로필을 사용하며, 이는 App Store Connect API 키 환경 변수를 통해 셸 프로필에서 생성됩니다:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` 종속 사항 설치됨 (`pnpm install --config.node-linker=hoisted`).
- Sparkle 도구는 SwiftPM을 통해 자동으로 가져옵니다: `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, 등).

## Build & package

Notes:

- `APP_BUILD`는 `CFBundleVersion`/`sparkle:version`에 매핑됩니다; 이를 숫자 + 단조롭게 유지하세요 (`-beta` 없음), 그렇지 않으면 Sparkle이 이를 동등하게 비교합니다.
- 기본적으로 현재 아키텍처로 설정됩니다 (`$(uname -m)`). 릴리스/유니버설 빌드를 위해 `BUILD_ARCHS="arm64 x86_64"`로 설정하세요 (또는 `BUILD_ARCHS=all`).
- 릴리스 아티팩트를 위한 `scripts/package-mac-dist.sh`를 사용하세요 (zip + DMG + 공증). 로컬/개발 패키징을 위해 `scripts/package-mac-app.sh`를 사용하세요.

```bash
# 리포지토리 루트에서; 릴리스 ID를 설정하여 Sparkle 피드를 활성화합니다.
# APP_BUILD는 Sparkle 비교를 위해 숫자 + 단조롭게 설정해야 합니다.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.21 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# 배포를 위한 zip (Sparkle 델타 지원을 위한 리소스 포크 포함)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.21.zip

# 선택 사항: 사용자용으로 스타일된 DMG를 추가로 빌드하세요 (/Applications로 드래그)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.21.dmg

# 권장: 빌드 + 공증/스테이플 zip + DMG
# 먼저, 한 번의 키체인 프로필 생성:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.21 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# 선택 사항: 릴리스에 dSYM을 함께 제공
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.21.dSYM.zip
```

## Appcast entry

Sparkle가 서식 있는 HTML 노트를 렌더링할 수 있도록 릴리스 노트 생성기를 사용하세요:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.21.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

`CHANGELOG.md`에서 HTML 릴리스 노트를 생성 (이를 통해 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh))하고 이를 appcast 항목에 포함합니다. 릴리스 자산 (zip + dSYM)과 함께 업데이트된 `appcast.xml`을 커밋하세요.

## Publish & verify

- `OpenClaw-2026.2.21.zip` (및 `OpenClaw-2026.2.21.dSYM.zip`)을 태그 `v2026.2.21`에 대한 GitHub 릴리스에 업로드합니다.
- 원시 appcast URL이 굽힌 피드와 일치하는지 확인합니다: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- 무결성 검사:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`은 200을 반환해야 합니다.
  - 자산 업로드 후 `curl -I <enclosure url>`은 200을 반환해야 합니다.
  - 이전 공개 빌드에서 “업데이트 확인…”을 수행하고 Sparkle이 새로운 빌드를 문제없이 설치하는지 확인합니다.

완료 기준: 서명된 앱 + appcast가 게시되고, 업데이트 흐름이 이전 설치된 버전에서 작동하며, 릴리스 자산이 GitHub 릴리스에 첨부되어야 합니다.
