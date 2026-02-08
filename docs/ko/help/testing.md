---
read_when:
    - 로컬 또는 CI에서 테스트 실행
    - 모델/공급자 버그에 대한 회귀 추가
    - 게이트웨이 + 에이전트 동작 디버깅
summary: '테스트 키트: 유닛/e2e/live 제품군, Docker 실행기 및 각 테스트에서 다루는 내용'
title: 테스트
x-i18n:
    generated_at: "2026-02-08T15:59:10Z"
    model: gtx
    provider: google-translate
    source_hash: 9bb77454e18e1d0bc3e8ab40c3ebe521141e14e6aa0f11be3dc5f37d9637fd24
    source_path: help/testing.md
    workflow: 15
---

# 테스트

OpenClaw에는 세 가지 Vitest 제품군(유닛/통합, e2e, 라이브)과 작은 Docker 실행기 세트가 있습니다.

이 문서는 "테스트 방법" 가이드입니다.

- 각 제품군이 다루는 내용(및 의도적으로 수행하는 작업) _~ 아니다_ 씌우다)
- 일반적인 워크플로(로컬, 사전 푸시, 디버깅)에 대해 실행할 명령
- 라이브 테스트에서 자격 증명을 검색하고 모델/공급자를 선택하는 방법
- 실제 모델/공급자 문제에 대한 회귀를 추가하는 방법

## 빠른 시작

대부분의 날:

- 풀 게이트(푸시 전 예상): `pnpm build && pnpm check && pnpm test`

터치 테스트를 하거나 추가적인 자신감을 원할 때:

- 적용 게이트: `pnpm test:coverage`
- E2E 제품군: `pnpm test:e2e`

실제 공급자/모델을 디버깅하는 경우(실제 자격 증명 필요):

- 라이브 제품군(모델 + 게이트웨이 도구/이미지 프로브): `pnpm test:live`

팁: 실패한 사례가 하나만 필요한 경우 아래 설명된 허용 목록 환경 변수를 통해 실시간 테스트 범위를 좁히는 것이 좋습니다.

## 테스트 스위트(무엇이 어디서 실행되는지)

제품군을 "현실감 증가"(그리고 허술함/비용 증가)로 생각하십시오.

### 단위/통합(기본값)

- 명령: `pnpm test`
- 구성: `vitest.config.ts`
- 파일: `src/**/*.test.ts`
- 범위:
  - 순수 단위 테스트
  - 프로세스 내 통합 테스트(게이트웨이 인증, 라우팅, 툴링, 구문 분석, 구성)
  - 알려진 버그에 대한 결정적 회귀
- 기대사항:
  - CI에서 실행
  - 실제 키가 필요하지 않습니다.
  - 빠르고 안정적이어야 합니다.

### E2E(게이트웨이 스모크)

- 명령: `pnpm test:e2e`
- 구성: `vitest.e2e.config.ts`
- 파일: `src/**/*.e2e.test.ts`
- 범위:
  - 다중 인스턴스 게이트웨이 엔드투엔드 동작
  - WebSocket/HTTP 표면, 노드 페어링 및 더 무거운 네트워킹
- 기대사항:
  - CI에서 실행(파이프라인에서 활성화된 경우)
  - 실제 키가 필요하지 않습니다.
  - 단위 테스트보다 움직이는 부분이 많음(느릴 수 있음)

### 라이브(실제 제공자 + 실제 모델)

- 명령: `pnpm test:live`
- 구성: `vitest.live.config.ts`
- 파일: `src/**/*.live.test.ts`
- 기본: **활성화됨** ~에 의해 `pnpm test:live` (세트 `OPENCLAW_LIVE_TEST=1`)
- 범위:
  - “이 공급자/모델이 실제로 작동합니까? _오늘_ 진짜 신용으로?”
  - 공급자 형식 변경, 도구 호출 문제, 인증 문제 및 속도 제한 동작을 포착하세요.
- 기대사항:
  - 설계상 CI가 안정적이지 않음(실제 네트워크, 실제 공급자 정책, 할당량, 중단)
  - 비용이 발생함/비율 제한 사용
  - "모든 것" 대신 좁은 하위 집합 실행을 선호합니다.
  - 실시간 실행이 소스로 제공됩니다. `~/.profile` 누락된 API 키를 찾으려면
  - 인류학적 키 회전: 설정 `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (또는 `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) 또는 여러 `ANTHROPIC_API_KEY*` 변종; 테스트는 속도 제한에 따라 다시 시도됩니다.

## 어떤 제품군을 실행해야 합니까?

다음 결정 테이블을 사용하세요.

- 논리/테스트 편집: 실행 `pnpm test` (그리고 `pnpm test:coverage` 많이 변했다면)
- 터치 게이트웨이 네트워킹/WS 프로토콜/페어링: 추가 `pnpm test:e2e`
- "내 봇이 다운되었습니다" 디버깅 / 공급자별 오류 / 도구 호출: 좁은 범위의 실행 `pnpm test:live`

## 라이브: 모델 연기(프로필 키)

라이브 테스트는 오류를 격리할 수 있도록 두 개의 계층으로 분할됩니다.

- "직접 모델"은 제공자/모델이 주어진 키로 응답할 수 있음을 나타냅니다.
- "게이트웨이 스모크"는 전체 게이트웨이+에이전트 파이프라인이 해당 모델(세션, 기록, 도구, 샌드박스 정책 등)에 대해 작동함을 알려줍니다.

### 레이어 1: 직접 모델 완성(게이트웨이 없음)

- 시험: `src/agents/models.profiles.live.test.ts`
- 목표:
  - 발견된 모델 열거
  - 사용 `getApiKeyForModel` 신뢰도가 있는 모델을 선택하려면
  - 모델당 작은 완성 실행(필요한 경우 목표 회귀)
- 활성화 방법:
  - `pnpm test:live` (또는 `OPENCLAW_LIVE_TEST=1` Vitest를 직접 호출하는 경우)
- 세트 `OPENCLAW_LIVE_MODELS=modern` (또는 `all`, modern의 별칭)을 사용하여 이 제품군을 실제로 실행합니다. 그렇지 않으면 유지하기 위해 건너뜁니다. `pnpm test:live` 게이트웨이 연기에 집중
- 모델 선택 방법:
  - `OPENCLAW_LIVE_MODELS=modern` 최신 허용 목록(Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)을 실행합니다.
  - `OPENCLAW_LIVE_MODELS=all` 최신 허용 목록의 별칭입니다.
  - 또는 `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (쉼표 허용 목록)
- 제공자를 선택하는 방법:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (쉼표 허용 목록)
- 키의 출처:
  - 기본적으로: 프로필 저장소 및 환경 폴백
  - 세트 `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 시행하다 **프로필 매장** 오직
- 이것이 존재하는 이유:
  - "공급자 API가 손상되었습니다/키가 잘못되었습니다"와 "게이트웨이 에이전트 파이프라인이 손상되었습니다"를 구분합니다.
  - 작고 분리된 회귀를 포함합니다(예: OpenAI 응답/Codex 응답 추론 재생 + 도구 호출 흐름)

### 레이어 2: 게이트웨이 + 개발자 에이전트 연기("@openclaw"가 실제로 수행하는 작업)

- 시험: `src/gateway/gateway-models.profiles.live.test.ts`
- 목표:
  - 진행 중인 게이트웨이 가동
  - 생성/패치 `agent:dev:*` 세션(실행당 모델 재정의)
  - 키가 있는 모델을 반복하고 다음을 주장합니다.
    - "의미 있는" 응답(도구 없음)
    - 실제 도구 호출이 작동합니다(읽기 프로브).
    - 옵션인 추가 도구 프로브(exec+read 프로브)
    - OpenAI 회귀 경로(도구 호출 전용 → 후속 조치)가 계속 작동함
- 프로브 세부 정보(실패를 빠르게 설명할 수 있도록):
  - `read` 프로브: 테스트는 작업 공간에 nonce 파일을 작성하고 에이전트에게 다음을 요청합니다. `read` 그것을 입력하고 nonce를 다시 에코합니다.
  - `exec+read` 프로브: 테스트는 에이전트에게 다음을 요청합니다. `exec`-임시 파일에 nonce를 쓴 다음 `read` 다시.
  - 이미지 프로브: 테스트에서는 생성된 PNG(cat + 무작위 코드)를 첨부하고 모델이 반환할 것으로 예상합니다. `cat <CODE>`.
  - 구현 참조: `src/gateway/gateway-models.profiles.live.test.ts` 그리고 `src/gateway/live-image-probe.ts`.
- 활성화 방법:
  - `pnpm test:live` (또는 `OPENCLAW_LIVE_TEST=1` Vitest를 직접 호출하는 경우)
- 모델 선택 방법:
  - 기본값: 최신 허용 목록(Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` 최신 허용 목록의 별칭입니다.
  - 또는 설정 `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (또는 쉼표 목록)을 사용하여 범위를 좁힙니다.
- 공급자 선택 방법(“OpenRouter everything” 피하기):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (쉼표 허용 목록)
- 이 라이브 테스트에서는 도구 + 이미지 프로브가 항상 켜져 있습니다.
  - `read` 프로브 + `exec+read` 프로브(공구 응력)
  - 모델이 이미지 입력 ​​지원을 광고할 때 이미지 프로브가 실행됩니다.
  - 흐름(높은 수준):
    - 테스트는 "CAT" + 임의 코드(`src/gateway/live-image-probe.ts`)
    - 다음을 통해 보냅니다. `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - 게이트웨이는 첨부 파일을 다음으로 구문 분석합니다. `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - 내장된 에이전트는 다중 모드 사용자 메시지를 모델에 전달합니다.
    - 주장: 답글에 다음이 포함되어 있습니다. `cat` + 코드(OCR 허용치: 사소한 실수 허용)

팁: 컴퓨터에서 무엇을 테스트할 수 있는지(그리고 정확한 `provider/model` ID), 실행:

```bash
openclaw models list
openclaw models list --json
```

## 라이브: 인류학적 설정 토큰 연기

- 시험: `src/agents/anthropic.setup-token.live.test.ts`
- 목표: Claude Code CLI 설정 토큰(또는 붙여넣은 설정 토큰 프로필)이 Anthropic 프롬프트를 완료할 수 있는지 확인합니다.
- 할 수 있게 하다:
  - `pnpm test:live` (또는 `OPENCLAW_LIVE_TEST=1` Vitest를 직접 호출하는 경우)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- 토큰 소스(하나 선택):
  - 윤곽: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 원시 토큰: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- 모델 재정의(선택 사항):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

설정 예:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## 라이브: CLI 백엔드 스모크(Claude Code CLI 또는 기타 로컬 CLI)

- 시험: `src/gateway/gateway-cli-backend.live.test.ts`
- 목표: 기본 구성을 건드리지 않고 로컬 CLI 백엔드를 사용하여 게이트웨이 + 에이전트 파이프라인을 검증합니다.
- 할 수 있게 하다:
  - `pnpm test:live` (또는 `OPENCLAW_LIVE_TEST=1` Vitest를 직접 호출하는 경우)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- 기본값:
  - 모델: `claude-cli/claude-sonnet-4-5`
  - 명령: `claude`
  - 인수: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- 재정의(선택 사항):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` 실제 이미지 첨부 파일을 보냅니다(경로가 프롬프트에 삽입됩니다).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` 프롬프트 삽입 대신 이미지 파일 경로를 CLI 인수로 전달합니다.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (또는 `"list"`) 다음과 같은 경우 이미지 인수가 전달되는 방식을 제어합니다. `IMAGE_ARG` 설정됩니다.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` 두 번째 차례를 보내고 재개 흐름을 확인합니다.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` Claude Code CLI MCP 구성을 활성화된 상태로 유지합니다(기본값은 임시 빈 파일로 MCP 구성을 비활성화합니다).

예:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 추천 라이브 레시피

좁고 명시적인 허용 목록은 가장 빠르고 불안정성이 적습니다.

- 단일 모델, 직접(게이트웨이 없음):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 단일 모델, 게이트웨이 연기:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 여러 공급자를 통한 도구 호출:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google 초점(Gemini API 키 + 반중력):
  - 쌍둥이자리(API 키): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - 반중력(OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

참고:

- `google/...` Gemini API(API 키)를 사용합니다.
- `google-antigravity/...` Antigravity OAuth 브리지(Cloud Code Assist 스타일 에이전트 엔드포인트)를 사용합니다.
- `google-gemini-cli/...` 귀하의 컴퓨터에서 로컬 Gemini CLI를 사용합니다(별도의 인증 + 도구 문제).
- Gemini API와 Gemini CLI:
  - API: OpenClaw는 HTTP(API 키/프로필 인증)를 통해 Google에서 호스팅하는 Gemini API를 호출합니다. 이것이 대부분의 사용자가 "Gemini"를 의미하는 것입니다.
  - CLI: OpenClaw는 로컬로 쉘을 실행합니다. `gemini` 바이너리; 자체 인증이 있으며 다르게 동작할 수 있습니다(스트리밍/도구 지원/버전 차이).

## 라이브: 모델 매트릭스(우리가 다루는 내용)

고정된 "CI 모델 목록"(라이브는 선택 사항)은 없지만 다음은 **추천** 키가 있는 개발 시스템에서 정기적으로 다루는 모델입니다.

### 모던스모크세트(공구콜링+이미지)

이것은 우리가 계속 작동할 것으로 예상되는 "공통 모델" 실행입니다.

- OpenAI(비Codex): `openai/gpt-5.2` (선택 과목: `openai/gpt-5.1`)
- OpenAI 코덱스: `openai-codex/gpt-5.3-codex` (선택 과목: `openai-codex/gpt-5.3-codex-codex`)
- 인류: `anthropic/claude-opus-4-6` (또는 `anthropic/claude-sonnet-4-5`)
- 구글(제미니 API): `google/gemini-3-pro-preview` 그리고 `google/gemini-3-flash-preview` (이전 Gemini 2.x 모델은 피하세요)
- 구글(반중력): `google-antigravity/claude-opus-4-6-thinking` 그리고 `google-antigravity/gemini-3-flash`
- Z.AI(GLM): `zai/glm-4.7`
- 미니맥스: `minimax/minimax-m2.1`

도구 + 이미지를 사용하여 게이트웨이 연기를 실행합니다.
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### 기준: 도구 호출(읽기 + 선택적 Exec)

제공자 제품군당 하나 이상을 선택하십시오.

- 오픈AI: `openai/gpt-5.2` (또는 `openai/gpt-5-mini`)
- 인류: `anthropic/claude-opus-4-6` (또는 `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (또는 `google/gemini-3-pro-preview`)
- Z.AI(GLM): `zai/glm-4.7`
- 미니맥스: `minimax/minimax-m2.1`

선택적 추가 보장(있으면 좋음):

- xAI: `xai/grok-4` (또는 사용 가능한 최신)
- 미스트랄: `mistral/`… (활성화한 "도구" 지원 모델 하나 선택)
- 대뇌: `cerebras/`… (액세스 권한이 있는 경우)
- LM 스튜디오: `lmstudio/`… (로컬, 도구 호출은 API 모드에 따라 다름)

### 비전 : 이미지 전송(첨부 → 다중 메시지)

이미지가 가능한 모델을 하나 이상 포함하세요. `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI 비전 지원 변형 등)을 사용하여 이미지 프로브를 실행합니다.

### 애그리게이터/대체 게이트웨이

키를 활성화한 경우 다음을 통한 테스트도 지원됩니다.

- 오픈라우터: `openrouter/...` (수백 가지 모델; 사용 `openclaw models scan` 도구+이미지 지원 후보자 찾기)
- 오픈코드 젠: `opencode/...` (인증을 통해 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

라이브 매트릭스에 더 많은 공급자를 포함할 수 있습니다(creds/config가 있는 경우).

- 내장: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- 을 통해 `models.providers` (커스텀 엔드포인트): `minimax` (클라우드/API) 및 모든 OpenAI/Anthropic 호환 프록시(LM Studio, vLLM, LiteLLM 등)

팁: 문서에 "모든 모델"을 하드코딩하려고 하지 마세요. 권위있는 목록은 무엇이든 `discoverModels(...)` + 사용 가능한 모든 키를 컴퓨터로 반환합니다.

## 자격 증명(커밋하지 않음)

라이브 테스트에서는 CLI와 동일한 방식으로 자격 증명을 검색합니다. 실제적인 의미:

- CLI가 작동하면 라이브 테스트에서 동일한 키를 찾아야 합니다.
- 라이브 테스트에서 "신뢰할 수 없음"이라고 표시되면 디버깅할 때와 동일한 방식으로 디버깅하세요. `openclaw models list` / 모델 선택.

- 프로필 매장: `~/.openclaw/credentials/` (선호됨; 테스트에서 "프로필 키"가 의미하는 것)
- 구성: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)

env 키를 사용하려는 경우(예: `~/.profile`), 이후에 로컬 테스트를 실행합니다. `source ~/.profile`, 또는 아래 Docker 실행기를 사용하세요(마운트 가능) `~/.profile` 용기에 넣습니다).

## 딥그램 라이브(오디오 전사)

- 시험: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- 할 수 있게 하다:`DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker 실행기(선택적 "Linux에서 작동" 확인)

이들은 실행 `pnpm test:live` repo Docker 이미지 내에서 로컬 구성 디렉토리와 작업공간을 마운트하고(및 소싱) `~/.profile` 마운트된 경우):

- 직접 모델: `pnpm test:docker:live-models` (스크립트: `scripts/test-live-models-docker.sh`)
- 게이트웨이 + 개발 에이전트: `pnpm test:docker:live-gateway` (스크립트: `scripts/test-live-gateway-models-docker.sh`)
- 온보딩 마법사(TTY, 전체 스캐폴딩): `pnpm test:docker:onboard` (스크립트: `scripts/e2e/onboard-docker.sh`)
- 게이트웨이 네트워킹(컨테이너 2개, WS 인증 + 상태): `pnpm test:docker:gateway-network` (스크립트: `scripts/e2e/gateway-network-docker.sh`)
- 플러그인(사용자 정의 확장 로드 + 레지스트리 스모크): `pnpm test:docker:plugins` (스크립트: `scripts/e2e/plugins-docker.sh`)

유용한 환경 변수:

- `OPENCLAW_CONFIG_DIR=...` (기본: `~/.openclaw`)에 마운트됨 `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (기본: `~/.openclaw/workspace`)에 마운트됨 `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (기본: `~/.profile`)에 마운트됨 `/home/node/.profile` 테스트를 실행하기 전에 소싱됨
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` 실행 범위를 좁히기 위해
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 자격 증명이 프로필 저장소(env 아님)에서 나오는지 확인하기 위해

## 문서 건전성

문서 편집 후 문서 확인을 실행합니다. `pnpm docs:list`.

## 오프라인 회귀(CI 안전)

실제 공급자가 없는 "실제 파이프라인" 회귀는 다음과 같습니다.

- 게이트웨이 도구 호출(모의 OpenAI, 실제 게이트웨이 + 에이전트 루프): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- 게이트웨이 마법사(WS `wizard.start` / `wizard.next`, 구성 + 인증 적용 쓰기): `src/gateway/gateway.wizard.e2e.test.ts`

## 상담원 신뢰성 평가(기술)

우리는 이미 "에이전트 신뢰성 평가"처럼 작동하는 몇 가지 CI 안전 테스트를 보유하고 있습니다.

- 실제 게이트웨이 + 에이전트 루프를 통한 모의 도구 호출(`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- 세션 연결 및 구성 효과를 검증하는 엔드투엔드 마법사 흐름(`src/gateway/gateway.wizard.e2e.test.ts`).

아직 부족한 스킬(참조 [기술](/tools/skills)):

- **결정:** 프롬프트에 기술이 나열되면 상담원이 올바른 기술을 선택합니까(또는 관련 없는 기술을 피합니까)?
- **규정 준수:** 상담원이 읽어요? `SKILL.md` 사용하기 전에 필요한 단계/인수를 따르시겠습니까?
- **워크플로 계약:** 도구 순서, 세션 기록 이월 및 샌드박스 경계를 ​​주장하는 다중 턴 시나리오입니다.

향후 평가는 먼저 결정론적이어야 합니다.

- 도구 호출 + 순서, 기술 파일 읽기 및 세션 연결을 주장하기 위해 모의 공급자를 사용하는 시나리오 실행기입니다.
- 기술 중심 시나리오의 소규모 모음(사용 대 회피, 게이팅, 즉각적인 주입).
- CI 안전 제품군이 설치된 후에만 선택적 실시간 평가(선택, 환경 설정)가 수행됩니다.

## 회귀 추가(지침)

실시간으로 발견된 공급자/모델 문제를 해결하는 경우:

- 가능한 경우 CI 안전 회귀를 추가합니다(모의/스텁 공급자 또는 정확한 요청 형태 변환 캡처).
- 본질적으로 라이브 전용인 경우(비율 제한, 인증 정책) 라이브 테스트 범위를 좁히고 환경 변수를 통해 옵트인하세요.
- 버그를 잡는 가장 작은 레이어를 타겟팅하는 것이 좋습니다.
  - 공급자 요청 변환/재생 버그 → 직접 모델 테스트
  - 게이트웨이 세션/기록/도구 파이프라인 버그 → 게이트웨이 라이브 연기 또는 CI 안전 게이트웨이 모의 테스트
