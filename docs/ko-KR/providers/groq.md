---
title: "Groq"
summary: "Groq 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw 에서 Groq 를 사용하고 싶을 때
  - API 키 환경 변수 또는 CLI 인증 선택이 필요할 때
x-i18n:
  source_path: docs/providers/groq.md
---

# Groq

[Groq](https://groq.com) 는 커스텀 LPU 하드웨어를 사용하여 오픈소스 모델 (Llama, Gemma, Mistral 등) 에 대한 초고속 추론을 제공합니다. OpenClaw 는 OpenAI 호환 API 를 통해 Groq 에 연결합니다.

- 프로바이더: `groq`
- 인증: `GROQ_API_KEY`
- API: OpenAI 호환

## 빠른 시작

1. [console.groq.com/keys](https://console.groq.com/keys) 에서 API 키를 받으세요.

2. API 키를 설정합니다:

```bash
export GROQ_API_KEY="gsk_..."
```

3. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## 설정 파일 예제

```json5
{
  env: { GROQ_API_KEY: "gsk_..." },
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## 오디오 전사

Groq 는 빠른 Whisper 기반 오디오 전사도 제공합니다. 미디어 이해 프로바이더로 설정하면, OpenClaw 는 Groq 의 `whisper-large-v3-turbo` 모델을 사용하여 음성 메시지를 전사합니다.

```json5
{
  media: {
    understanding: {
      audio: {
        models: [{ provider: "groq" }],
      },
    },
  },
}
```

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `GROQ_API_KEY` 가 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).

## 사용 가능한 모델

Groq 의 모델 카탈로그는 자주 변경됩니다. `openclaw models list | grep groq` 를 실행하여 현재 사용 가능한 모델을 확인하거나 [console.groq.com/docs/models](https://console.groq.com/docs/models) 를 확인하세요.

인기 있는 선택지:

- **Llama 3.3 70B Versatile** - 범용, 대형 컨텍스트
- **Llama 3.1 8B Instant** - 빠르고 경량
- **Gemma 2 9B** - 컴팩트하고 효율적
- **Mixtral 8x7B** - MoE 아키텍처, 강력한 추론

## 링크

- [Groq Console](https://console.groq.com)
- [API 문서](https://console.groq.com/docs)
- [모델 목록](https://console.groq.com/docs/models)
- [가격](https://groq.com/pricing)
