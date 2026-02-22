---
summary: "패키징 스크립트에서 생성된 macOS 디버그 빌드에 대한 서명 단계"
read_when:
  - mac 디버그 빌드를 빌드하거나 서명할 때
title: "macOS 서명"
---

# mac 서명 (디버그 빌드)

이 앱은 보통 [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)에서 빌드됩니다. 이 스크립트는 다음 작업을 수행합니다:

- 안정적인 디버그 번들 식별자를 설정합니다: `ai.openclaw.mac.debug`
- 그 번들 식별자가 포함된 Info.plist 파일을 작성합니다 (오버라이드는 `BUNDLE_ID=...`로 가능합니다).
- `scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh)를 호출하여 주요 바이너리와 앱 번들을 서명하여 macOS가 각 재빌드를 동일한 서명된 번들로 인식하도록 하여 TCC 권한 (알림, 접근성, 화면 녹화, 마이크, 음성)을 유지합니다. 안정적인 권한을 위해서는 실제 서명 ID를 사용하세요; 임시 서명은 선택적이며 불안정합니다 ([macOS 권한](/platforms/mac/permissions) 참고).
- 기본적으로 `CODESIGN_TIMESTAMP=auto`를 사용합니다; 이는 Developer ID 서명을 위한 신뢰할 수 있는 타임스탬프를 활성화합니다. 타임스탬핑을 건너뛰려면 `CODESIGN_TIMESTAMP=off`를 설정하세요 (오프라인 디버그 빌드).
- 빌드 메타데이터를 Info.plist에 주입합니다: `OpenClawBuildTimestamp` (UTC)와 `OpenClawGitCommit` (짧은 해시)를 포함하여 정보 창에서 빌드, git, 디버그/릴리스 채널을 표시할 수 있습니다.
- **패키징은 Node 22+**가 필요합니다: 이 스크립트는 TS 빌드 및 Control UI 빌드를 실행합니다.
- `SIGN_IDENTITY`를 환경에서 읽습니다. 셸 rc에 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (또는 귀하의 Developer ID Application 인증서)를 추가하여 항상 인증서로 서명하세요. 임시 서명은 `ALLOW_ADHOC_SIGNING=1` 또는 `SIGN_IDENTITY="-"`로 명시적인 동의를 요구합니다 (권한 테스트에 권장되지 않음).
- 서명 후 팀 ID 검사를 실행하고 앱 번들 내의 Mach-O가 다른 팀 ID로 서명되었을 경우 실패합니다. `SKIP_TEAM_ID_CHECK=1`을 설정하여 이를 우회하세요.

## 사용법

```bash
# 레포 루트에서
scripts/package-mac-app.sh               # 신원 자동 선택; 발견되지 않으면 오류 발생
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # 실제 인증서
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # 임시 서명 (권한이 유지되지 않음)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # 명시적 임시 서명 (같은 주의점)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # 개발 전용 Sparkle 팀 ID 불일치 해결책
```

### 임시 서명 주의사항

`SIGN_IDENTITY="-"` (임시 서명)으로 서명할 때, 스크립트는 자동으로 **강화 런타임** (`--options runtime`)을 비활성화합니다. 이는 동일한 팀 ID를 공유하지 않는 내장 프레임워크(예: Sparkle)를 로드하려고 할 때 발생하는 충돌을 방지하기 위해 필요합니다. 임시 서명은 또한 TCC 권한 유지에 영향을 미칩니다. 복구 단계를 보려면 [macOS 권한](/platforms/mac/permissions)을 참조하세요.

## 빌드 메타데이터 정보

`package-mac-app.sh`는 번들에 다음 정보를 추가합니다:

- `OpenClawBuildTimestamp`: 패키징 시점의 ISO8601 UTC
- `OpenClawGitCommit`: 짧은 git 해시 (또는 사용할 수 없는 경우 `unknown`)

정보 탭은 이러한 키를 읽어 버전, 빌드 날짜, git 커밋 여부 및 디버그 빌드인지 여부를 표시합니다 (`#if DEBUG` 이용). 코드 변경 후 이 값을 갱신하려면 패키저를 실행하세요.

## 이유

TCC 권한은 번들 식별자 _및_ 코드 서명에 묶여 있습니다. UUID가 변하는 서명되지 않은 디버그 빌드는 각 재빌드 후 macOS가 허가를 잊게 만들었습니다. 바이너리를 서명하고 (기본적으로 임시) 고정된 번들 ID/경로 (`dist/OpenClaw.app`)를 유지하는 것은 VibeTunnel 접근 방식을 따르면서 빌드 간의 권한을 보존합니다.
