---
summary: "`openclaw onboard` CLI 참조 (대화형 온보딩 마법사)"
read_when:
  - 게이트웨이, 워크스페이스, 인증, 채널 및 스킬에 대한 안내 설정을 원할 때
title: "onboard"
---

# `openclaw onboard`

대화형 온보딩 마법사 (로컬 또는 원격 게이트웨이 설정).

## 관련 안내서

- CLI 온보딩 허브: [온보딩 마법사 (CLI)](/ko-KR/start/wizard)
- 온보딩 개요: [온보딩 개요](/ko-KR/start/onboarding-overview)
- CLI 온보딩 참조: [CLI 온보딩 참조](/ko-KR/start/wizard-cli-reference)
- CLI 자동화: [CLI 자동화](/ko-KR/start/wizard-cli-automation)
- macOS 온보딩: [온보딩 (macOS 앱)](/ko-KR/start/onboarding)

## Examples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

비대화형 커스텀 프로바이더:

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key`는 비대화형 모드에서 선택 사항입니다. 생략하면 온보딩이 `CUSTOM_API_KEY`를 확인합니다.

비대화형 Z.AI 엔드포인트 선택:

참고: `--auth-choice zai-api-key`는 이제 키에 대한 최적의 Z.AI 엔드포인트를 자동으로 감지합니다 (일반 API를 `zai/glm-5`로 우선 선택).
특히 GLM 코딩 플랜 엔드포인트를 원하시면 `zai-coding-global` 또는 `zai-coding-cn`을 선택하십시오.

```bash
# 프롬프트 없는 엔드포인트 선택
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# 다른 Z.AI 엔드포인트 선택:
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

Flow notes:

- `quickstart`: 최소 프롬프트, 게이트웨이 토큰 자동 생성.
- `manual`: 포트/바인드/인증에 대한 전체 프롬프트 (`advanced`의 별칭).
- 가장 빠른 첫 번째 채팅: `openclaw dashboard` (채널 설정 없이 제어 UI).
- 커스텀 프로바이더: 나열되지 않은 호스팅 프로바이더 포함, OpenAI 또는 Anthropic 호환 엔드포인트에 연결.
  Unknown을 사용하여 자동 감지.

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`은 비대화형 모드를 의미하지 않습니다. 스크립트에는 `--non-interactive`를 사용하십시오.
</Note>