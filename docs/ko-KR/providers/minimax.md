---
summary: "OpenClaw 에서 MiniMax 모델 사용하기"
read_when:
  - OpenClaw 에서 MiniMax 모델을 사용하고 싶을 때
  - MiniMax 설정 안내가 필요할 때
title: "MiniMax"
x-i18n:
  source_path: docs/providers/minimax.md
---

# MiniMax

OpenClaw 의 MiniMax 프로바이더는 기본적으로 **MiniMax M2.7** 을 사용하며 호환성을 위해 카탈로그에 **MiniMax M2.5** 를 유지합니다.

## 모델 라인업

- `MiniMax-M2.7`: 기본 호스팅 텍스트 모델.
- `MiniMax-M2.7-highspeed`: 더 빠른 M2.7 텍스트 티어.
- `MiniMax-M2.5`: 이전 텍스트 모델, MiniMax 카탈로그에서 여전히 사용 가능.
- `MiniMax-M2.5-highspeed`: 더 빠른 M2.5 텍스트 티어.
- `MiniMax-VL-01`: 텍스트 + 이미지 입력을 위한 비전 모델.

## 설정 방법 선택

### MiniMax OAuth (Coding Plan) - 권장

**적합한 경우:** OAuth 를 통한 MiniMax Coding Plan 으로 빠른 설정, API 키 불필요.

번들된 OAuth 플러그인을 활성화하고 인증합니다:

```bash
openclaw plugins enable minimax  # 이미 로드된 경우 건너뛰기
openclaw gateway restart  # 게이트웨이가 이미 실행 중이면 재시작
openclaw onboard --auth-choice minimax-portal
```

엔드포인트를 선택하라는 메시지가 표시됩니다:

- **Global** - 해외 사용자 (`api.minimax.io`)
- **CN** - 중국 사용자 (`api.minimaxi.com`)

자세한 내용은 [MiniMax 플러그인 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax) 를 참조하세요.

### MiniMax M2.7 (API 키)

**적합한 경우:** Anthropic 호환 API 를 사용한 호스팅 MiniMax.

CLI 를 통해 설정합니다:

- `openclaw configure` 를 실행합니다
- **Model/auth** 를 선택합니다
- **MiniMax** 인증 옵션을 선택합니다

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.7",
            name: "MiniMax M2.7",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "MiniMax-M2.7-highspeed",
            name: "MiniMax M2.7 Highspeed",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
          {
            id: "MiniMax-M2.5-highspeed",
            name: "MiniMax M2.5 Highspeed",
            reasoning: true,
            input: ["text"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.12 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.7 폴백 (예제)

**적합한 경우:** 최신 세대의 가장 강력한 모델을 기본으로 유지하고, MiniMax M2.7 로 장애 조치. 아래 예제는 구체적인 기본 모델로 Opus 를 사용합니다. 선호하는 최신 세대 기본 모델로 교체하세요.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "primary" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
    },
  },
}
```

### 선택 사항: LM Studio 를 통한 로컬 (수동)

**적합한 경우:** LM Studio 를 사용한 로컬 추론.
강력한 하드웨어 (예: 데스크톱/서버) 에서 LM Studio 의 로컬 서버를 사용하여 MiniMax M2.5 에서 좋은 결과를 확인했습니다.

`openclaw.json` 을 통해 수동으로 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.5-gs32" },
      models: { "lmstudio/minimax-m2.5-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.5-gs32",
            name: "MiniMax M2.5 GS32",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## `openclaw configure` 를 통한 설정

JSON 편집 없이 대화형 설정 마법사를 사용하여 MiniMax 를 설정합니다:

1. `openclaw configure` 를 실행합니다.
2. **Model/auth** 를 선택합니다.
3. **MiniMax** 인증 옵션을 선택합니다.
4. 프롬프트에서 기본 모델을 선택합니다.

## 설정 옵션

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` (Anthropic 호환) 을 선호합니다. `https://api.minimax.io/v1` 은 OpenAI 호환 페이로드에 대한 선택 사항입니다.
- `models.providers.minimax.api`: `anthropic-messages` 를 선호합니다. `openai-completions` 는 OpenAI 호환 페이로드에 대한 선택 사항입니다.
- `models.providers.minimax.apiKey`: MiniMax API 키 (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` 를 정의합니다.
- `agents.defaults.models`: 허용 목록에 포함할 모델에 별칭을 지정합니다.
- `models.mode`: 내장 모델과 함께 MiniMax 를 추가하려면 `merge` 를 유지하세요.

## 참고 사항

- 모델 참조는 `minimax/<model>` 형식입니다.
- 기본 텍스트 모델: `MiniMax-M2.7`.
- 대체 텍스트 모델: `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`.
- Coding Plan 사용량 API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (coding plan 키 필요).
- 정확한 비용 추적이 필요하면 `models.json` 의 가격 값을 업데이트하세요.
- MiniMax Coding Plan 추천 링크 (10% 할인): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- [/concepts/model-providers](/concepts/model-providers) 에서 프로바이더 규칙을 확인하세요.
- `openclaw models list` 및 `openclaw models set minimax/MiniMax-M2.7` 을 사용하여 전환하세요.

## 문제 해결

### "Unknown model: minimax/MiniMax-M2.7"

이것은 보통 **MiniMax 프로바이더가 설정되지 않았음** (프로바이더 항목이 없고 MiniMax 인증 프로필/환경 키가 발견되지 않음) 을 의미합니다. 이 감지에 대한 수정은 **2026.1.12** (작성 시점에 미출시) 에 있습니다. 다음과 같이 수정하세요:

- **2026.1.12** 로 업그레이드 (또는 소스 `main` 에서 실행) 한 다음 게이트웨이를 재시작합니다.
- `openclaw configure` 를 실행하고 **MiniMax** 인증 옵션을 선택하거나,
- `models.providers.minimax` 블록을 수동으로 추가하거나,
- `MINIMAX_API_KEY` (또는 MiniMax 인증 프로필) 를 설정하여 프로바이더가 주입될 수 있도록 합니다.

모델 ID 는 **대소문자를 구분** 합니다:

- `minimax/MiniMax-M2.7`
- `minimax/MiniMax-M2.7-highspeed`
- `minimax/MiniMax-M2.5`
- `minimax/MiniMax-M2.5-highspeed`

다음으로 다시 확인하세요:

```bash
openclaw models list
```
