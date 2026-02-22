---
summary: "테스트 키트: 단위/E2E/라이브 스위트, Docker 런너 및 각 테스트가 다루는 내용"
read_when:
  - 로컬 또는 CI에서 테스트 실행
  - 모델/프로바이더 버그에 대한 회귀 추가
  - 게이트웨이 + 에이전트 동작 디버깅
title: "테스트"
---

# 테스트

OpenClaw에는 세 가지 Vitest 스위트(단위/통합, E2E, 라이브)와 소규모 Docker 런너 세트가 있습니다.

이 문서는 "우리가 테스트하는 방법"에 대한 가이드입니다:

- 각 스위트가 다루는 내용 (그리고 의도적으로 다루지 않는 내용)
- 일반적인 워크플로 위한 실행 명령어(로컬, 사전 푸시, 디버깅)
- 라이브 테스트가 자격 증명을 검색하고 모델/프로바이더를 선택하는 방법
- 실제 모델/프로바이더 문제에 대한 회귀 추가 방법

## 빠른 시작

일반적인 경우:

- 전체 게이트 (푸시 전 예상): `pnpm build && pnpm check && pnpm test`

테스트를 건드리거나 추가적인 확신이 필요할 때:

- 커버리지 게이트: `pnpm test:coverage`
- E2E 스위트: `pnpm test:e2e`

실제 프로바이더/모델을 디버깅할 때(실제 자격 필요):

- 라이브 스위트(모델 + 게이트웨이 도구/이미지 프로브): `pnpm test:live`

팁: 실패 케이스가 하나만 필요할 때는 아래 설명된 허용 목록 환경 변수를 통해 라이브 테스트를 좁히는 것을 선호하세요.

## 테스트 스위트 (어디서 무엇이 실행되는지)

스위트를 "현실에 가까워지는" (그리고 점점 더 불안정해지고 비용이 증가하는) 단계로 생각하세요:

### 유닛 / 통합 (기본)

- 명령어: `pnpm test`
- 구성: `scripts/test-parallel.mjs` (실행: `vitest.unit.config.ts`, `vitest.extensions.config.ts`, `vitest.gateway.config.ts`)
- 파일: `src/**/*.test.ts`, `extensions/**/*.test.ts`
- 범위:
  - 순수 단위 테스트
  - 인-프로세스 통합 테스트 (게이트웨이 인증, 라우팅, 도구, 파싱, 설정)
  - 알려진 버그에 대한 결정론적 회귀
- 기대 사항:
  - CI에서 실행됨
  - 실제 키가 필요하지 않음
  - 빠르고 안정적이어야 함
- 풀 노트:
  - OpenClaw는 Node 22/23에서 더 빠른 유닛 샤드를 위해 Vitest `vmForks`를 사용합니다.
  - Node 24 이상에서는 노드 VM 연결 오류(`ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`)를 피하기 위해 자동으로 일반 `forks`로 돌아갑니다.
  - 수동으로 `OPENCLAW_TEST_VM_FORKS=0` (강제로 `forks`) 또는 `OPENCLAW_TEST_VM_FORKS=1` (강제로 `vmForks`)로 덮어쓸 수 있습니다.

### E2E (게이트웨이 스모크)

- 명령어: `pnpm test:e2e`
- 구성: `vitest.e2e.config.ts`
- 파일: `src/**/*.e2e.test.ts`
- 런타임 기본값:
  - 빠른 파일 시작을 위해 Vitest `vmForks`를 사용합니다.
  - 적응형 워커를 사용합니다 (CI: 2-4, 로컬: 4-8).
  - 콘솔 I/O 오버헤드를 줄이기 위해 기본적으로 무음 모드로 실행됩니다.
- 유용한 덮어쓰기:
  - `OPENCLAW_E2E_WORKERS=<n>`를 설정하여 워커 수를 강제할 수 있습니다 (최대 16으로 제한).
  - `OPENCLAW_E2E_VERBOSE=1`로 상세 콘솔 출력을 다시 활성화할 수 있습니다.
- 범위:
  - 다중 인스턴스 게이트웨이 엔드 투 엔드 동작
  - WebSocket/HTTP 표면, 노드 페어링 및 더 무거운 네트워킹
- 기대 사항:
  - CI에서 실행 (파이프라인에서 활성화된 경우)
  - 실제 키가 필요하지 않음
  - 단위 테스트보다 이동 부품이 많음 (더 느릴 수 있음)

### 라이브 (실제 프로바이더 + 실제 모델)

- 명령어: `pnpm test:live`
- 구성: `vitest.live.config.ts`
- 파일: `src/**/*.live.test.ts`
- 기본값: **활성화됨** `pnpm test:live`에 의해 (`OPENCLAW_LIVE_TEST=1`로 설정)
- 범위:
  - "오늘날 실제 자격 증명으로 이 프로바이더/모델이 실제로 작동합니까?"
  - 프로바이더 형식 변경, 도구 호출 특이점, 인증 문제 및 속도 제한 동작 탐지
- 기대 사항:
  - 설계상 CI 안정적이지 않음 (실제 네트워크, 실제 프로바이더 정책, 할당량, 중단)
  - 비용이 발생함 / 속도 제한 사용
  - "모두" 대신 좁혀진 하위 집합 실행을 선호
  - 라이브 실행은 누락된 API 키를 가져오기 위해 `~/.profile`을 소스합니다
- API 키 회전 (프로바이더별): `*_API_KEYS`를 쉼표/세미콜론 형식으로 설정하거나 `*_API_KEY_1`, `*_API_KEY_2` (예: `OPENAI_API_KEYS`, `ANTHROPIC_API_KEYS`, `GEMINI_API_KEYS`) 또는 `OPENCLAW_LIVE_*_KEY`를 통한 라이브별 재정의; 테스트는 속도 제한 응답에서 재시도합니다

## 어떤 스위트를 실행해야 하나요?

이 결정을 위한 표를 사용하세요:

- 논리/테스트 편집: `pnpm test` 실행 (많이 변경한 경우 `pnpm test:coverage`도 실행)
- 게이트웨이 네트워킹 / WS 프로토콜 / 페어링 수정: `pnpm test:e2e` 추가
- "내 봇이 다운되었습니다" / 프로바이더 특정 실패 / 도구 호출 디버깅: 좁혀진 `pnpm test:live`를 실행

## 라이브: 모델 스모크 (프로파일 키)

라이브 테스트는 실패를 격리할 수 있도록 두 개의 레이어로 나뉩니다:

- "직접 모델"은 주어진 키로 프로바이더/모델이 응답할 수 있는지 알려줍니다.
- "게이트웨이 스모크"는 해당 모델에 대한 전체 게이트웨이+에이전트 파이프라인이 작동하는지 알려줍니다 (세션, 기록, 도구, 샌드박스 정책 등).

### 레이어 1: 직접 모델 완료 (게이트웨이 없음)

- 테스트: `src/agents/models.profiles.live.test.ts`
- 목표:
  - 발견된 모델 나열
  - `getApiKeyForModel`을 사용하여 자격 증명을 가진 모델 선택
  - 모델당 작은 완료 실행 (필요한 경우 타겟팅된 회귀)
- 활성화 방법:
  - `pnpm test:live` (또는 Vitest를 직접 호출할 경우 `OPENCLAW_LIVE_TEST=1`)
- 실제로 이 스위트를 실행하려면 `OPENCLAW_LIVE_MODELS=modern` (또는 `all`, modern의 별칭) 설정; 그렇지 않으면 게이트웨이 스모크에 집중하도록 건너뜀
- 모델 선택 방법:
  - `OPENCLAW_LIVE_MODELS=modern`을 설정해 modern 허용 목록(Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)을 실행
  - `OPENCLAW_LIVE_MODELS=all`은 modern 허용 목록의 별칭입니다
  - 또는 `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (쉼표 허용 목록)
- 프로바이더 선택 방법:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (쉼표 허용 목록)
- 키가 오는 곳:
  - 기본: 프로파일 저장소와 환경 변수 대체
  - `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 설정으로 **프로파일 저장소**만 사용하도록 강제
- 이것이 존재하는 이유:
  - "프로바이더 API가 깨졌다 / 키가 유효하지 않음"과 "게이트웨이 에이전트 파이프라인이 깨졌다"를 분리
  - 작은, 격리된 회귀 포함 (예: OpenAI 응답/Codex 응답 추론 재생 및 도구 호출 흐름)

### 레이어 2: 게이트웨이 + 개발 에이전트 스모크 (실제로 "@openclaw"가 하는 것)

- 테스트: `src/gateway/gateway-models.profiles.live.test.ts`
- 목표:
  - 인-프로세스 게이트웨이 시작
  - `agent:dev:*` 세션 생성/패치 (매 실행마다 모델 오버라이드)
  - 모델-가진-키를 반복하고 다음을 주장:
    - "의미 있는" 응답 (도구 없음)
    - 실제 도구 호출이 작동함 (읽기 프로브)
    - 선택적 추가 도구 프로브 (실행+읽기 프로브)
    - OpenAI 회귀 경로 (도구-호출-만 → 후속 조치)가 계속 작동함
- 프로브 세부사항 (빠르게 실패 원인을 설명할 수 있도록):
  - `읽기` 프로브: 테스트는 워크스페이스에 임시 파일을 작성하고 에이전트에게 이를 `읽고` 임시 파일을 회귀하라고 요청합니다.
  - `실행+읽기` 프로브: 테스트는 에이전트에게 임시 파일에 아무 내용이나 쓰라고 요청하며, 그런 다음 이를 다시 읽도록 요청합니다.
  - 이미지 프로브: 테스트는 생성된 PNG (고양이 + 무작위 코드)를 첨부하고 모델이 `cat <CODE>`를 반환하기를 기대합니다.
  - 구현 참조: `src/gateway/gateway-models.profiles.live.test.ts` 및 `src/gateway/live-image-probe.ts`.
- 활성화 방법:
  - `pnpm test:live` (또는 Vitest를 직접 호출할 경우 `OPENCLAW_LIVE_TEST=1`)
- 모델 선택 방법:
  - 기본: modern 허용 목록 (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all`은 modern 허용 목록의 별칭입니다
  - 또는 `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (또는 쉼표 목록)를 설정하여 좁힘
- 프로바이더 선택 방법 ("OpenRouter 전체"는 피하는 것이 좋습니다):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (쉼표 허용 목록)
- 도구 + 이미지 프로브는 항상 이 라이브 테스트에서 활성화됩니다:
  - `읽기` 프로브 + `실행+읽기` 프로브 (도구 스트레스)
  - 이미지 프로브는 모델이 이미지 입력 지원을 광고할 때 실행됩니다
  - 흐름 (고수준):
    - 테스트는 "CAT" + 무작위 코드가 포함된 작은 PNG를 생성합니다 (`src/gateway/live-image-probe.ts`)
    - 이를 `에이전트` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`를 통해 전송합니다
    - 게이트웨이는 첨부 파일을 `images[]`로 파싱합니다 (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - 내장 에이전트는 모델에 멀티모달 사용자 메시지를 전달합니다
    - 주장: 답장이 `cat` + 코드 (OCR 허용: 사소한 실수 허용)를 포함합니다

팁: 자신의 컴퓨터에서 테스트할 수 있는 내용과 정확한 `프로바이더/모델` ID를 보려면 다음 명령어를 실행하세요:

```bash
openclaw models list
openclaw models list --json
```

## 라이브: Anthropic 설정-토큰 스모크

- 테스트: `src/agents/anthropic.setup-token.live.test.ts`
- 목표: Claude Code CLI 설정-토큰(또는 붙여넣은 설정-토큰 프로파일)이 Anthropic 프롬프트를 완료할 수 있는지 검증합니다.
- 활성화:
  - `pnpm test:live` (또는 `OPENCLAW_LIVE_TEST=1` Vitest를 직접 호출한 경우)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- 토큰 소스 (하나 선택):
  - 프로파일: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Raw 토큰: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- 모델 오버라이드 (선택적):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

설정 예시:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## 라이브: CLI 백엔드 스모크 (Claude Code CLI 또는 다른 로컬 CLI)

- 테스트: `src/gateway/gateway-cli-backend.live.test.ts`
- 목표: 기본 설정을 건드리지 않고 로컬 CLI 백엔드를 사용하여 게이트웨이 + 에이전트 파이프라인 검증.
- 활성화:
  - `pnpm test:live` (또는 Vitest를 직접 호출할 경우 `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- 기본값:
  - 모델: `claude-cli/claude-sonnet-4-6`
  - 명령어: `claude`
  - 인수: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- 덮어쓰기 (선택적):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1`로 실제 이미지 첨부 전송 (경로는 프롬프트에 주입됩니다).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"`로 CLI 인수로 이미지 파일 경로를 전달합니다.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (또는 `"list"`)로 `IMAGE_ARG` 설정 시 이미지 인수 전달 방법을 제어합니다.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`로 두 번째 턴 발송 및 재개 흐름 검증.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0`로 Claude Code CLI MCP 구성을 활성화 상태로 유지 (기본값은 MCP 구성을 임시 빈 파일로 비활성화).

예시:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-6" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 추천 라이브 레시피

좁고 명시적인 허용 목록은 가장 빠르고 불안정성이 적습니다:

- 단일 모델, 직접 (게이트웨이 없음):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 단일 모델, 게이트웨이 스모크:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 여러 프로바이더에 걸친 도구 호출:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google 포커스 (Gemini API 키 + Antigravity):
  - Gemini (API 키): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

노트:

- `google/...`은 Gemini API (API 키)를 사용합니다.
- `google-antigravity/...`은 Antigravity OAuth 브리지를 사용합니다 (Cloud Code Assist 스타일 에이전트 엔드포인트).
- `google-gemini-cli/...`는 귀하의 컴퓨터에서 로컬 Gemini CLI를 사용합니다 (별도의 인증 + 도구 특성).
- Gemini API 대 Gemini CLI:
  - API: OpenClaw는 HTTP를 통해 Google의 호스팅된 Gemini API를 호출합니다 (API 키 / 프로파일 인증); 대부분의 사용자가 "Gemini"라고 하면 이 방법을 의미합니다.
  - CLI: OpenClaw는 로컬 `gemini` 바이너리를 사용합니다; 자체 인증이 있으며 다르게 작동할 수 있습니다 (스트리밍/도구 지원/버전 편차).

## 라이브: 모델 매트릭스 (우리가 다루는 것)

고정된 "CI 모델 목록"은 없습니다 (라이브는 선택 사항입니다), 하지만 이는 키를 가진 개발 머신에서 정기적으로 다루기를 추천하는 모델입니다.

### 현대 스모크 세트 (도구 호출 + 이미지)

이는 우리가 작동하기를 기대하는 "공통 모델" 실행입니다:

- OpenAI (non-Codex): `openai/gpt-5.2` (선택적: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (선택적: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (또는 `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` 및 `google/gemini-3-flash-preview` (오래된 Gemini 2.x 모델은 피하세요)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` 및 `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

도구 + 이미지로 게이트웨이 스모크 실행:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### 기준선: 도구 호출 (읽기 + 선택적 실행)

각 프로바이더 가족 당 적어도 하나 선택하세요:

- OpenAI: `openai/gpt-5.2` (또는 `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (또는 `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (또는 `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

선택적 추가 커버리지 (있으면 좋음):

- xAI: `xai/grok-4` (또는 최신 사용 가능)
- Mistral: `mistral/`… (도구 기능을 가진 모델 중 하나 선택)
- Cerebras: `cerebras/`… (접근 가능하다면)
- LM Studio: `lmstudio/`… (로컬; 도구 호출은 API 모드에 따라 다름)

### 비전: 이미지 전송 (첨부 → 멀티모달 메시지)

`OPENCLAW_LIVE_GATEWAY_MODELS`에 적어도 하나의 이미지-지원 모델을 포함하세요 (Claude/Gemini/OpenAI 비전-지원 변형 등) 이미지 프로브를 실행.

### 집계기 / 대체 게이트웨이

키가 활성화된 경우, 우리는 다음을 통해 테스트도 지원합니다:

- OpenRouter: `openrouter/...` (수백 개의 모델; `openclaw models scan`을 사용하여 도구+이미지 지원 후보자 찾기)
- OpenCode Zen: `opencode/...` (`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` 인증)

추가로, 귀하가 가진 자격 증명/구성으로 라이브 매트릭스에 포함할 수 있는 더 많은 프로바이더들:

- 내장: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- `models.providers`를 통해 (커스텀 엔드포인트): `minimax` (클라우드/API), 및 모든 OpenAI/Anthropic 호환 프록시 (LM Studio, vLLM, LiteLLM 등)

팁: 문서에 "모든 모델"을 하드코딩하려고 하지 마세요. 권위 있는 목록은 본인의 머신에서 `discoverModels(...)`가 반환하는 것 + 사용 가능한 키입니다.

## 자격 증명 (커밋하지 않음)

라이브 테스트는 CLI와 동일한 방식으로 자격 증명을 발견합니다. 실질적인 암시:

- CLI가 작동하면, 라이브 테스트는 동일한 키를 찾아야 합니다.
- 라이브 테스트가 "자격 없음"이라고 말하면 `openclaw models list` / 모델 선택을 디버그하는 것과 동일하게 디버그하세요.

- 프로파일 저장소: `~/.openclaw/credentials/` (선호됨; 테스트에서 "프로파일 키"의 의미)
- 구성: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)

환경 키에 의존하려면 (예: `~/.profile`에 내보내진 경우) 로컬 테스트를 `source ~/.profile` 이후에 실행하거나, 아래 Docker 런너를 사용하세요 (`~/.profile`을 컨테이너에 마운트 가능).

## Deepgram 라이브 (오디오 전사)

- 테스트: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- 활성화: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## BytePlus 코딩 플랜 라이브

- 테스트: `src/agents/byteplus.live.test.ts`
- 활성화: `BYTEPLUS_API_KEY=... BYTEPLUS_LIVE_TEST=1 pnpm test:live src/agents/byteplus.live.test.ts`
- 선택적 모델 오버라이드: `BYTEPLUS_CODING_MODEL=ark-code-latest`

## Docker 런너 (선택적 "Linux에서 작동" 검사)

이들은 리포지토리 Docker 이미지 내에서 `pnpm test:live`를 실행합니다. 로컬 구성 디렉토리 및 워크스페이스 마운트 (그리고 `~/.profile`이 마운트된 경우 소스됨):

- 직접 모델: `pnpm test:docker:live-models` (스크립트: `scripts/test-live-models-docker.sh`)
- 게이트웨이 + 개발 에이전트: `pnpm test:docker:live-gateway` (스크립트: `scripts/test-live-gateway-models-docker.sh`)
- 온보딩 마법사 (TTY, 전체 스캐폴딩): `pnpm test:docker:onboard` (스크립트: `scripts/e2e/onboard-docker.sh`)
- 게이트웨이 네트워킹 (두 개의 컨테이너, WS 인증 + 건강): `pnpm test:docker:gateway-network` (스크립트: `scripts/e2e/gateway-network-docker.sh`)
- 플러그인 (커스텀 확장 로드 + 레지스트리 스모크): `pnpm test:docker:plugins` (스크립트: `scripts/e2e/plugins-docker.sh`)

유용한 환경 변수:

- `OPENCLAW_CONFIG_DIR=...` (기본값: `~/.openclaw`)로 `/home/node/.openclaw`에 마운트
- `OPENCLAW_WORKSPACE_DIR=...` (기본값: `~/.openclaw/workspace`)로 `/home/node/.openclaw/workspace`에 마운트
- `OPENCLAW_PROFILE_FILE=...` (기본값: `~/.profile`)로 `/home/node/.profile`에 마운트되고 테스트 실행 전에 소스
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...`로 실행 범위 좁힘
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`로 프로파일 저장소에서만 자격 증명을 확보

## 문서 무결성 검사

문서 편집 후 문서 검사를 실행: `pnpm docs:list`.

## 오프라인 회귀 (CI-안전)

이들은 실제 프로바이더가 없는 "실제 파이프라인" 회귀입니다:

- 게이트웨이 도구 호출 (모조 OpenAI, 실제 게이트웨이 + 에이전트 루프): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- 게이트웨이 마법사 (WS `wizard.start`/`wizard.next`, 구성 + 인증 적용 방법): `src/gateway/gateway.wizard.e2e.test.ts`

## 에이전트 신뢰성 평가 (스킬)

우리는 이미 "에이전트 신뢰성 평가"처럼 행동하는 몇 가지 CI-안전한 테스트를 가지고 있습니다:

- 실제 게이트웨이 + 에이전트 루프를 통한 모의 도구 호출 (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- 서버 엔드-투-엔드 마법사 흐름이 세션 배선 및 구성 효과를 검증 (`src/gateway/gateway.wizard.e2e.test.ts`).

스킬에 아직 부족한 점 (참조: [스킬](/ko-KR/tools/skills)):

- **결정:** 프로필에서 스킬이 열거될 때 에이전트가 올바른 스킬을 선택합니까 (또는 관련 없는 것을 피합니까)?
- **준수:** 에이전트가 사용 전에 `SKILL.md`를 읽고 요구된 단계/인수를 따릅니까?
- **워크플로 계약:** 도구 순서, 세션 기록 유지 및 샌드박스 경계를 나타내는 다중 턴 시나리오

미래의 평가는 먼저 결정론적이어야 합니다:

- 도구 호출 + 순서를 나타내려는 모의 프로바이더를 사용하는 시나리오 실행기, 기술서 읽기 및 세션 배선.
- 스킬 중심 시나리오의 작은 세트 (사용 대 피하고, 게이팅, 프롬프트 주입 사용).
- 라이브 평가 (옵트인, 환경 변수로 게이팅)만 CI-안전 스위트가 자리잡은 후에 사용.

## 회귀 추가 (안내)

실제에서 발견한 프로바이더/모델 문제를 수정할 때:

- 가능하면 CI-안전 회귀를 추가 (모의/스텁 프로바이더, 또는 정확한 요청-모양 변환 캡쳐)
- 본질적으로 라이브-전용인 경우 (속도 제한, 인증 정책), 라이브 테스트를 좁히고 환경 변수로 옵트인하세요
- 가장 작은 레이어를 타겟으로 해서 버그를 잡으세요:
  - 프로바이더 요청 변환/재생산 버그 → 직접 모델 테스트
  - 게이트웨이 세션/기록/도구 파이프라인 버그 → 게이트웨이 라이브 스모크 또는 CI-안전 게이트웨이 모의 테스트
