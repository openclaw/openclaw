---
summary: "Install OpenClaw declaratively with Nix"
read_when:
  - You want reproducible, rollback-able installs
  - You're already using Nix/NixOS/Home Manager
  - You want everything pinned and managed declaratively
title: "Nix"
x-i18n:
  source_hash: 452723b6e8e756d6ade03611f616f748900267eb8f7447802f679e6dd51c0ba2
---

# 닉스 설치

Nix와 함께 OpenClaw를 실행하는 권장 방법은 배터리가 포함된 홈 관리자 모듈인 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)**를 사용합니다.

## 빠른 시작

이것을 AI 에이전트(Claude, Cursor 등)에 붙여넣습니다.

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

> **📦 전체 가이드: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw 저장소는 Nix 설치의 정보 소스입니다. 이 페이지는 간략한 개요입니다.

## 당신이 얻는 것

- 게이트웨이 + macOS 앱 + 도구(귓속말, Spotify, 카메라) — 모두 고정됨
- 재부팅 후에도 유지되는 서비스 출시
- 선언적 구성을 갖춘 플러그인 시스템
- 즉시 롤백: `home-manager switch --rollback`

---

## Nix 모드 런타임 동작

`OPENCLAW_NIX_MODE=1`가 설정된 경우(nix-openclaw에서 자동):

OpenClaw는 구성을 결정적으로 만들고 자동 설치 흐름을 비활성화하는 **Nix 모드**를 지원합니다.
다음을 내보내서 활성화하세요.

```bash
OPENCLAW_NIX_MODE=1
```

macOS에서 GUI 앱은 셸 환경 변수를 자동으로 상속하지 않습니다. 당신은 할 수 있습니다
또한 기본값을 통해 Nix 모드를 활성화합니다.

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### 구성 + 상태 경로

OpenClaw는 `OPENCLAW_CONFIG_PATH`에서 JSON5 구성을 읽고 `OPENCLAW_STATE_DIR`에 변경 가능한 데이터를 저장합니다.
필요한 경우 `OPENCLAW_HOME`를 설정하여 내부 경로 확인에 사용되는 기본 홈 디렉터리를 제어할 수도 있습니다.

- `OPENCLAW_HOME` (기본 우선순위: `HOME` / `USERPROFILE` / `os.homedir()`)
- `OPENCLAW_STATE_DIR` (기본값: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (기본값: `$OPENCLAW_STATE_DIR/openclaw.json`)

Nix에서 실행하는 경우 이를 Nix 관리 위치로 명시적으로 설정하여 런타임 상태 및 구성을 확인하세요.
불변 저장소에서 벗어나십시오.

### Nix 모드의 런타임 동작

- 자동 설치 및 자체 변형 흐름이 비활성화됩니다.
- 누락된 종속성이 Nix 관련 수정 메시지를 표시합니다.
- UI가 있는 경우 읽기 전용 Nix 모드 배너를 표시합니다.

## 포장 참고 사항(macOS)

macOS 패키징 흐름에서는 다음 위치에 안정적인 Info.plist 템플릿이 필요합니다.

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)는 이 템플릿을 앱 번들에 복사하고 동적 필드를 패치합니다.
(번들 ID, 버전/빌드, Git SHA, Sparkle 키). 이는 SwiftPM에 대한 plist 결정성을 유지합니다.
패키징 및 Nix 빌드(전체 Xcode 툴체인에 의존하지 않음)

## 관련

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 전체 설정 가이드
- [Wizard](/start/wizard) — Nix가 아닌 CLI 설정
- [Docker](/install/docker) — 컨테이너화된 설정
