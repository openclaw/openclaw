---
summary: "Nix 로 OpenClaw 를 선언적으로 설치"
read_when:
  - 재현 가능하고 롤백 가능한 설치를 원할 때
  - 이미 Nix/NixOS/Home Manager 를 사용하고 있을 때
  - 모든 것을 고정하고 선언적으로 관리하고 싶을 때
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:26Z
---

# Nix 설치

Nix 로 OpenClaw 를 실행하는 권장 방법은 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** 를 사용하는 것입니다. 이는 모든 것이 포함된 Home Manager 모듈입니다.

## 빠른 시작

다음을 AI 에이전트(Claude, Cursor 등)에 붙여 넣으십시오:

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
> nix-openclaw 저장소는 Nix 설치에 대한 단일 진실 공급원입니다. 이 페이지는 간단한 개요만 제공합니다.

## 제공되는 것

- Gateway(게이트웨이) + macOS 앱 + 도구(whisper, spotify, cameras) — 모두 고정됨
- 재부팅 후에도 유지되는 Launchd 서비스
- 선언적 설정을 갖춘 플러그인 시스템
- 즉시 롤백: `home-manager switch --rollback`

---

## Nix 모드 런타임 동작

`OPENCLAW_NIX_MODE=1` 가 설정되면(nix-openclaw 사용 시 자동):

OpenClaw 는 구성을 결정론적으로 만들고 자동 설치 흐름을 비활성화하는 **Nix 모드**를 지원합니다.
다음을 export 하여 활성화할 수 있습니다:

```bash
OPENCLAW_NIX_MODE=1
```

macOS 에서는 GUI 앱이 셸 환경 변수를 자동으로 상속하지 않습니다. defaults 를 통해서도
Nix 모드를 활성화할 수 있습니다:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### 구성 + 상태 경로

OpenClaw 는 `OPENCLAW_CONFIG_PATH` 에서 JSON5 구성을 읽고, 변경 가능한 데이터는 `OPENCLAW_STATE_DIR` 에 저장합니다.

- `OPENCLAW_STATE_DIR` (기본값: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (기본값: `$OPENCLAW_STATE_DIR/openclaw.json`)

Nix 환경에서 실행할 때는 런타임 상태와 구성이 불변 스토어 밖에 유지되도록
이 값들을 Nix 가 관리하는 위치로 명시적으로 설정하십시오.

### Nix 모드에서의 런타임 동작

- 자동 설치 및 자기 변경 흐름이 비활성화됩니다
- 누락된 의존성은 Nix 전용 해결 메시지로 표시됩니다
- UI 에서는 존재 시 읽기 전용 Nix 모드 배너를 표시합니다

## 패키징 참고 사항(macOS)

macOS 패키징 흐름은 다음 위치의 안정적인 Info.plist 템플릿을 기대합니다:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 는 이 템플릿을 앱 번들로 복사하고 동적 필드
(번들 ID, 버전/빌드, Git SHA, Sparkle 키)를 패치합니다. 이를 통해 SwiftPM
패키징과 Nix 빌드(전체 Xcode 툴체인에 의존하지 않음)를 위해 plist 를 결정론적으로 유지합니다.

## 관련

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 전체 설정 가이드
- [Wizard](/start/wizard) — Nix 가 아닌 CLI 설정
- [Docker](/install/docker) — 컨테이너화된 설정
