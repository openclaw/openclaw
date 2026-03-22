---
title: "Volcengine (Doubao)"
summary: "Volcano Engine 설정 (Doubao 모델, 일반 + 코딩 엔드포인트)"
read_when:
  - OpenClaw 에서 Volcano Engine 또는 Doubao 모델을 사용하고 싶을 때
  - Volcengine API 키 설정이 필요할 때
x-i18n:
  source_path: docs/providers/volcengine.md
---

# Volcengine (Doubao)

Volcengine 프로바이더는 일반 및 코딩 워크로드를 위한 별도의 엔드포인트와 함께 Doubao 모델 및 Volcano Engine 에서 호스팅되는 서드파티 모델에 대한 액세스를 제공합니다.

- 프로바이더: `volcengine` (일반) + `volcengine-plan` (코딩)
- 인증: `VOLCANO_ENGINE_API_KEY`
- API: OpenAI 호환

## 빠른 시작

1. API 키를 설정합니다:

```bash
openclaw onboard --auth-choice volcengine-api-key
```

2. 기본 모델을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "volcengine-plan/ark-code-latest" },
    },
  },
}
```

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

## 프로바이더 및 엔드포인트

| 프로바이더        | 엔드포인트                                | 사용 사례 |
| ----------------- | ----------------------------------------- | --------- |
| `volcengine`      | `ark.cn-beijing.volces.com/api/v3`        | 일반 모델 |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | 코딩 모델 |

두 프로바이더 모두 단일 API 키로 설정됩니다. 설정 시 두 프로바이더가 자동으로 등록됩니다.

## 사용 가능한 모델

- **doubao-seed-1-8** - Doubao Seed 1.8 (일반, 기본)
- **doubao-seed-code-preview** - Doubao 코딩 모델
- **ark-code-latest** - 코딩 플랜 기본
- **Kimi K2.5** - Volcano Engine 을 통한 Moonshot AI
- **GLM-4.7** - Volcano Engine 을 통한 GLM
- **DeepSeek V3.2** - Volcano Engine 을 통한 DeepSeek

대부분의 모델은 텍스트 + 이미지 입력을 지원합니다. 컨텍스트 윈도우는 128K 에서 256K 토큰 범위입니다.

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `VOLCANO_ENGINE_API_KEY` 가 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).
