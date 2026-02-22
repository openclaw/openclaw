---
summary: "OpenClaw 온보딩 옵션과 흐름에 대한 개요"
read_when:
  - 온보딩 경로 선택
  - 새 환경 설정
title: "온보딩 개요"
sidebarTitle: "온보딩 개요"
---

# 온보딩 개요

OpenClaw는 게이트웨이 실행 위치와 프로바이더를 설정하는 방법에 따라 여러 가지 온보딩 경로를 지원합니다.

## 온보딩 경로 선택

- macOS, Linux, Windows (WSL2를 통해)에서 사용 가능한 **CLI 마법사**.
- Apple 실리콘 또는 Intel Mac에서의 가이드를 포함한 첫 실행을 위한 **macOS 앱**.

## CLI 온보딩 마법사

터미널에서 마법사를 실행하세요:

```bash
openclaw onboard
```

게이트웨이, 작업 공간, 채널 및 스킬을 완벽하게 제어하려는 경우 CLI 마법사를 사용하세요. 문서:

- [온보딩 마법사 (CLI)](/ko-KR/start/wizard)
- [`openclaw onboard` 명령어](/ko-KR/cli/onboard)

## macOS 앱 온보딩

macOS에서 완전한 가이드 설정을 원할 때 OpenClaw 앱을 사용하세요. 문서:

- [온보딩 (macOS 앱)](/ko-KR/start/onboarding)

## 사용자 지정 프로바이더

표준 OpenAI 또는 Anthropic API를 노출하는 호스트 프로바이더를 포함하여 나열되지 않은 엔드포인트가 필요한 경우 CLI 마법사에서 **사용자 지정 프로바이더**를 선택하십시오. 다음을 요청받을 것입니다:

- OpenAI 호환, Anthropic 호환, 또는 **알 수 없음** (자동 감지) 중 하나를 선택하세요.
- 기본 URL 및 API 키 (프로바이더가 요구할 경우)를 입력하세요.
- 모델 ID 및 선택적 별칭을 제공하세요.
- 여러 사용자 지정 엔드포인트가 공존할 수 있도록 엔드포인트 ID를 선택하세요.

자세한 단계는 위의 CLI 온보딩 문서를 참조하세요.
