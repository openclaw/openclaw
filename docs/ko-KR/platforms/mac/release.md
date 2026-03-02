---
summary: "OpenClaw macOS 릴리스 체크리스트 (Sparkle 피드, 패키징, 서명)"
read_when:
  - OpenClaw macOS 릴리스를 자르거나 검증할 때
  - Sparkle 애플릿 또는 피드 자산을 업데이트할 때
title: "macOS 릴리스"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/release.md"
  workflow: 15
---

# OpenClaw macOS 릴리스 (Sparkle)

이 앱은 이제 Sparkle 자동 업데이트를 제공합니다. 릴리스 빌드는 Developer ID-서명, 압축, 그리고 서명된 애플릿 항목으로 게시되어야 합니다.

## 전제 조건

- Developer ID Application 인증서가 설치됨 (예: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle 비공개 키 경로는 `SPARKLE_PRIVATE_KEY_FILE` 환경 변수로 설정됨 (Sparkle ed25519 비공개 키 경로. 공개 키는 Info.plist에 굽혀짐). 없으면 `~/.profile`을 확인합니다.
- Notary 자격 증명 (keychain 프로필 또는 API 키) for `xcrun notarytool`. Gatekeeper-안전한 DMG/zip 배포를 원하는 경우입니다.
  - 우리는 `openclaw-notary`라는 Keychain 프로필을 사용합니다. 셸 프로필의 App Store Connect API 키 환경 변수에서 생성됨:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` deps가 설치됨 (`pnpm install --config.node-linker=hoisted`).
- Sparkle 도구는 SwiftPM을 통해 `apps/macos/.build/artifacts/sparkle/Sparkle/bin/`에서 자동으로 가져옵니다 (`sign_update`, `generate_appcast`, 등).

## 빌드 & 패키징

참고:

- `APP_BUILD`는 `CFBundleVersion`/`sparkle:version`에 매핑됩니다. 숫자 + 단조로운 유지 (no `-beta`), 또는 Sparkle은 그것을 동등하게 비교합니다.
- `APP_BUILD`를 생략하면, `scripts/package-mac-app.sh`는 Sparkle-안전 기본값을 `APP_VERSION`에서 파생시킵니다 (`YYYYMMDDNN`: stable은 기본값 `90`, 전출시는 접미사 파생 레인 사용) 그리고 해당 값과 git 커밋 수 중 더 큰 값을 사용합니다.
- 릴리스 엔지니어링이 특정 단조 값을 필요로 할 때 `APP_BUILD`를 명시적으로 재정의할 수 있습니다.
- 현재 아키텍처 (`$(uname -m)`)로 기본값을 설정합니다. 릴리스/범용 빌드의 경우, `BUILD_ARCHS="arm64 x86_64"` (또는 `BUILD_ARCHS=all`)를 설정합니다.
- 로컬/개발 패키징에는 `scripts/package-mac-app.sh`를 사용합니다. 릴리스 아티팩트 (zip + DMG + notarization)에는 `scripts/package-mac-dist.sh`를 사용합니다.

```bash
# 리포 루트에서. Sparkle 피드가 활성화되도록 릴리스 ID를 설정합니다.
# APP_BUILD는 Sparkle compare에 숫자 + 단조로운 필요합니다.
# 생략되면 기본값은 APP_VERSION에서 자동 파생됩니다.
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.3.1 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# 배포용 Zip (Sparkle 델타 지원을 위한 리소스 포크 포함)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.3.1.zip

# 선택 사항: 인간을 위해 스타일이 지정된 DMG도 빌드 (Applications로 드래그)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.3.1.dmg

# 권장: build + notarize/staple zip + DMG
# 먼저 keychain 프로필을 한 번 생성:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.3.1 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# 선택 사항: 릴리스 옆에 dSYM을 배포합니다
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.3.1.dSYM.zip
```

## 애플릿 항목

릴리스 노트 생성기를 사용하여 Sparkle이 형식이 지정된 HTML 노트를 렌더링하도록 합니다:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.3.1.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

`CHANGELOG.md` 버전 섹션에서 HTML 릴리스 노트를 생성합니다 (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) 그리고 애플릿 항목에 임베드합니다.
릴리스 자산 (zip + dSYM)을 게시할 때 업데이트된 `appcast.xml`을 커밋합니다.

## 게시 & 검증

- `OpenClaw-2026.3.1.zip` (및 `OpenClaw-2026.3.1.dSYM.zip`)을 태그 `v2026.3.1`에 대한 GitHub 릴리스로 업로드합니다.
- 원시 애플릿 URL이 굽혀진 피드와 일치하는지 확인합니다: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- 상식 확인:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`은 200을 반환합니다.
  - `curl -I <enclosure url>`은 자산 업로드 후 200을 반환합니다.
  - 이전 공개 빌드에서, About 탭에서 "Check for Updates…"를 실행하고 Sparkle이 새 빌드를 깨끗하게 설치하는지 확인합니다.

완료의 정의: 서명된 앱 + 애플릿이 게시되고, 이전 설치된 버전에서 업데이트 흐름이 작동하며, 릴리스 자산이 GitHub 릴리스에 첨부됩니다.
