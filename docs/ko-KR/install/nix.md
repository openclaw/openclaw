---
title: "Nix"
summary: "Nix 를 사용한 OpenClaw 선언적 설치"
read_when:
  - 재현 가능하고 롤백 가능한 설치를 원할 때
  - 이미 Nix/NixOS/Home Manager 를 사용하고 있을 때
  - 모든 것을 고정하고 선언적으로 관리하고 싶을 때
x-i18n:
  source_path: docs/install/nix.md
---

# Nix 설치

**[nix-openclaw](https://github.com/openclaw/nix-openclaw)** 를 사용하여 OpenClaw 를 선언적으로 설치합니다 -- 배터리 포함 Home Manager 모듈입니다.

<Info>
[nix-openclaw](https://github.com/openclaw/nix-openclaw) 저장소가 Nix 설치의 정보 출처입니다. 이 페이지는 간략한 개요입니다.
</Info>

## 제공되는 것

- Gateway + macOS 앱 + 도구 (whisper, spotify, cameras) -- 모두 고정
- 재부팅 후에도 유지되는 Launchd 서비스
- 선언적 설정이 가능한 플러그인 시스템
- 즉시 롤백: `home-manager switch --rollback`

## 빠른 시작

<Steps>
  <Step title="Determinate Nix 설치">
    Nix 가 아직 설치되지 않은 경우 [Determinate Nix installer](https://github.com/DeterminateSystems/nix-installer) 지침을 따르세요.
  </Step>
  <Step title="로컬 flake 생성">
    nix-openclaw 저장소의 agent-first 템플릿을 사용합니다:
    ```bash
    mkdir -p ~/code/openclaw-local
    # nix-openclaw 저장소에서 templates/agent-first/flake.nix 를 복사
    ```
  </Step>
  <Step title="시크릿 구성">
    메시징 봇 토큰과 모델 프로바이더 API 키를 설정합니다. `~/.secrets/` 에 있는 일반 파일로 충분합니다.
  </Step>
  <Step title="템플릿 플레이스홀더 입력 및 전환">
    ```bash
    home-manager switch
    ```
  </Step>
  <Step title="검증">
    launchd 서비스가 실행 중이고 봇이 메시지에 응답하는지 확인합니다.
  </Step>
</Steps>

전체 모듈 옵션 및 예제는 [nix-openclaw README](https://github.com/openclaw/nix-openclaw) 를 참고하세요.

## Nix 모드 런타임 동작

`OPENCLAW_NIX_MODE=1` 이 설정되면 (nix-openclaw 에서 자동), OpenClaw 는 자동 설치 플로우를 비활성화하는 결정론적 모드로 진입합니다.

수동으로 설정할 수도 있습니다:

```bash
export OPENCLAW_NIX_MODE=1
```

macOS 에서는 GUI 앱이 셸 환경 변수를 자동으로 상속하지 않습니다. 대신 defaults 를 통해 Nix 모드를 활성화하세요:

```bash
defaults write ai.openclaw.mac openclaw.nixMode -bool true
```

### Nix 모드에서 변경되는 것

- 자동 설치 및 자기 변이 플로우가 비활성화됩니다
- 누락된 의존성에 대해 Nix 전용 해결 메시지가 표시됩니다
- UI 에 읽기 전용 Nix 모드 배너가 표시됩니다

### 설정 및 상태 경로

OpenClaw 는 `OPENCLAW_CONFIG_PATH` 에서 JSON5 설정을 읽고 `OPENCLAW_STATE_DIR` 에 변경 가능한 데이터를 저장합니다. Nix 하에서 실행할 때 런타임 상태와 설정이 불변 저장소 밖에 유지되도록 이를 Nix 관리 위치로 명시적으로 설정하세요.

| 변수                   | 기본값                                  |
| ---------------------- | --------------------------------------- |
| `OPENCLAW_HOME`        | `HOME` / `USERPROFILE` / `os.homedir()` |
| `OPENCLAW_STATE_DIR`   | `~/.openclaw`                           |
| `OPENCLAW_CONFIG_PATH` | `$OPENCLAW_STATE_DIR/openclaw.json`     |

## 관련 문서

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) -- 전체 설정 가이드
- [마법사](/start/wizard) -- 비 Nix CLI 설정
- [Docker](/install/docker) -- 컨테이너화된 설정
