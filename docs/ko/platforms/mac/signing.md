---
read_when:
    - Mac 디버그 빌드 빌드 또는 서명
summary: 패키징 스크립트로 생성된 macOS 디버그 빌드에 대한 서명 단계
title: macOS 서명
x-i18n:
    generated_at: "2026-02-08T16:00:10Z"
    model: gtx
    provider: google-translate
    source_hash: 403b92f9a0ecdb7cb42ec097c684b7a696be3696d6eece747314a4dc90d8797e
    source_path: platforms/mac/signing.md
    workflow: 15
---

# Mac 서명(디버그 빌드)

이 앱은 일반적으로 다음에서 제작됩니다. [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh), 이제 다음과 같습니다.

- 안정적인 디버그 번들 식별자를 설정합니다. `ai.openclaw.mac.debug`
- 해당 번들 ID로 Info.plist를 작성합니다(재정의: `BUNDLE_ID=...`)
- 전화 [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) macOS가 각 재구축을 동일한 서명된 번들로 처리하고 TCC 권한(알림, 접근성, 화면 녹화, 마이크, 음성)을 유지할 수 있도록 기본 바이너리 및 앱 번들에 서명합니다. 안정적인 권한을 위해서는 실제 서명 ID를 사용하세요. 임시는 선택 가능하고 취약합니다(참조 [macOS 권한](/platforms/mac/permissions)).
- 용도 `CODESIGN_TIMESTAMP=auto` 기본적으로; 개발자 ID 서명에 대해 신뢰할 수 있는 타임스탬프를 활성화합니다. 세트 `CODESIGN_TIMESTAMP=off` 타임스탬프 건너뛰기(오프라인 디버그 빌드)
- Info.plist에 빌드 메타데이터를 삽입합니다. `OpenClawBuildTimestamp` (UTC) 및 `OpenClawGitCommit` (짧은 해시) 정보 창에 빌드, git 및 디버그/릴리스 채널이 표시될 수 있습니다.
- **패키징에는 Node 22 이상이 필요합니다.**: 스크립트는 TS 빌드와 Control UI 빌드를 실행합니다.
- 읽다 `SIGN_IDENTITY` 환경에서. 추가하다 `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (또는 개발자 ID 애플리케이션 인증서)를 쉘 rc에 추가하여 항상 인증서로 서명하세요. 임시 서명에는 다음을 통한 명시적인 동의가 필요합니다. `ALLOW_ADHOC_SIGNING=1` 또는 `SIGN_IDENTITY="-"` (권한 테스트에는 권장되지 않음)
- 서명 후 팀 ID 감사를 실행하고 앱 번들 내부의 Mach-O가 다른 팀 ID로 서명된 경우 실패합니다. 세트 `SKIP_TEAM_ID_CHECK=1` 우회하다.

## 용법

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### 임시 서명 메모

다음으로 서명할 때 `SIGN_IDENTITY="-"` (임시) 스크립트는 자동으로 **강화된 런타임** (`--options runtime`). 이는 앱이 동일한 팀 ID를 공유하지 않는 내장된 프레임워크(예: Sparkle)를 로드하려고 할 때 충돌을 방지하는 데 필요합니다. 임시 서명은 또한 TCC 권한 지속성을 손상시킵니다. 보다 [macOS 권한](/platforms/mac/permissions) 복구 단계를 위해.

## About에 대한 메타데이터 구축

`package-mac-app.sh` 다음을 사용하여 번들에 스탬프를 찍습니다.

- `OpenClawBuildTimestamp`: 패키지 시간의 ISO8601 UTC
- `OpenClawGitCommit`: 짧은 git 해시(또는 `unknown` 사용할 수 없는 경우)

정보 탭에서는 이러한 키를 읽어 버전, 빌드 날짜, git 커밋 및 디버그 빌드인지 여부를 표시합니다(를 통해). `#if DEBUG`). 코드 변경 후 패키저를 실행하여 이러한 값을 새로 고치십시오.

## 왜

TCC 권한은 번들 식별자와 연결되어 있습니다. _그리고_ 코드 서명. UUID가 변경된 서명되지 않은 디버그 빌드로 인해 macOS는 다시 빌드할 때마다 승인을 잊어버렸습니다. 바이너리 서명(기본적으로 임시) 및 고정된 번들 ID/경로 유지(`dist/OpenClaw.app`)는 VibeTunnel 접근 방식과 일치하여 빌드 간 부여를 유지합니다.
