---
summary: "테스트 키트: unit/e2e/live 스위트, Docker 러너, 그리고 각 테스트가 다루는 범위"
read_when:
  - 로컬 또는 CI 에서 테스트를 실행할 때
  - 모델/프로바이더 버그에 대한 회귀 테스트를 추가할 때
  - Gateway(게이트웨이) + 에이전트 동작을 디버깅할 때
title: "테스트"
---

# 테스트

OpenClaw 에는 세 가지 Vitest 스위트(unit/integration, e2e, live)와 소규모 Docker 러너 세트가 있습니다.

이 문서는 “어떻게 테스트하는가”에 대한 가이드입니다:

- What each suite covers (and what it deliberately does _not_ cover)
- 일반적인 워크플로(로컬, 푸시 전, 디버깅)에 실행할 명령
- live 테스트가 자격 증명을 발견하고 모델/프로바이더를 선택하는 방식
- 실제 모델/프로바이더 이슈에 대한 회귀 테스트를 추가하는 방법

## 빠른 시작

대부분의 경우:

- 전체 게이트(푸시 전 기대됨): `pnpm build && pnpm check && pnpm test`

테스트를 수정했거나 추가적인 확신이 필요할 때:

- 커버리지 게이트: `pnpm test:coverage`
- E2E 스위트: `pnpm test:e2e`

실제 프로바이더/모델을 디버깅할 때(실제 자격 증명 필요):

- Live 스위트(모델 + Gateway(게이트웨이) 도구/이미지 프로브): `pnpm test:live`

팁: 실패하는 단일 케이스만 필요할 때는 아래에 설명된 allowlist 환경 변수를 사용해 live 테스트를 좁히는 것을 선호하십시오.

## 테스트 스위트(어디서 무엇이 실행되는가)

스위트는 “현실성 증가”(그리고 불안정성/비용 증가)로 생각하십시오:

### Unit / integration (기본값)

- 명령: `pnpm test`
- 구성: `vitest.config.ts`
- 파일: `src/**/*.test.ts`
- 범위:
  - 순수 유닛 테스트
  - 프로세스 내 통합 테스트(Gateway(게이트웨이) 인증, 라우팅, 도구, 파싱, 구성)
  - 알려진 버그에 대한 결정적 회귀 테스트
- 기대 사항:
  - CI 에서 실행됨
  - 실제 키 불필요
  - 빠르고 안정적이어야 함

### E2E (Gateway(게이트웨이) 스모크)

- 명령: `pnpm test:e2e`
- 구성: `vitest.e2e.config.ts`
- 파일: `src/**/*.e2e.test.ts`
- 범위:
  - 다중 인스턴스 Gateway(게이트웨이) 엔드투엔드 동작
  - WebSocket/HTTP 표면, 노드 페어링, 더 무거운 네트워킹
- 기대 사항:
  - 파이프라인에서 활성화된 경우 CI 에서 실행
  - 실제 키 불필요
  - 유닛 테스트보다 구성 요소가 많음(느릴 수 있음)

### Live (실제 프로바이더 + 실제 모델)

- 명령: `pnpm test:live`
- 구성: `vitest.live.config.ts`
- 파일: `src/**/*.live.test.ts`
- 기본값: `pnpm test:live` 에 의해 **활성화**(`OPENCLAW_LIVE_TEST=1` 설정)
- 범위:
  - “이 프로바이더/모델이 오늘 실제 자격 증명으로 실제로 동작하는가?”
  - 프로바이더 포맷 변경, 도구 호출 특이점, 인증 이슈, 레이트 리밋 동작 포착
- 기대 사항:
  - 설계상 CI 에 안정적이지 않음(실제 네트워크, 실제 프로바이더 정책, 할당량, 장애)
  - 비용 발생 / 레이트 리밋 사용
  - “전체” 대신 좁힌 부분 집합 실행 권장
  - Live 실행은 누락된 API 키를 수집하기 위해 `~/.profile` 를 소스함
  - Anthropic 키 로테이션: `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."`(또는 `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) 또는 여러 `ANTHROPIC_API_KEY*` 변수를 설정; 테스트는 레이트 리밋 시 재시도함

## Which suite should I run?

다음 결정 표를 사용하십시오:

- 로직/테스트 편집: `pnpm test` 실행(많이 변경했다면 `pnpm test:coverage` 도)
- Gateway(게이트웨이) 네트워킹 / WS 프로토콜 / 페어링 수정: `pnpm test:e2e` 추가
- “봇이 다운됨” 디버깅 / 프로바이더별 실패 / 도구 호출: 좁힌 `pnpm test:live` 실행

## Live: 모델 스모크(프로파일 키)

Live 테스트는 실패를 분리하기 위해 두 계층으로 나뉩니다:

- “직접 모델”은 주어진 키로 프로바이더/모델이 응답 가능한지 확인합니다.
- “Gateway(게이트웨이) 스모크”는 해당 모델에 대해 전체 Gateway(게이트웨이)+에이전트 파이프라인이 동작하는지 확인합니다(세션, 히스토리, 도구, 샌드박스 정책 등).

### 레이어 1: 직접 모델 완료(Gateway(게이트웨이) 없음)

- 테스트: `src/agents/models.profiles.live.test.ts`
- 목표:
  - 발견된 모델 열거
  - 보유한 자격 증명에 맞는 모델을 선택하기 위해 `getApiKeyForModel` 사용
  - 모델당 작은 완료 실행(필요 시 타겟 회귀)
- 활성화 방법:
  - `pnpm test:live`(또는 Vitest 를 직접 호출하는 경우 `OPENCLAW_LIVE_TEST=1`)
- 실제로 이 스위트를 실행하려면 `OPENCLAW_LIVE_MODELS=modern`(또는 최신 별칭인 `all`)을 설정; 그렇지 않으면 `pnpm test:live` 를 Gateway(게이트웨이) 스모크에 집중시키기 위해 건너뜁니다
- 모델 선택 방법:
  - 최신 allowlist 실행: `OPENCLAW_LIVE_MODELS=modern`(Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` 는 최신 allowlist 의 별칭
  - 또는 `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."`(쉼표 allowlist)
- 프로바이더 선택 방법:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"`(쉼표 allowlist)
- 키 출처:
  - 기본값: 프로파일 스토어 및 환경 변수 폴백
  - **프로파일 스토어**만 강제하려면 `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 설정
- 존재 이유:
  - “프로바이더 API 가 깨짐 / 키가 유효하지 않음”과 “Gateway(게이트웨이) 에이전트 파이프라인이 깨짐”을 분리
  - 작고 고립된 회귀 포함(예: OpenAI Responses/Codex Responses 추론 재생 + 도구 호출 플로)

### 레이어 2: Gateway(게이트웨이) + 개발 에이전트 스모크(“@openclaw” 실제 동작)

- 테스트: `src/gateway/gateway-models.profiles.live.test.ts`
- 목표:
  - 프로세스 내 Gateway(게이트웨이) 기동
  - `agent:dev:*` 세션 생성/패치(실행별 모델 오버라이드)
  - 키가 있는 모델을 순회하며 다음을 검증:
    - “의미 있는” 응답(도구 없음)
    - 실제 도구 호출이 동작함(읽기 프로브)
    - 선택적 추가 도구 프로브(exec+read 프로브)
    - OpenAI 회귀 경로(도구 호출만 → 후속)가 계속 동작
- 프로브 상세(실패를 빠르게 설명하기 위함):
  - `read` 프로브: 테스트가 워크스페이스에 nonce 파일을 쓰고 에이전트에게 이를 `read` 하여 nonce 를 되돌려 달라고 요청
  - `exec+read` 프로브: 테스트가 에이전트에게 nonce 를 임시 파일에 `exec`-쓰기 하도록 요청한 뒤 이를 `read` 하여 반환
  - 이미지 프로브: 생성된 PNG(cat + 무작위 코드)를 첨부하고 모델이 `cat <CODE>` 를 반환할 것을 기대
  - 구현 참고: `src/gateway/gateway-models.profiles.live.test.ts` 및 `src/gateway/live-image-probe.ts`
- 활성화 방법:
  - `pnpm test:live`(또는 Vitest 를 직접 호출하는 경우 `OPENCLAW_LIVE_TEST=1`)
- 모델 선택 방법:
  - 기본값: 최신 allowlist(Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` 는 최신 allowlist 의 별칭
  - 또는 `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"`(또는 쉼표 목록)으로 좁힘
- 프로바이더 선택 방법(“OpenRouter 전부” 방지):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"`(쉼표 allowlist)
- 도구 + 이미지 프로브는 이 live 테스트에서 항상 활성화됨:
  - `read` 프로브 + `exec+read` 프로브(도구 스트레스)
  - 모델이 이미지 입력 지원을 광고하면 이미지 프로브 실행
  - 플로(상위 수준):
    - 테스트가 “CAT” + 무작위 코드가 있는 작은 PNG 생성(`src/gateway/live-image-probe.ts`)
    - 이를 `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` 로 전송
    - Gateway(게이트웨이)가 첨부 파일을 `images[]`(`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)으로 파싱
    - 내장 에이전트가 멀티모달 사용자 메시지를 모델로 전달
    - 단언: 응답에 `cat` + 코드가 포함됨(OCR 허용 오차: 경미한 오류 허용)

팁: 내 머신에서 무엇을 테스트할 수 있는지(그리고 정확한 `provider/model` id)를 보려면 다음을 실행하십시오:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token 스모크

- 테스트: `src/agents/anthropic.setup-token.live.test.ts`
- 목표: Claude Code CLI setup-token(또는 붙여넣은 setup-token 프로파일)이 Anthropic 프롬프트를 완료할 수 있는지 검증
- 활성화:
  - `pnpm test:live`(또는 Vitest 를 직접 호출하는 경우 `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- 토큰 출처(하나 선택):
  - 프로파일: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 원시 토큰: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- 모델 오버라이드(선택):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

설정 예시:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI 백엔드 스모크(Claude Code CLI 또는 기타 로컬 CLI)

- 테스트: `src/gateway/gateway-cli-backend.live.test.ts`
- 목표: 기본 구성에 손대지 않고 로컬 CLI 백엔드를 사용해 Gateway(게이트웨이) + 에이전트 파이프라인을 검증
- 활성화:
  - `pnpm test:live`(또는 Vitest 를 직접 호출하는 경우 `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- 기본값:
  - 모델: `claude-cli/claude-sonnet-4-5`
  - 명령: `claude`
  - 인자: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- 오버라이드(선택):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - 실제 이미지 첨부를 전송하려면 `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1`(경로는 프롬프트에 주입됨)
  - 이미지 파일 경로를 프롬프트 주입 대신 CLI 인자로 전달하려면 `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"`
  - `IMAGE_ARG` 설정 시 이미지 인자 전달 방식을 제어하려면 `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"`(또는 `"list"`)
  - 두 번째 턴을 보내고 재개 플로를 검증하려면 `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`
- Claude Code CLI MCP 구성을 활성화 상태로 유지하려면 `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0`(기본값은 임시 빈 파일로 MCP 구성을 비활성화)

예시:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 권장 live 레시피

좁고 명시적인 allowlist 가 가장 빠르고 가장 안정적입니다:

- 단일 모델, 직접(게이트웨이 없음):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 단일 모델, Gateway(게이트웨이) 스모크:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 여러 프로바이더에 걸친 도구 호출:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google 중심(Gemini API 키 + Antigravity):
  - Gemini(API 키): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity(OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

참고:

- `google/...` 는 Gemini API(API 키)를 사용합니다.
- `google-antigravity/...` 는 Antigravity OAuth 브리지(Cloud Code Assist 스타일 에이전트 엔드포인트)를 사용합니다.
- `google-gemini-cli/...` 는 로컬 Gemini CLI 를 사용합니다(별도의 인증 + 도구 특이점).
- Gemini API vs Gemini CLI:
  - API: OpenClaw 가 Google 호스팅 Gemini API 를 HTTP 로 호출(API 키 / 프로파일 인증); 대부분 사용자가 말하는 “Gemini”.
  - CLI: OpenClaw 가 로컬 `gemini` 바이너리를 호출; 자체 인증을 가지며 동작이 다를 수 있음(스트리밍/도구 지원/버전 편차).

## Live: 모델 매트릭스(다루는 범위)

고정된 “CI 모델 목록”은 없지만(live 는 옵트인), 키가 있는 개발 머신에서 정기적으로 커버할 것을 **권장**하는 모델들입니다.

### 최신 스모크 세트(도구 호출 + 이미지)

계속 동작해야 하는 “공통 모델” 실행입니다:

- OpenAI(비 Codex): `openai/gpt-5.2`(선택: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex`(선택: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6`(또는 `anthropic/claude-sonnet-4-5`)
- Google(Gemini API): `google/gemini-3-pro-preview` 및 `google/gemini-3-flash-preview`(구형 Gemini 2.x 모델 회피)
- Google(Antigravity): `google-antigravity/claude-opus-4-6-thinking` 및 `google-antigravity/gemini-3-flash`
- Z.AI(GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

도구 + 이미지로 Gateway(게이트웨이) 스모크 실행:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### 베이스라인: 도구 호출(Read + 선택적 Exec)

프로바이더 패밀리당 최소 하나 선택:

- OpenAI: `openai/gpt-5.2`(또는 `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6`(또는 `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview`(또는 `google/gemini-3-pro-preview`)
- Z.AI(GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

선택적 추가 커버리지(있으면 좋음):

- xAI: `xai/grok-4`(또는 최신 사용 가능 모델)
- Mistral: `mistral/`… (pick one “tools” capable model you have enabled)
- Cerebras: `cerebras/`…(접근 권한이 있는 경우) (if you have access)
- LM Studio: `lmstudio/`… LM Studio: `lmstudio/`…(로컬; 도구 호출은 API 모드에 따라 다름)

### 비전: 이미지 전송(첨부 → 멀티모달 메시지)

이미지 프로브를 실행하기 위해 `OPENCLAW_LIVE_GATEWAY_MODELS` 에 이미지 가능 모델을 최소 하나 포함하십시오(Claude/Gemini/OpenAI 비전 가능 변형 등). to exercise the image probe.

### 집계기 / 대체 게이트웨이

키가 활성화되어 있다면 다음을 통한 테스트도 지원합니다:

- OpenRouter: `openrouter/...`(수백 개 모델; 도구+이미지 가능 후보를 찾으려면 `openclaw models scan` 사용)
- OpenCode Zen: `opencode/...`(인증: `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Live 매트릭스에 포함할 수 있는 추가 프로바이더(자격 증명/구성이 있는 경우):

- 내장: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- `models.providers`(커스텀 엔드포인트) 경유: `minimax`(클라우드/API), 그리고 OpenAI/Anthropic 호환 프록시(LM Studio, vLLM, LiteLLM 등)

팁: 문서에 “모든 모델”을 하드코딩하지 마십시오. 권위 있는 목록은 내 머신에서 `discoverModels(...)` 가 반환하는 것 + 사용 가능한 키입니다.

## 자격 증명(절대 커밋 금지)

Live 테스트는 CLI 와 동일한 방식으로 자격 증명을 발견합니다. 실무적 의미:

- CLI 가 동작하면 live 테스트도 동일한 키를 찾아야 합니다.

- live 테스트가 “자격 증명 없음”이라고 하면 `openclaw models list` / 모델 선택을 디버깅하는 것과 같은 방식으로 디버깅하십시오.

- 프로파일 스토어: `~/.openclaw/credentials/`(권장; 테스트에서 말하는 “프로파일 키”의 의미)

- 구성: `~/.openclaw/openclaw.json`(또는 `OPENCLAW_CONFIG_PATH`)

환경 키에 의존하려면(예: `~/.profile` 에서 export), `source ~/.profile` 이후 로컬 테스트를 실행하거나 아래 Docker 러너를 사용하십시오(컨테이너에 `~/.profile` 를 마운트 가능).

## Deepgram live(오디오 전사)

- 테스트: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- 활성화: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker 러너(선택적 “Linux 에서 동작” 확인)

리포 Docker 이미지 안에서 `pnpm test:live` 를 실행하며, 로컬 구성 디렉토리와 워크스페이스를 마운트합니다(마운트된 경우 `~/.profile` 를 소스):

- 직접 모델: `pnpm test:docker:live-models`(스크립트: `scripts/test-live-models-docker.sh`)
- Gateway(게이트웨이) + 개발 에이전트: `pnpm test:docker:live-gateway`(스크립트: `scripts/test-live-gateway-models-docker.sh`)
- 온보딩 마법사(TTY, 전체 스캐폴딩): `pnpm test:docker:onboard`(스크립트: `scripts/e2e/onboard-docker.sh`)
- Gateway(게이트웨이) 네트워킹(두 컨테이너, WS 인증 + 헬스): `pnpm test:docker:gateway-network`(스크립트: `scripts/e2e/gateway-network-docker.sh`)
- 플러그인(커스텀 확장 로드 + 레지스트리 스모크): `pnpm test:docker:plugins`(스크립트: `scripts/e2e/plugins-docker.sh`)

Useful env vars:

- `OPENCLAW_CONFIG_DIR=...`(기본값: `~/.openclaw`) → `/home/node/.openclaw` 에 마운트
- `OPENCLAW_WORKSPACE_DIR=...`(기본값: `~/.openclaw/workspace`) → `/home/node/.openclaw/workspace` 에 마운트
- `OPENCLAW_PROFILE_FILE=...`(기본값: `~/.profile`) → `/home/node/.profile` 에 마운트되고 테스트 실행 전 소스됨
- 실행을 좁히려면 `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...`
- 자격 증명이 환경 변수가 아닌 프로파일 스토어에서 오도록 보장하려면 `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`

## Docs sanity

문서 편집 후 문서 체크 실행: `pnpm docs:list`.

## 오프라인 회귀(CI 안전)

실제 프로바이더 없이 “실제 파이프라인” 회귀:

- Gateway(게이트웨이) 도구 호출(mock OpenAI, 실제 Gateway(게이트웨이) + 에이전트 루프): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway(게이트웨이) 마법사(WS `wizard.start`/`wizard.next`, 구성 작성 + 인증 강제): `src/gateway/gateway.wizard.e2e.test.ts`

## 에이전트 신뢰성 평가(skills)

이미 “에이전트 신뢰성 평가”처럼 동작하는 CI 안전 테스트가 일부 있습니다:

- 실제 Gateway(게이트웨이) + 에이전트 루프를 통한 mock 도구 호출(`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- 세션 와이어링과 구성 효과를 검증하는 엔드투엔드 마법사 플로(`src/gateway/gateway.wizard.e2e.test.ts`).

Skills 에 아직 부족한 부분([Skills](/tools/skills) 참고):

- **의사결정:** 프롬프트에 skills 가 나열될 때 에이전트가 올바른 skill 을 선택하는가(또는 관련 없는 것을 회피하는가)?
- **컴플라이언스:** 사용 전 `SKILL.md` 를 읽고 요구되는 단계/인자를 따르는가?
- **워크플로 계약:** 도구 순서, 세션 히스토리 전달, 샌드박스 경계를 단언하는 멀티턴 시나리오.

향후 평가는 우선 결정적으로 유지해야 합니다:

- mock 프로바이더를 사용하는 시나리오 러너로 도구 호출 + 순서, skill 파일 읽기, 세션 와이어링을 단언.
- skill 중심 시나리오의 소규모 스위트(사용 vs 회피, 게이팅, 프롬프트 인젝션).
- CI 안전 스위트가 준비된 이후에만 선택적 live 평가(옵트인, 환경 변수 게이팅).

## 회귀 추가(가이드)

Live 에서 발견된 프로바이더/모델 이슈를 수정할 때:

- 가능하면 CI 안전 회귀를 추가(mock/stub 프로바이더, 또는 정확한 요청 형태 변환 캡처)
- 본질적으로 live 전용인 경우(레이트 리밋, 인증 정책) live 테스트를 좁게 유지하고 환경 변수로 옵트인
- 버그를 포착하는 가장 작은 레이어를 선호:
  - 프로바이더 요청 변환/재생 버그 → 직접 모델 테스트
  - Gateway(게이트웨이) 세션/히스토리/도구 파이프라인 버그 → Gateway(게이트웨이) live 스모크 또는 CI 안전 Gateway(게이트웨이) mock 테스트
