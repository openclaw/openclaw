---
title: "Model Studio"
summary: "Alibaba Cloud Model Studio 설정 (Coding Plan, 이중 리전 엔드포인트)"
read_when:
  - OpenClaw 에서 Alibaba Cloud Model Studio 를 사용하고 싶을 때
  - Model Studio 의 API 키 환경 변수가 필요할 때
x-i18n:
  source_path: docs/providers/modelstudio.md
---

# Model Studio (Alibaba Cloud)

Model Studio 프로바이더는 Qwen 및 플랫폼에서 호스팅되는 서드파티 모델을 포함한 Alibaba Cloud Coding Plan 모델에 대한 액세스를 제공합니다.

- 프로바이더: `modelstudio`
- 인증: `MODELSTUDIO_API_KEY`
- API: OpenAI 호환

## 빠른 시작

1. API 키를 설정합니다:

```bash
openclaw onboard --auth-choice modelstudio-api-key
```

2. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "modelstudio/qwen3.5-plus" },
    },
  },
}
```

## 리전 엔드포인트

Model Studio 에는 리전에 따라 두 개의 엔드포인트가 있습니다:

| 리전      | 엔드포인트                           |
| --------- | ------------------------------------ |
| 중국 (CN) | `coding.dashscope.aliyuncs.com`      |
| 글로벌    | `coding-intl.dashscope.aliyuncs.com` |

프로바이더는 인증 선택에 따라 자동 선택합니다 (글로벌은 `modelstudio-api-key`, 중국은 `modelstudio-api-key-cn`). 설정에서 사용자 정의 `baseUrl` 로 재정의할 수 있습니다.

## 사용 가능한 모델

- **qwen3.5-plus** (기본) - Qwen 3.5 Plus
- **qwen3-max** - Qwen 3 Max
- **qwen3-coder** 시리즈 - Qwen 코딩 모델
- **GLM-5**, **GLM-4.7** - Alibaba 를 통한 GLM 모델
- **Kimi K2.5** - Alibaba 를 통한 Moonshot AI
- **MiniMax-M2.5** - Alibaba 를 통한 MiniMax

대부분의 모델은 이미지 입력을 지원합니다. 컨텍스트 윈도우는 200K 에서 1M 토큰 범위입니다.

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `MODELSTUDIO_API_KEY` 가 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).
