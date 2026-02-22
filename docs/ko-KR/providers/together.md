---
summary: "Together AI 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw와 함께 Together AI를 사용하려고 할 때
  - API 키 환경 변수 또는 CLI 인증 선택이 필요할 때
---

# Together AI

[Together AI](https://together.ai)는 통합 API를 통해 Llama, DeepSeek, Kimi 등과 같은 주요 오픈 소스 모델에 접근할 수 있도록 제공합니다.

- 프로바이더: `together`
- 인증: `TOGETHER_API_KEY`
- API: OpenAI 호환

## 빠른 시작

1. API 키 설정 (권장: 게이트웨이를 위해 저장):

```bash
openclaw onboard --auth-choice together-api-key
```

2. 기본 모델 설정:

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

이를 통해 `together/moonshotai/Kimi-K2.5`가 기본 모델로 설정됩니다.

## 환경 주의사항

게이트웨이가 데몬(launchd/systemd)으로 실행되는 경우, 해당 프로세스에서 `TOGETHER_API_KEY`가 사용할 수 있도록 설정하십시오 (예: `~/.clawdbot/.env` 또는 `env.shellEnv`를 통해).

## 사용 가능한 모델

Together AI는 다양한 인기 오픈 소스 모델에 대한 접근을 제공합니다:

- **GLM 4.7 Fp8** - 200K 컨텍스트 창을 가진 기본 모델
- **Llama 3.3 70B Instruct Turbo** - 빠르고 효율적인 명령 수행
- **Llama 4 Scout** - 이미지 이해를 위한 비전 모델
- **Llama 4 Maverick** - 고급 비전 및 추론
- **DeepSeek V3.1** - 강력한 코딩 및 추론 모델
- **DeepSeek R1** - 고급 추론 모델
- **Kimi K2 Instruct** - 262K 컨텍스트 창을 가진 고성능 모델

모든 모델은 표준 채팅 완료를 지원하며 OpenAI API 호환됩니다.
