---
summary: "패키징 스크립트로 생성된 macOS 디버그 빌드에 대한 서명 단계"
read_when:
  - mac 디버그 빌드를 빌드하거나 서명할 때
title: "macOS 서명"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/signing.md"
  workflow: 15
---

# mac 서명 (디버그 빌드)

이 앱은 일반적으로 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)에서 빌드되며, 현재:

- 안정적인 디버그 번들 식별자 설정: `ai.openclaw.mac.debug`
- 해당 번들 id를 사용하여 Info.plist 작성 (`BUNDLE_ID=...`로 재정의)
- 주 바이너리 및 앱 번들을 서명하기 위해 [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh)를 호출하여 macOS가 각 재빌드를 동일한 서명된 번들로 취급하고 TCC 권한 (알림, 접근성, 화면 기록, 마이크, 음성)을 유지합니다. 안정적인 권한의 경우 실제 서명 항등성을 사용합니다. ad-hoc은 옵트인이고 취약합니다 ([macOS permissions](/platforms/mac/permissions) 참조).
- 기본적으로 `CODESIGN_TIMESTAMP=auto`를 사용합니다. Developer ID 서명에 신뢰할 수 있는 타임스탬프가 활성화됩니다. 오프라인 디버그 빌드를 위해 `CODESIGN_TIMESTAMP=off`를 설정합니다.
- Info.plist에 빌드 메타데이터 주입: `OpenClawBuildTimestamp` (UTC) 및 `OpenClawGitCommit` (짧은 해시). About 창이 빌드, git, 그리고 디버그/릴리스 채널을 표시할 수 있습니다.
- **패키징에는 Node 22+이 필요합니다**: 스크립트는 TS 빌드 및 Control UI 빌드를 실행합니다.
- 환경에서 `SIGN_IDENTITY`를 읽습니다. 셸 rc에 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (또는 Developer ID Application 인증서)를 추가하여 항상 인증서로 서명합니다. Ad-hoc 서명에는 `ALLOW_ADHOC_SIGNING=1` 또는 `SIGN_IDENTITY="-"` (권장하지 않음)을 통한 명시적 옵트인이 필요합니다.
- 서명 후 Team ID 감사를 실행하고 앱 번들 내의 Mach-O이 다른 Team ID로 서명된 경우 실패합니다. `SKIP_TEAM_ID_CHECK=1`을 설정하여 무시합니다.

## 사용법

```bash
# 리포 루트에서
scripts/package-mac-app.sh               # 항등성 자동 선택. 없으면 오류
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # 실제 인증서
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (권한이 고착되지 않음)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # 명시적 ad-hoc (동일한 주의)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # 개발 전용 Sparkle Team ID 불일치 해결
```

### Ad-hoc 서명 참고

`SIGN_IDENTITY="-"`(ad-hoc)으로 서명할 때, 스크립트는 자동으로 **Hardened Runtime** (`--options runtime`)을 비활성화합니다. 이것은 앱이 동일한 Team ID를 공유하지 않는 임베드된 프레임워크 (Sparkle처럼)를 로드하려고 할 때 충돌을 방지하기 위해 필요합니다. Ad-hoc 서명은 또한 TCC 권한 지속성을 깨뜨립니다. [macOS permissions](/platforms/mac/permissions)을 참조하여 복구 단계를 확인합니다.

## About에 대한 빌드 메타데이터

`package-mac-app.sh`는 번들에 스탬프합니다:

- `OpenClawBuildTimestamp`: 패키징 시간의 ISO8601 UTC
- `OpenClawGitCommit`: 짧은 git 해시 (또는 사용 불가한 경우 `unknown`)

About 탭은 버전, 빌드 날짜, git 커밋, 그리고 그것이 디버그 빌드인지 여부 (`#if DEBUG`를 통해)를 표시하기 위해 이 키를 읽습니다. 코드 변경 후 패키져를 실행하여 이 값을 새로 고칩니다.

## 이유

TCC 권한은 번들 식별자 _and_ 코드 서명과 연결됩니다. 변하는 UUID를 가진 서명되지 않은 디버그 빌드는 각 재빌드 후 macOS가 부여를 잊게 하고 있었습니다. 바이너리에 서명 (ad-hoc by default) 및 안정적인 번들 id/경로 (`dist/OpenClaw.app`)를 유지하면 재빌드 간에 부여가 유지되며, VibeTunnel 접근 방식을 일치합니다.
