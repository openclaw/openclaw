---
read_when:
    - OpenClaw에서 MiniMax 모델을 원합니다.
    - MiniMax 설정 지침이 필요합니다.
summary: OpenClaw에서 MiniMax M2.1 사용
title: 미니맥스
x-i18n:
    generated_at: "2026-02-08T16:07:08Z"
    model: gtx
    provider: google-translate
    source_hash: 291cdecbe68e1cb10d87510a1e6ca26f5af07d46309ca7203c62a4acef8a0501
    source_path: providers/minimax.md
    workflow: 15
---

# 미니맥스

MiniMax는 AI 회사입니다. **M2/M2.1** 모델가족. 현재
코딩 중심 릴리스는 **미니맥스 M2.1** (2025년 12월 23일)
실제 세계의 복잡한 작업.

원천: [MiniMax M2.1 릴리스 노트](https://www.minimax.io/news/minimax-m21)

## 모델 개요(M2.1)

MiniMax는 M2.1의 이러한 개선 사항을 강조합니다.

- 더 강하게 **다국어 코딩** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- 더 나은 **웹/앱 개발** 미적 출력 품질(네이티브 모바일 포함)
- 개선됨 **복합 지시** 사무실 스타일의 워크플로 처리, 구축
  인터리브된 사고와 통합된 제약 실행.
- **더 간결한 응답** 토큰 사용량이 적고 반복 루프가 더 빠릅니다.
- 더 강하게 **도구/에이전트 프레임워크** 호환성 및 컨텍스트 관리(Claude Code,
  드로이드/팩토리 AI, 클라인, 킬로코드, 루코드, 블랙박스).
- 더 높은 품질 **대화와 기술적인 글쓰기** 출력.

## MiniMax M2.1 대 MiniMax M2.1 라이트닝

- **속도:** Lightning은 MiniMax 가격 문서에서 "빠른" 변형입니다.
- **비용:** 가격은 입력 비용이 동일하지만 Lightning의 출력 비용이 더 높습니다.
- **코딩 계획 라우팅:** Lightning 백엔드는 MiniMax에서 직접 사용할 수 없습니다.
  코딩 계획. MiniMax는 대부분의 요청을 Lightning으로 자동 라우팅하지만
  트래픽 급증 시 일반 M2.1 백엔드.

## 설정을 선택하세요

### MiniMax OAuth(코딩 계획) — 권장

**가장 적합한 대상:** OAuth를 통한 MiniMax 코딩 계획으로 빠른 설정이 가능하며 API 키가 필요하지 않습니다.

번들 OAuth 플러그인을 활성화하고 인증합니다.

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

엔드포인트를 선택하라는 메시지가 표시됩니다.

- **글로벌** - 해외 사용자(`api.minimax.io`)
- **중국** - 중국 사용자(`api.minimaxi.com`)

보다 [MiniMax OAuth 플러그인 읽어보기](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) 자세한 내용은.

### MiniMax M2.1(API 키)

**가장 적합한 대상:** Anthropic 호환 API를 사용하여 MiniMax를 호스팅했습니다.

CLI를 통해 구성:

- 달리다 `openclaw configure`
- 선택하다 **모델/인증**
- 선택하다 **미니맥스 M2.1**

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

**가장 적합한 대상:** Opus 4.6을 기본으로 유지하고 MiniMax M2.1로 장애 조치합니다.

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

### 선택 사항: LM Studio를 통한 로컬(수동)

**가장 적합한 대상:** LM Studio를 사용한 로컬 추론.
우리는 강력한 하드웨어(예:
데스크탑/서버) LM Studio의 로컬 서버를 사용합니다.

다음을 통해 수동으로 구성하세요. `openclaw.json`:

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

## 다음을 통해 구성 `openclaw configure`

대화형 구성 마법사를 사용하여 JSON을 편집하지 않고 MiniMax를 설정하세요.

1. 달리다 `openclaw configure`.
2. 선택하다 **모델/인증**.
3. 선택하다 **미니맥스 M2.1**.
4. 메시지가 나타나면 기본 모델을 선택하세요.

## 구성 옵션

- `models.providers.minimax.baseUrl`: 선호하다 `https://api.minimax.io/anthropic` (인류 친화적); `https://api.minimax.io/v1` OpenAI 호환 페이로드의 경우 선택 사항입니다.
- `models.providers.minimax.api`: 선호하다 `anthropic-messages`; `openai-completions` OpenAI 호환 페이로드의 경우 선택 사항입니다.
- `models.providers.minimax.apiKey`: MiniMax API 키(`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: 정의하다 `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: 허용 목록에 추가하려는 별칭 모델입니다.
- `models.mode`: 유지하다 `merge` 내장 기능과 함께 MiniMax를 추가하려는 경우.

## 메모

- 모델 참조는 다음과 같습니다. `minimax/<model>`.
- 코딩 계획 사용 API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (코딩 계획 키가 필요합니다).
- 가격 값 업데이트 `models.json` 정확한 비용 추적이 필요한 경우.
- MiniMax 코딩 플랜 추천 링크(10% 할인): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- 보다 [/개념/모델 제공자](/concepts/model-providers) 공급자 규칙의 경우.
- 사용 `openclaw models list` 그리고 `openclaw models set minimax/MiniMax-M2.1` 전환하다.

## 문제 해결

### “알 수 없는 모델: minimax/MiniMax-M2.1”

이는 일반적으로 다음을 의미합니다. **MiniMax 공급자가 구성되지 않았습니다.** (공급자 항목 없음
MiniMax 인증 프로필/환경 키가 없습니다). 이 감지에 대한 수정 사항은 다음과 같습니다.
**2026.1.12** (작성 당시에는 공개되지 않았습니다). 수정 방법:

- 업그레이드 중 **2026.1.12** (또는 소스에서 실행 `main`), 게이트웨이를 다시 시작합니다.
- 달리기 `openclaw configure` 그리고 선택 **미니맥스 M2.1**, 또는
- 추가 `models.providers.minimax` 수동으로 차단하거나
- 환경 `MINIMAX_API_KEY` (또는 MiniMax 인증 프로필) 공급자를 주입할 수 있습니다.

모델 ID가 다음과 같은지 확인하세요. **대소문자 구분**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

그런 다음 다음을 다시 확인하십시오.

```bash
openclaw models list
```
