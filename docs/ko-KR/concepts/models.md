---
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/concepts/models.md
workflow: 15
summary: "모델 CLI: 나열, 설정, 별칭, 폴백, 스캔, 상태"
read_when:
  - 모델 CLI 추가 또는 수정(모델 나열/설정/스캔/별칭/폴백)
  - 모델 폴백 동작 또는 선택 UX 변경
  - 모델 스캔 프로브 업데이트(도구/이미지)
title: "모델 CLI"
---

# 모델 CLI

인증 프로필 로테이션, 쿨다운, 그리고 폴백과의 상호작용 방식에 대해서는 [/concepts/model-failover](/concepts/model-failover)를 참고하십시오.
빠른 공급자 개요 + 예제: [/concepts/model-providers](/concepts/model-providers).

## 모델 선택 방식

OpenClaw는 다음 순서로 모델을 선택합니다:

1. **기본** 모델 (`agents.defaults.model.primary` 또는 `agents.defaults.model`).
2. **폴백** `agents.defaults.model.fallbacks` (순서대로).
3. **공급자 인증 장애 조치**는 다음 모델로 이동하기 전에 공급자 내에서 발생합니다.

관련 참고 사항:

- `agents.defaults.models`는 OpenClaw가 사용할 수 있는 모델의 허용 목록/카탈로그입니다 (별칭 포함).
- `agents.defaults.imageModel`은 **기본 모델이 이미지를 수락할 수 없을 때만** 사용됩니다.
- 에이전트별 기본값은 `agents.list[].model` 플러스 바인딩을 통해 `agents.defaults.model`을 오버라이드할 수 있습니다 ([/concepts/multi-agent](/concepts/multi-agent) 참고).

## 빠른 모델 선택 (주관적)

- **GLM**: 코딩/도구 호출에 약간 더 낫습니다.
- **MiniMax**: 글쓰기 및 분위기에 더 좋습니다.

## 설정 마법사 (권장)

손으로 구성하고 싶지 않다면 온보딩 마법사를 실행하십시오:

```bash
openclaw onboard
```

일반적인 공급자를 위해 모델 + 인증을 설정할 수 있습니다. **OpenAI Code (Codex 구독)** (OAuth) 및 **Anthropic** (API 키 권장, `claude setup-token`도 지원함)을 포함합니다.

## 구성 키 (개요)

- `agents.defaults.model.primary` 및 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 및 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (허용 목록 + 별칭 + 공급자 매개변수)
- `models.providers` (사용자 정의 공급자는 `models.json`에 기록됨)

모델 참조는 소문자로 정규화됩니다. `z.ai/*`와 같은 공급자 별칭은 `zai/*`로 정규화됩니다.

공급자 구성 예제 (OpenCode Zen 포함)는 [/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)에 있습니다.

## "모델이 허용되지 않습니다" (그리고 왜 회신이 중단되는지)

`agents.defaults.models`가 설정되면 `/model`과 세션 오버라이드에 대한 **허용 목록**이 됩니다. 사용자가 해당 허용 목록에 없는 모델을 선택하면 OpenClaw는 다음을 반환합니다:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

이는 **일반 회신이 생성되기 전에** 발생하므로 메시지가 "응답하지 않은" 것처럼 느껴질 수 있습니다. 해결책은 다음 중 하나입니다:

- 모델을 `agents.defaults.models`에 추가합니다, 또는
- 허용 목록을 지웁니다 (`agents.defaults.models` 제거), 또는
- `/model list`에서 모델을 선택합니다.

예제 허용 목록 구성:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## 채팅에서 모델 전환 (`/model`)

다시 시작하지 않고 현재 세션의 모델을 전환할 수 있습니다:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

참고:

- `/model` (및 `/model list`)은 컴팩트한 번호 지정 선택기입니다(모델 제품군 + 사용 가능한 공급자).
- Discord에서 `/model` 및 `/models`는 공급자 및 모델 드롭다운과 제출 단계가 있는 대화형 선택기를 엽니다.
- `/model <#>`는 해당 선택기에서 선택합니다.
- `/model status`는 상세 보기입니다(인증 후보 및, 구성된 경우 공급자 엔드포인트 `baseUrl` + `api` 모드).
- 모델 참조는 **첫 번째** `/`로 분할하여 구문 분석됩니다. `/model <ref>`를 입력할 때 `provider/model`을 사용합니다.
- 모델 ID 자체에 `/`이 포함된 경우(OpenRouter 스타일), 공급자 접두사를 포함해야 합니다(예: `/model openrouter/moonshotai/kimi-k2`).
- 공급자를 생략하면, OpenClaw는 입력을 별칭 또는 **기본 공급자**의 모델로 취급합니다 (모델 ID에 `/`이 없을 때만 작동).

전체 명령 동작/구성: [슬래시 명령](/tools/slash-commands).

## CLI 명령

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (서브명령 없음)은 `models status`의 단축키입니다.

### `models list`

기본적으로 구성된 모델을 표시합니다. 유용한 플래그:

- `--all`: 전체 카탈로그
- `--local`: 로컬 공급자만
- `--provider <name>`: 공급자별 필터
- `--plain`: 한 줄에 하나의 모델
- `--json`: 기계 판독 가능한 출력

### `models status`

해결된 기본 모델, 폴백, 이미지 모델, 및 구성된 공급자의 인증 개요를 표시합니다. 인증 저장소에서 찾은 프로필의 OAuth 만료 상태도 표시합니다(기본적으로 24 시간 내에 경고). `--plain`은 해결된 기본 모델만 인쇄합니다.
OAuth 상태는 항상 표시됩니다 (`--json` 출력에 포함됨). 구성된 공급자에 자격 증명이 없으면, `models status`는 **인증 누락** 섹션을 인쇄합니다.
JSON에는 `auth.oauth` (경고 창 + 프로필) 및 `auth.providers` (공급자별 유효 인증)가 포함됩니다.
자동화를 위해 `--check`를 사용합니다 (누락/만료 시 종료 `1`, 만료 예정 시 `2`).

선호 Anthropic 인증은 Claude Code CLI setup-token입니다 (어디서나 실행 가능하며, 필요한 경우 게이트웨이 호스트에 붙여넣기):

```bash
claude setup-token
openclaw models status
```

## 스캔 (OpenRouter 무료 모델)

`openclaw models scan`은 OpenRouter의 **무료 모델 카탈로그**를 검사하고 선택적으로 도구 및 이미지 지원에 대한 모델을 탐사할 수 있습니다.

주요 플래그:

- `--no-probe`: 라이브 탐사 건너뛰기 (메타데이터만)
- `--min-params <b>`: 최소 매개변수 크기 (십억)
- `--max-age-days <days>`: 더 오래된 모델 건너뛰기
- `--provider <name>`: 공급자 접두사 필터
- `--max-candidates <n>`: 폴백 목록 크기
- `--set-default`: `agents.defaults.model.primary`를 첫 번째 선택으로 설정
- `--set-image`: `agents.defaults.imageModel.primary`를 첫 번째 이미지 선택으로 설정

탐사하려면 OpenRouter API 키가 필요합니다 (인증 프로필 또는 `OPENROUTER_API_KEY`). 키 없이 `--no-probe`를 사용하여 후보만 나열합니다.

스캔 결과는 다음과 같이 순위가 지정됩니다:

1. 이미지 지원
2. 도구 지연
3. 컨텍스트 크기
4. 매개변수 수

입력

- OpenRouter `/models` 목록 (`:free` 필터)
- OpenRouter API 키가 인증 프로필 또는 `OPENROUTER_API_KEY`에서 필요합니다 ([/environment](/help/environment) 참고)
- 선택사항 필터: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- 탐사 컨트롤: `--timeout`, `--concurrency`

TTY에서 실행하면 대화형으로 폴백을 선택할 수 있습니다. 비대화형 모드에서는 `--yes`를 전달하여 기본값을 수락합니다.

## 모델 레지스트리 (`models.json`)

`models.providers`의 사용자 정의 공급자는 에이전트 디렉토리(기본값 `~/.openclaw/agents/<agentId>/models.json`)의 `models.json`에 기록됩니다. 이 파일은 기본적으로 병합됩니다. `models.mode`가 `replace`로 설정된 경우를 제외합니다.

일치하는 공급자 ID에 대한 병합 모드 우선순위:

- 에이전트 `models.json`에 이미 존재하는 비어있지 않은 `apiKey`/`baseUrl`이 우세합니다.
- 비어있거나 누락된 에이전트 `apiKey`/`baseUrl`은 구성 `models.providers`로 돌아갑니다.
- 다른 공급자 필드는 구성 및 정규화된 카탈로그 데이터에서 새로고침됩니다.
