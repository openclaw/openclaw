---
summary: "OpenClaw에서 NVIDIA의 OpenAI 호환 API 사용"
read_when:
  - OpenClaw에서 NVIDIA 모델을 사용하고 싶을 때
  - NVIDIA_API_KEY 설정이 필요할 때
title: "NVIDIA"
---

# NVIDIA

NVIDIA는 Nemotron 및 NeMo 모델을 위한 OpenAI 호환 API를 `https://integrate.api.nvidia.com/v1`에서 제공합니다. [NVIDIA NGC](https://catalog.ngc.nvidia.com/)에서 API 키로 인증하세요.

## CLI 설정

키를 한 번 내보낸 후 온보딩을 실행하고 NVIDIA 모델을 설정하세요:

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

여전히 `--token`을 사용하는 경우, 이는 셸 기록과 `ps` 출력에 남는다는 것을 기억하고 가능하면 환경 변수를 사용하세요.

## 구성 스니펫

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## 모델 ID

- `nvidia/llama-3.1-nemotron-70b-instruct` (기본값)
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## 주의사항

- OpenAI 호환 `/v1` 엔드포인트; NVIDIA NGC에서 API 키를 사용하세요.
- `NVIDIA_API_KEY`가 설정되면 프로바이더가 자동으로 활성화됩니다; 고정 기본값을 사용합니다 (131,072-토큰 컨텍스트 윈도우, 최대 4,096 토큰).
