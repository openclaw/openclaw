---
summary: "Overview of OpenClaw onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding Overview"
sidebarTitle: "Onboarding Overview"
x-i18n:
  source_hash: 64540138b717f4a4c1201868220d755a21b16fa330c558c33beb426cfa4504d0
---

# 온보딩 개요

OpenClaw는 게이트웨이가 실행되는 위치에 따라 여러 온보딩 경로를 지원합니다.
공급자를 구성하는 방법을 선호합니다.

## 온보딩 경로를 선택하세요

- macOS, Linux 및 Windows용 **CLI 마법사**(WSL2 사용).
- Apple Silicon 또는 Intel Mac에서 최초 실행 안내를 위한 **macOS 앱**.

## CLI 온보딩 마법사

터미널에서 마법사를 실행합니다.

```bash
openclaw onboard
```

게이트웨이, 작업공간,
채널, 스킬. 문서:

- [온보딩 마법사(CLI)](/start/wizard)
- [`openclaw onboard` 명령](/cli/onboard)

## macOS 앱 온보딩

macOS에서 전체 안내 설정을 원할 경우 OpenClaw 앱을 사용하세요. 문서:

- [온보딩(macOS 앱)](/start/onboarding)

## 맞춤형 제공자

목록에 없는 엔드포인트가 필요한 경우(호스팅 공급자 포함)
표준 OpenAI 또는 Anthropic API를 노출하려면 메뉴에서 **Custom Provider**를 선택하세요.
CLI 마법사. 귀하는 다음을 수행하라는 요청을 받게 됩니다:

- OpenAI 호환, Anthropic 호환 또는 **알 수 없음**(자동 감지)을 선택하세요.
- 기본 URL과 API 키를 입력합니다(공급자가 요구하는 경우).
- 모델 ID와 선택적 별칭을 제공하세요.
- 여러 사용자 지정 엔드포인트가 공존할 수 있도록 엔드포인트 ID를 선택합니다.

자세한 단계는 위의 CLI 온보딩 문서를 따르세요.
