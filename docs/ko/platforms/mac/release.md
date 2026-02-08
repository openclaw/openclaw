---
summary: "OpenClaw macOS 릴리스 체크리스트 (Sparkle 피드, 패키징, 서명)"
read_when:
  - OpenClaw macOS 릴리스를 컷팅하거나 검증할 때
  - Sparkle 앱캐스트 또는 피드 자산을 업데이트할 때
title: "macOS 릴리스"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:48Z
---

# OpenClaw macOS 릴리스 (Sparkle)

이 앱은 이제 Sparkle 자동 업데이트를 제공합니다. 릴리스 빌드는 Developer ID 로 서명되고, zip 으로 압축되며, 서명된 앱캐스트 항목과 함께 게시되어야 합니다.

## 사전 요구 사항

- Developer ID Application 인증서가 설치되어 있어야 합니다 (예: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle 개인 키 경로가 환경 변수 `SPARKLE_PRIVATE_KEY_FILE` 로 설정되어 있어야 합니다 (Sparkle ed25519 개인 키의 경로; 공개 키는 Info.plist 에 포함됨). 누락된 경우 `~/.profile` 를 확인하십시오.
- Gatekeeper 안전 DMG/zip 배포를 원할 경우 `xcrun notarytool` 용 공증 자격 증명 (키체인 프로필 또는 API 키).
  - 우리는 App Store Connect API 키 환경 변수를 셸 프로필에 설정하여 생성한 `openclaw-notary` 이라는 이름의 키체인 프로필을 사용합니다:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` 의존성이 설치되어 있어야 합니다 (`pnpm install --config.node-linker=hoisted`).
- Sparkle 도구는 SwiftPM 을 통해 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` 에서 자동으로 가져옵니다 (`sign_update`, `generate_appcast` 등).

## 빌드 및 패키징

참고 사항:

- `APP_BUILD` 은 `CFBundleVersion`/`sparkle:version` 에 매핑됩니다; 숫자형이면서 단조 증가하도록 유지하십시오 (`-beta` 사용 금지). 그렇지 않으면 Sparkle 이 동일한 값으로 비교합니다.
- 기본값은 현재 아키텍처 (`$(uname -m)`) 입니다. 릴리스/유니버설 빌드의 경우 `BUILD_ARCHS="arm64 x86_64"` (또는 `BUILD_ARCHS=all`) 를 설정하십시오.
- 릴리스 산출물 (zip + DMG + 공증)에는 `scripts/package-mac-dist.sh` 를 사용하십시오. 로컬/개발용 패키징에는 `scripts/package-mac-app.sh` 를 사용하십시오.

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

## 앱캐스트 항목

Sparkle 이 서식이 지정된 HTML 릴리스 노트를 렌더링하도록 릴리스 노트 생성기를 사용하십시오:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

[`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh) 를 통해 `CHANGELOG.md` 에서 HTML 릴리스 노트를 생성하고, 이를 앱캐스트 항목에 포함합니다.
게시 시 릴리스 자산 (zip + dSYM) 과 함께 업데이트된 `appcast.xml` 를 커밋하십시오.

## 게시 및 검증

- 태그 `v2026.2.6` 의 GitHub 릴리스에 `OpenClaw-2026.2.6.zip` (및 `OpenClaw-2026.2.6.dSYM.zip`) 를 업로드하십시오.
- 원시 앱캐스트 URL 이 내장된 피드와 일치하는지 확인하십시오: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- 기본 점검:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 이 200 을 반환합니다.
  - 자산 업로드 후 `curl -I <enclosure url>` 이 200 을 반환합니다.
  - 이전 공개 빌드에서 정보 탭의 “업데이트 확인…”을 실행하고 Sparkle 이 새 빌드를 정상적으로 설치하는지 확인하십시오.

완료 정의: 서명된 앱과 앱캐스트가 게시되었고, 이전에 설치된 버전에서 업데이트 흐름이 정상적으로 작동하며, 릴리스 자산이 GitHub 릴리스에 첨부되어 있습니다.
