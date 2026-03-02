---
summary: "OpenClaw에서 MiniMax M2.1을 사용합니다"
read_when:
  - OpenClaw에서 MiniMax 모델을 사용하고 싶을 때
  - MiniMax 설정 지침이 필요할 때
title: "MiniMax"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/minimax.md"
  workflow: 15
---

# MiniMax

MiniMax는 **M2/M2.1** 모델 제품군을 구축하는 AI 회사입니다. 현재 코딩에 중점을 둔 릴리스는 **MiniMax M2.1** (2025년 12월 23일)이며, 실제 복잡한 작업을 위해 구축되었습니다.

소스: [MiniMax M2.1 릴리스 노트](https://www.minimax.io/news/minimax-m21)

## 모델 개요 (M2.1)

MiniMax는 M2.1에서 이러한 개선 사항을 강조합니다:

- 더 강력한 **다중 언어 코딩** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- 더 나은 **웹/앱 개발** 및 미적 출력 품질 (네이티브 모바일 포함).
- 개선된 **복합 지시사항** 처리로 사무실 스타일 워크플로우를 위해 인터리브 사고와 통합된 제약 조건 실행을 기반으로 합니다.
- **더 간결한 응답** 및 더 낮은 토큰 사용 및 더 빠른 반복 루프.
- 더 강력한 **도구/에이전트 프레임워크** 호환성 및 컨텍스트 관리 (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- 더 높은 품질의 **대화 및 기술 작성** 출력.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **속도:** Lightning은 MiniMax의 가격 책정 문서에서 "빠른" 변형입니다.
- **비용:** 가격 책정은 동일한 입력 비용을 보여주지만 Lightning은 더 높은 출력 비용을 가집니다.
- **코딩 계획 라우팅:** Lightning 백엔드는 MiniMax 코딩 계획에서 직접 사용할 수 없습니다. MiniMax는 대부분의 요청을 Lightning으로 자동 라우팅하지만 트래픽 급증 중에 일반 M2.1 백엔드로 폴백됩니다.

## 설정 선택

### MiniMax OAuth (코딩 계획) — 권장

**최고:** MiniMax 코딩 계획을 통해 빠른 설정 OAuth, API 키가 필요하지 않습니다.

번들 OAuth 플러그인을 활성화하고 인증합니다:

```bash
openclaw plugins enable minimax-portal-auth  # 이미 로드된 경우 건너뛰기.
openclaw gateway restart  # 게이트웨이가 이미 실행 중인 경우 다시 시작
openclaw onboard --auth-choice minimax-portal
```

엔드포인트를 선택하라는 메시지가 표시됩니다:

- **Global** - 국제 사용자 (`api.minimax.io`)
- **CN** - 중국의 사용자 (`api.minimaxi.com`)

자세한 내용은 [MiniMax OAuth 플러그인 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)를 참조하세요.

### MiniMax M2.1 (API 키)

**최고:** Anthropic 호환 API가 있는 호스팅 MiniMax.

CLI를 통해 구성합니다:

- `openclaw configure` 실행
- **모델/인증** 선택
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

### MiniMax M2.1 폴백으로 (Opus 기본)

**최고:** Opus 4.6을 기본으로 유지하고 MiniMax M2.1로 폴백합니다.

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

### 선택사항: LM Studio를 통한 로컬 (수동)

**최고:** LM Studio를 사용한 로컬 추론.
강력한 하드웨어 (예: 데스크톱/서버)에서 LM Studio의 로컬 서버를 사용하는 MiniMax M2.1로 강한 결과를 본 것 같습니다.

`openclaw.json`을 통해 수동으로 구성합니다:

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

## `openclaw configure`를 통해 구성

대화형 구성 마법사를 사용하여 JSON을 편집하지 않고 MiniMax를 설정합니다:

1. `openclaw configure` 실행.
2. **모델/인증** 선택.
3. **MiniMax M2.1** 선택.
4. 메시지가 표시되면 기본 모델을 선택합니다.

## 구성 옵션

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` (Anthropic 호환)을 선호합니다. `https://api.minimax.io/v1`은 OpenAI 호환 페이로드에 선택 사항입니다.
- `models.providers.minimax.api`: `anthropic-messages`를 선호합니다. `openai-completions`은 OpenAI 호환 페이로드에 선택 사항입니다.
- `models.providers.minimax.apiKey`: MiniMax API 키 (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` 정의.
- `agents.defaults.models`: 허용 목록에 원하는 모델에 별칭을 지정합니다.
- `models.mode`: 기본 제공과 함께 MiniMax를 추가하려면 `merge` 유지.

## 참고

- 모델 참조는 `minimax/<model>`입니다.
- 코딩 계획 사용량 API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (코딩 계획 키 필요).
- 정확한 비용 추적이 필요한 경우 `models.json`의 가격 값을 업데이트합니다.
- MiniMax 코딩 계획 추천 링크 (10% 할인): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 제공자 규칙은 [/concepts/model-providers](/concepts/model-providers)를 참조하세요.
- `openclaw models list` 및 `openclaw models set minimax/MiniMax-M2.1`을 사용하여 전환합니다.

## 문제 해결

### "알 수 없는 모델: minimax/MiniMax-M2.1"

이는 일반적으로 **MiniMax 제공자가 구성되지 않았음**을 의미합니다 (제공자 항목 없음 및 MiniMax 인증 프로필/환경 키를 찾을 수 없음). **2026.1.12** (작성 당시 미출시)에 이 감지를 위한 수정이 있습니다. 다음을 통해 수정합니다:

- **2026.1.12**로 업그레이드 (또는 `main`에서 소스 실행) 후 게이트웨이 다시 시작.
- `openclaw configure` 실행 및 **MiniMax M2.1** 선택, 또는
- `models.providers.minimax` 블록을 수동으로 추가, 또는
- `MINIMAX_API_KEY` (또는 MiniMax 인증 프로필)을 설정하여 제공자를 주입할 수 있습니다.

모델 id는 **대소문자 구분**입니다:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

그 다음 다시 확인:

```bash
openclaw models list
```
