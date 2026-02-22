---
summary: "Nix로 선언적으로 OpenClaw 설치하기"
read_when:
  - 재현 가능하고 롤백 가능한 설치가 필요한 경우
  - 이미 Nix/NixOS/Home Manager를 사용하고 있는 경우
  - 모든 것을 핀 고정하고 선언적으로 관리하고 싶은 경우
title: "Nix"
---

# Nix 설치

Nix로 OpenClaw를 실행하는 권장 방법은 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — 배터리 포함 Home Manager 모듈을 사용하는 것입니다.

## 빠른 시작

이 내용을 귀하의 AI 에이전트(Claude, Cursor 등)에 붙여넣으세요:

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 전체 안내서: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw 저장소는 Nix 설치에 대한 진실의 원천입니다. 이 페이지는 단지 간략한 개요입니다.

## 얻을 수 있는 것

- Gateway + macOS 앱 + 도구들 (whisper, spotify, cameras) — 모두 핀 고정
- 재부팅에도 살아남는 Launchd 서비스
- 선언적 설정의 플러그인 시스템
- 즉각적인 롤백: `home-manager switch --rollback`

---

## Nix 모드 런타임 동작

`OPENCLAW_NIX_MODE=1`이 설정된 경우(nix-openclaw와 함께 자동):

OpenClaw는 구성을 결정적으로 만들고 자동 설치 흐름을 비활성화하는 **Nix 모드**를 지원합니다.
이를 활성화하려면 다음과 같이 내보내기하세요:

```bash
OPENCLAW_NIX_MODE=1
```

macOS에서는 GUI 앱이 쉘 환경 변수를 자동으로 상속받지 않습니다. 기본값을 통해 Nix 모드를 활성화할 수 있습니다:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### 설정 + 상태 경로

OpenClaw는 `OPENCLAW_CONFIG_PATH`에서 JSON5 구성을 읽고 가변 데이터를 `OPENCLAW_STATE_DIR`에 저장합니다. 필요에 따라 내부 경로 해석을 위한 기본 홈 디렉토리를 제어하려면 `OPENCLAW_HOME`을 설정할 수도 있습니다.

- `OPENCLAW_HOME` (기본 우선순위: `HOME` / `USERPROFILE` / `os.homedir()`)
- `OPENCLAW_STATE_DIR` (기본: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (기본: `$OPENCLAW_STATE_DIR/openclaw.json`)

Nix 환경에서 실행할 때는 런타임 상태와 설정이 불변 스토어에서 벗어날 수 있도록 이를 명시적으로 Nix 관리 위치에 설정하세요.

### Nix 모드의 런타임 동작

- 자동 설치 및 자체 변이 흐름 비활성화
- Nix에 특화된 수정 메시지를 나타내는 의존성 누락
- Nix 모드 배너가 표시될 때 UI는 읽기 전용 모드로 나타남

## 패키징 주의사항 (macOS)

macOS 패키징 흐름은 다음 위치에 안정적인 Info.plist 템플릿을 기대합니다:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 스크립트는 이 템플릿을 앱 번들에 복사하고 동적 필드를 패치합니다 (번들 ID, 버전/빌드, Git SHA, Sparkle 키). 이는 SwiftPM 패키징 및 Nix 빌드를 위해 plist를 결정적으로 유지합니다 (완전한 Xcode 툴체인에 의존하지 않음).

## 관련 항목

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 전체 설정 가이드
- [Wizard](/ko-KR/start/wizard) — Nix가 아닌 CLI 설정
- [Docker](/ko-KR/install/docker) — 컨테이너화된 설정