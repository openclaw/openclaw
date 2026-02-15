---
summary: "Use MiniMax M2.1 in OpenClaw"
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: "MiniMax"
x-i18n:
  source_hash: 291cdecbe68e1cb10d87510a1e6ca26f5af07d46309ca7203c62a4acef8a0501
---

# 미니맥스

MiniMax는 **M2/M2.1** 모델 제품군을 구축하는 AI 회사입니다. 현재
코딩 중심 릴리스는 **MiniMax M2.1**(2025년 12월 23일)입니다.
실제 세계의 복잡한 작업.

출처: [MiniMax M2.1 출시 노트](https://www.minimax.io/news/minimax-m21)

## 모델 개요(M2.1)

MiniMax는 M2.1의 이러한 개선 사항을 강조합니다.

- 더욱 강력해진 **다중 언어 코딩**(Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- 더 나은 **웹/앱 개발** 및 미적인 출력 품질(네이티브 모바일 포함).
- 사무실 스타일 워크플로를 위한 개선된 **복합 지침** 처리
  인터리브된 사고와 통합된 제약 실행.
- 더 낮은 토큰 사용량과 더 빠른 반복 루프로 **보다 간결한 응답**.
- 더 강력한 **도구/에이전트 프레임워크** 호환성 및 컨텍스트 관리(Claude Code,
  드로이드/팩토리 AI, 클라인, 킬로코드, 루코드, 블랙박스).
- 더 높은 품질의 **대화 및 기술 문서** 출력.

## MiniMax M2.1 대 MiniMax M2.1 라이트닝

- **속도:** Lightning은 MiniMax 가격 문서에서 "빠른" 변형입니다.
- **비용:** 가격은 입력 비용과 동일하지만 Lightning의 출력 비용이 더 높습니다.
- **코딩 계획 라우팅:** Lightning 백엔드는 MiniMax에서 직접 사용할 수 없습니다.
  코딩 계획. MiniMax는 대부분의 요청을 Lightning으로 자동 라우팅하지만
  트래픽 급증 시 일반 M2.1 백엔드.

## 설정을 선택하세요

### MiniMax OAuth(코딩 계획) — 권장

**최적의 용도:** OAuth를 통한 MiniMax 코딩 계획으로 빠른 설정, API 키 필요 없음.

번들 OAuth 플러그인을 활성화하고 인증합니다.

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

엔드포인트를 선택하라는 메시지가 표시됩니다.

- **글로벌** - 해외 사용자(`api.minimax.io`)
- **CN** - 중국 사용자(`api.minimaxi.com`)

자세한 내용은 [MiniMax OAuth 플러그인 README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth)를 참조하세요.

### MiniMax M2.1(API 키)

**최적의 용도:** Anthropic 호환 API를 사용하여 MiniMax를 호스팅했습니다.

CLI를 통해 구성:

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

### 대체용 MiniMax M2.1(Opus 기본)

**최적의 용도:** Opus 4.6을 기본으로 유지하고 MiniMax M2.1로 장애 조치합니다.

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

### 선택사항: LM Studio를 통한 로컬(수동)

**최적의 용도:** LM Studio를 사용한 로컬 추론.
우리는 강력한 하드웨어(예:
데스크탑/서버) LM Studio의 로컬 서버를 사용합니다.

`openclaw.json`를 통해 수동으로 구성하십시오.

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

대화형 구성 마법사를 사용하여 JSON을 편집하지 않고 MiniMax를 설정하세요.

1. `openclaw configure`를 실행합니다.
2. **모델/인증**을 선택합니다.
3. **MiniMax M2.1**을 선택합니다.
4. 메시지가 나타나면 기본 모델을 선택합니다.

## 구성 옵션

- `models.providers.minimax.baseUrl`: `https://api.minimax.io/anthropic` 선호(인류 호환); `https://api.minimax.io/v1`는 OpenAI 호환 페이로드의 경우 선택 사항입니다.
- `models.providers.minimax.api`: `anthropic-messages`를 선호합니다. `openai-completions`는 OpenAI 호환 페이로드의 경우 선택 사항입니다.
- `models.providers.minimax.apiKey`: MiniMax API 키(`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`를 정의합니다.
- `agents.defaults.models`: 허용 목록에 포함하려는 별칭 모델입니다.
- `models.mode`: 내장 기능과 함께 MiniMax를 추가하려면 `merge`를 유지하세요.

## 메모

- 모델 참조는 `minimax/<model>`입니다.
- 코딩 계획 사용 API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (코딩 계획 키 필요).
- 정확한 비용 추적이 필요한 경우 `models.json`의 가격 값을 업데이트하세요.
- MiniMax 코딩 플랜 추천 링크(10% 할인): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 공급자 규칙은 [/concepts/model-providers](/concepts/model-providers)를 참조하세요.
- `openclaw models list`와 `openclaw models set minimax/MiniMax-M2.1`를 사용하여 전환합니다.

## 문제 해결

### “알 수 없는 모델: minimax/MiniMax-M2.1”

이는 일반적으로 **MiniMax 공급자가 구성되지 않음**(공급자 항목 없음)을 의미합니다.
MiniMax 인증 프로필/환경 키가 없습니다). 이 감지에 대한 수정 사항은 다음과 같습니다.
**2026.1.12** (작성 당시 미공개). 수정 방법:

- **2026.1.12**로 업그레이드(또는 소스 `main`에서 실행) 후 게이트웨이를 다시 시작합니다.
- `openclaw configure`를 실행하고 **MiniMax M2.1**을 선택하거나
- `models.providers.minimax` 블록을 수동으로 추가하거나
- 공급자가 주입될 수 있도록 `MINIMAX_API_KEY`(또는 MiniMax 인증 프로필)을 설정합니다.

모델 ID가 **대소문자를 구분**하는지 확인하세요.

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

그런 다음 다음을 다시 확인하십시오.

```bash
openclaw models list
```
