---
summary: "OpenClaw 에서 MiniMax M2.1 사용"
read_when:
  - OpenClaw 에서 MiniMax 모델을 원할 때
  - MiniMax 설정 가이드가 필요할 때
title: "MiniMax"
---

# MiniMax

MiniMax 는 **M2/M2.1** 모델 계열을 구축하는 AI 회사입니다. 현재로서는 현실 세계의 복잡한 작업을 위해 제작된 **MiniMax M2.1** (2025년 12월 23일)이 가장 코딩에 중점을 둔 릴리스입니다.

출처: [MiniMax M2.1 출시 노트](https://www.minimax.io/news/minimax-m21)

## 모델 개요 (M2.1)

MiniMax 는 M2.1에서 다음과 같은 개선 사항을 강조합니다:

- 강력한 **다중 언어 코딩** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- 더 나은 **웹/앱 개발** 및 미적 출력 품질 (네이티브 모바일 포함).
- 오피스 스타일의 워크플로를 위한 **복합 지침** 처리 개선, 교차 사고 및 통합된 제약 조건 실행 기반.
- 낮은 토큰 사용과 빠른 반복 루프로 **더 간결한 응답**.
- 강력한 **도구/에이전트 프레임워크** 호환성과 컨텍스트 관리 (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- 고품질의 **대화 및 기술 문서 작성** 출력.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **속도:** Lightning은 MiniMax의 가격 문서에서 "빠른" 변형입니다.
- **비용:** 가격은 동일한 입력 비용을 보여주지만, Lightning은 출력 비용이 더 높습니다.
- **코딩 계획 라우팅:** Lightning 백엔드는 MiniMax 코딩 계획에서 직접 사용할 수 없습니다. MiniMax는 대부분의 요청을 Lightning으로 자동 라우팅하지만 트래픽 급증 시 일반 M2.1 백엔드로 돌아갑니다.

## 설정 선택

### MiniMax OAuth (코딩 계획) — 추천

**최적의 대상:** OAuth를 통한 MiniMax 코딩 계획을 사용한 빠른 설정, API 키 불필요.

번들로 제공된 OAuth 플러그인을 활성화하고 인증:

```bash
openclaw plugins enable minimax-portal-auth  # 이미 로드된 경우 생략.
openclaw gateway restart  # 게이트웨이가 이미 실행 중인 경우 재시작
openclaw onboard --auth-choice minimax-portal
```

엔드포인트 선택을 요청받을 것입니다:

- **Global** - 국제 사용자 (`api.minimax.io`)
- **CN** - 중국 사용자 (`api.minimaxi.com`)

자세한 내용은 [MiniMax OAuth 플러그인 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)를 참조하세요.

### MiniMax M2.1 (API 키)

**최적의 대상:** Anthropic 호환 API를 사용하는 호스팅 MiniMax.

CLI를 통해 구성:

- `openclaw configure` 실행
- **Model/auth** 선택
- **MiniMax M2.1** 선택

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 as fallback (Opus primary)

**최적의 대상:** Opus 4.6을 기본으로 유지하고, MiniMax M2.1로 장애 조치.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### 선택 사항: LM Studio 를 통한 로컬 (수동)

**최적의 대상:** LM Studio 를 사용한 로컬 추론.
당사는 강력한 하드웨어 (예: 데스크톱/서버)에서 LM Studio의 로컬 서버를 사용하여 MiniMax M2.1과 함께 강력한 결과를 보았습니다.

`openclaw.json`을 통해 수동으로 구성:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
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
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
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

## `openclaw configure` 를 통한 구성

인터랙티브 구성 마법사를 사용하여 JSON을 편집하지 않고 MiniMax를 설정하세요:

1. `openclaw configure` 실행.
2. **Model/auth** 선택.
3. **MiniMax M2.1** 선택.
4. 프롬프트가 표시되면 기본 모델을 선택.

## 구성 옵션

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` (Anthropic 호환)를 선호; `https://api.minimax.io/v1`는 OpenAI 호환 페이로드에 대한 선택 사항.
- `models.providers.minimax.api`: `anthropic-messages`를 선호; `openai-completions`는 OpenAI 호환 페이로드에 대한 선택 사항.
- `models.providers.minimax.apiKey`: MiniMax API 키 (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` 정의.
- `agents.defaults.models`: 허용 목록에 원하는 모델의 별칭 지정.
- `models.mode`: 기본 탑재 모델과 함께 MiniMax를 추가하려면 `merge`로 유지.

## 주의사항

- 모델 참조는 `minimax/<model>`입니다.
- 코딩 계획 사용 API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (코딩 계획 키 필요).
- 정확한 비용 추적이 필요하면 `models.json`의 가격 값을 업데이트하십시오.
- MiniMax 코딩 계획에 대한 추천 링크 (10% 할인): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 공급자 규칙에 대한 내용은 [/concepts/model-providers](/ko-KR/concepts/model-providers)를 참조하세요.
- `openclaw models list` 및 `openclaw models set minimax/MiniMax-M2.1`를 사용하여 전환.

## 문제 해결

### "알 수 없는 모델: minimax/MiniMax-M2.1"

이 경우 일반적으로 **MiniMax 프로바이더가 구성되지 않음**을 의미합니다 (프로바이더 항목 없음 및 MiniMax 인증 프로필/환경 키 없음). 이 감지에 대한 수정 사항은 **2026.1.12** (작성 당시 미출시)에 있습니다. 수정 방법:

- **2026.1.12**로 업그레이드 (또는 소스 `main`에서 실행), 그런 다음 게이트웨이를 재시작.
- `openclaw configure`를 실행하고 **MiniMax M2.1**를 선택, 또는
- `models.providers.minimax` 블록을 수동으로 추가, 또는
- `MINIMAX_API_KEY` (또는 MiniMax 인증 프로필) 설정하여 프로바이더가 주입될 수 있도록 합니다.

모델 ID가 **대소문자를 구분**하는 지 확인하세요:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

그런 다음 다음 명령어로 다시 확인하십시오:

```bash
openclaw models list
```