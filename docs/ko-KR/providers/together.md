---
summary: "Together AI setup (auth + model selection)"
read_when:
  - You want to use Together AI with OpenClaw
  - You need the API key env var or CLI auth choice
x-i18n:
  source_hash: 7d3af832503192fdeb117148262f22e72df21be8187a25393f9468529cf0c804
---

# 함께하는 AI

[Together AI](https://together.ai)는 통합 API를 통해 Llama, DeepSeek, Kimi 등을 포함한 주요 오픈 소스 모델에 대한 액세스를 제공합니다.

- 제공자: `together`
- 인증: `TOGETHER_API_KEY`
- API: OpenAI 호환

## 빠른 시작

1. API 키를 설정합니다(권장: 게이트웨이용으로 저장).

```bash
openclaw onboard --auth-choice together-api-key
```

2. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## 비대화형 예시

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

그러면 `together/moonshotai/Kimi-K2.5`가 기본 모델로 설정됩니다.

## 환경 참고 사항

게이트웨이가 데몬(launchd/systemd)으로 실행되는 경우 `TOGETHER_API_KEY`를 확인하세요.
해당 프로세스에서 사용할 수 있습니다(예: `~/.clawdbot/.env` 또는 다음을 통해).
`env.shellEnv`).

## 사용 가능한 모델

Together AI는 다음과 같은 다양한 인기 오픈 소스 모델에 대한 액세스를 제공합니다.

- **GLM 4.7 Fp8** - 200K 컨텍스트 창이 있는 기본 모델
- **Llama 3.3 70B Instruct Turbo** - 빠르고 효율적인 지시 따르기
- **Llama 4 Scout** - 이미지 이해가 가능한 비전 모델
- **Llama 4 Maverick** - 고급 비전 및 추론
- **DeepSeek V3.1** - 강력한 코딩 및 추론 모델
- **DeepSeek R1** - 고급 추론 모델
- **Kimi K2 Instruct** - 262K 컨텍스트 윈도우를 갖춘 고성능 모델

모든 모델은 표준 채팅 완료를 지원하며 OpenAI API와 호환됩니다.
