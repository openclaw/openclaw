---
read_when:
    - OpenClaw macOS 릴리스 잘라내기 또는 검증
    - Sparkle 앱캐스트 또는 피드 자산 업데이트
summary: OpenClaw macOS 릴리스 체크리스트(Sparkle 피드, 패키징, 서명)
title: macOS 릴리스
x-i18n:
    generated_at: "2026-02-08T16:00:01Z"
    model: gtx
    provider: google-translate
    source_hash: 98d6640ae4ea9cc132a8f30f4e6e188603064a036ed3bf3429e350520852def0
    source_path: platforms/mac/release.md
    workflow: 15
---

# OpenClaw macOS 릴리스(Sparkle)

이제 이 앱은 Sparkle 자동 업데이트를 제공합니다. 릴리스 빌드는 개발자 ID로 서명되고 압축되어 서명된 앱캐스트 항목과 함께 게시되어야 합니다.

## 전제조건

- 개발자 ID 애플리케이션 인증서가 설치되었습니다(예: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle 개인 키 경로는 다음과 같이 환경에 설정됩니다. `SPARKLE_PRIVATE_KEY_FILE` (Sparkle ed25519 개인 키의 경로, Info.plist에 구운 공개 키). 누락된 경우 확인하세요. `~/.profile`.
- 공증인 자격 증명(키체인 프로필 또는 API 키) `xcrun notarytool` Gatekeeper-safe DMG/zip 배포를 원하는 경우.
  - 우리는 다음과 같은 키체인 프로필을 사용합니다. `openclaw-notary`, 쉘 프로필의 App Store Connect API 키 환경 변수에서 생성됨:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` 뎁스 설치됨(`pnpm install --config.node-linker=hoisted`).
- Sparkle 도구는 SwiftPM을 통해 자동으로 가져옵니다. `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, 등.).

## 빌드 및 패키지

참고:

- `APP_BUILD` 매핑 `CFBundleVersion`/`sparkle:version`; 숫자 + 단조로움을 유지하세요(아니요 `-beta`) 또는 Sparkle은 이를 동일한 것으로 비교합니다.
- 기본값은 현재 아키텍처(`$(uname -m)`). 릴리스/유니버설 빌드의 경우 다음을 설정합니다. `BUILD_ARCHS="arm64 x86_64"` (또는 `BUILD_ARCHS=all`).
- 사용 `scripts/package-mac-dist.sh` 릴리스 아티팩트(zip + DMG + 공증). 사용 `scripts/package-mac-app.sh` 로컬/개발자 패키징용.

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

Sparkle이 형식화된 HTML 노트를 렌더링하도록 릴리스 노트 생성기를 사용하세요.

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

다음에서 HTML 릴리스 노트를 생성합니다. `CHANGELOG.md` (을 통해 [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) 이를 appcast 항목에 포함합니다.
업데이트된 내용을 커밋 `appcast.xml` 게시할 때 릴리스 자산(zip + dSYM)과 함께.

## 게시 및 확인

- 업로드 `OpenClaw-2026.2.6.zip` (그리고 `OpenClaw-2026.2.6.dSYM.zip`) 태그를 위한 GitHub 릴리스 `v2026.2.6`.
- 원시 앱캐스트 URL이 구운 피드와 일치하는지 확인하세요. `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- 온전성 검사:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 200을 반환합니다.
  - `curl -I <enclosure url>` 자산 업로드 후 200을 반환합니다.
  - 이전 공개 빌드의 경우 정보 탭에서 "업데이트 확인..."을 실행하고 Sparkle이 새 빌드를 깔끔하게 설치하는지 확인하세요.

완료의 정의: 서명된 앱 + 앱캐스트가 게시되고, 업데이트 흐름이 이전에 설치된 버전에서 작동하며, 릴리스 자산이 GitHub 릴리스에 첨부됩니다.
