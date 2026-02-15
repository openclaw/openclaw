---
summary: "CLI reference for `openclaw onboard` (interactive onboarding wizard)"
read_when:
  - You want guided setup for gateway, workspace, auth, channels, and skills
title: "onboard"
x-i18n:
  source_hash: 5502365b03441ece64474abaea08991efd38384713f0cabec4d72b1394153b78
---

# `openclaw onboard`

대화형 온보딩 마법사(로컬 또는 원격 게이트웨이 설정)

## 관련 가이드

- CLI 온보딩 허브: [온보딩 마법사(CLI)](/start/wizard)
- 온보딩 개요: [온보딩 개요](/start/onboarding-overview)
- CLI 온보딩 참조: [CLI 온보딩 참조](/start/wizard-cli-reference)
- CLI 자동화: [CLI 자동화](/start/wizard-cli-automation)
- macOS 온보딩: [온보딩(macOS 앱)](/start/onboarding)

## 예

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

비대화형 사용자 정의 공급자:

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key`는 비대화형 모드에서는 선택 사항입니다. 생략하면 온보딩에서 `CUSTOM_API_KEY`를 확인합니다.

비대화형 Z.AI 엔드포인트 선택:

참고: `--auth-choice zai-api-key`는 이제 키에 가장 적합한 Z.AI 엔드포인트를 자동 감지합니다(`zai/glm-5`를 사용하는 일반 API를 선호함).
GLM 코딩 계획 엔드포인트를 구체적으로 원하는 경우 `zai-coding-global` 또는 `zai-coding-cn`를 선택합니다.

```bash
# Promptless endpoint selection
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Other Z.AI endpoint choices:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

흐름 참고사항:

- `quickstart`: 최소 프롬프트, 게이트웨이 토큰을 자동 생성합니다.
- `manual`: 포트/바인드/인증에 대한 전체 프롬프트(`advanced`의 별칭).
- 가장 빠른 첫 번째 채팅: `openclaw dashboard` (컨트롤 UI, 채널 설정 없음).
- 맞춤형 제공자: OpenAI 또는 Anthropic 호환 엔드포인트를 연결합니다.
  목록에 없는 호스팅 제공업체도 포함됩니다. 자동 감지하려면 Unknown을 사용하세요.

## 일반적인 후속 명령

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`는 비대화형 모드를 의미하지 않습니다. 스크립트에는 `--non-interactive`를 사용하세요.
</Note>
