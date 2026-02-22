---
summary: "모델 CLI: 목록, 설정, 별칭, 백업, 스캔, 상태"
read_when:
  - 모델 CLI 추가 또는 수정 (모델 목록/설정/스캔/별칭/백업)
  - 모델 백업 동작 또는 선택 UX 변경
  - 모델 스캔 프로브 업데이트 (도구/이미지)
title: "모델 CLI"
---

# 모델 CLI

인증 프로파일 회전, 쿨다운 및 백업과의 상호작용에 대한 내용은 [/concepts/model-failover](/concepts/model-failover)를 참조하세요. 제공자 개요와 예시는 여기에서 확인하세요: [/concepts/model-providers](/concepts/model-providers).

## 모델 선택 작동 방식

OpenClaw는 다음 순서로 모델을 선택합니다:

1. **주(primary)** 모델 (`agents.defaults.model.primary` 또는 `agents.defaults.model`).
2. `agents.defaults.model.fallbacks`에 있는 **백업(fallbacks)** (순서대로).
3. 다음 모델로 이동하기 전에 프로바이더 내에서 **프로바이더 인증 페일오버**가 발생합니다.

관련 사항:

- `agents.defaults.models`는 OpenClaw가 사용할 수 있는 모델의 허용 목록/카탈로그(및 별칭)입니다.
- `agents.defaults.imageModel`은 **주 모델이** 이미지를 수용할 수 없을 때만 사용됩니다.
- 에이전트별 기본값은 `agents.list[].model` 및 바인딩을 통해 `agents.defaults.model`을 재정의할 수 있습니다 (자세한 내용은 [/concepts/multi-agent](/concepts/multi-agent)를 참조하세요).

## 빠른 모델 선택 (예시)

- **GLM**: 코딩/도구 호출에 약간 더 적합합니다.
- **MiniMax**: 작성 및 분위기에 더 적합합니다.

## 설정 마법사 (권장)

설정을 수동으로 수정하지 않으려면, 온보딩 마법사를 실행하세요:

```bash
openclaw onboard
```

이 마법사는 **OpenAI 코드 (Codex) 구독**(OAuth) 및 **Anthropic**(API 키 권장, `claude setup-token`도 지원)을 포함한 일반적인 프로바이더의 모델 및 인증을 설정할 수 있습니다.

## 설정 키 (개요)

- `agents.defaults.model.primary` 및 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 및 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (허용 목록 + 별칭 + 프로바이더 매개변수)
- `models.providers` (커스텀 프로바이더가 `models.json`에 작성됨)

모델 참조는 소문자로 표준화됩니다. `z.ai/*` 같은 프로바이더 별칭은 `zai/*`로 표준화됩니다.

프로바이더 설정 예제 (OpenCode Zen 포함)는 [/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)에 있습니다.

## "모델이 허용되지 않음" (그리고 왜 응답이 중지됨)

`agents.defaults.models`이 설정되면, 이것은 `/model`과 세션 재정의에 대한 **허용 목록**이 됩니다. 사용자가 해당 허용 목록에 없는 모델을 선택하면, OpenClaw는 다음과 같이 반환합니다:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

이것은 정상적인 응답이 생성되기 **전에** 발생하므로, 메시지가 "응답하지 않는 것"처럼 느껴질 수 있습니다. 이를 수정하는 방법은 다음과 같습니다:

- 모델을 `agents.defaults.models`에 추가하거나,
- 허용 목록을 지우거나 (`agents.defaults.models` 제거),
- `/model list`에서 모델을 선택합니다.

허용 목록 구성 예:

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

현재 세션에서 모델을 재시작하지 않고 전환할 수 있습니다:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

주의사항:

- `/model` (및 `/model list`)은 간결하고, 번호가 매겨진 선택기입니다 (모델 패밀리 + 사용 가능한 프로바이더).
- Discord에서는 `/model` 및 `/models`가 프로바이더 및 모델 드롭다운과 제출 단계가 있는 인터랙티브 선택기를 엽니다.
- `/model <#>`는 그 선택기에서 선택합니다.
- `/model status`는 상세보기입니다 (인증 후보 및 설정시 프로바이더 엔드포인트 `baseUrl` + `api` 모드).
- 모델 참조는 **첫 번째** `/`로 분할하여 해석됩니다. `/model <ref>`를 입력할 때 `provider/model`을 사용하세요.
- 모델 ID 자체에 `/`가 포함되어 있으면 (OpenRouter 스타일), 프로바이더 접두사를 포함해야 합니다 (예: `/model openrouter/moonshotai/kimi-k2`).
- 프로바이더를 생략하면 OpenClaw는 입력을 별칭이나 **기본 프로바이더**의 모델로 간주합니다 (모델 ID에 `/`가 없을 때만 작동).

전체 명령어 동작/구성: [슬래시 명령어](/tools/slash-commands).

## CLI 명령어

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

`openclaw models` (하위 명령어 없음)는 `models status`의 단축키입니다.

### `models list`

기본적으로 구성된 모델을 표시합니다. 유용한 플래그:

- `--all`: 전체 카탈로그
- `--local`: 로컬 프로바이더만
- `--provider <name>`: 프로바이더별 필터
- `--plain`: 한 줄에 하나의 모델
- `--json`: 기계 판독 가능 출력

### `models status`

해결된 주 모델, 백업, 이미지 모델과 구성된 프로바이더의 인증 개요를 보여줍니다. 인증 저장소에서 발견된 프로파일의 OAuth 만료 상태도 표시됩니다 (기본적으로 24시간 이내에 경고). `--plain`은 해결된 주 모델만 출력합니다. OAuth 상태는 항상 표시되며 (`--json` 출력에 포함) 구성된 프로바이더에 자격 증명이 없으면 `models status`는 **인증 누락** 섹션을 표시합니다. JSON에는 `auth.oauth` (경고 창 + 프로파일)과 `auth.providers` (프로바이더별 효과적인 인증)가 포함됩니다. 자동화를 위해 `--check`를 사용하세요 (누락/만료인 경우 `1`, 만료가 임박한 경우 `2`로 종료).

권장 Anthropic 인증은 Claude Code CLI 설정 토큰입니다 (어디에서나 실행; 필요시 게이트웨이 호스트에 붙여넣기):

```bash
claude setup-token
openclaw models status
```

## 스캔 (OpenRouter 무료 모델)

`openclaw models scan`은 OpenRouter의 **무료 모델 카탈로그**를 검사하고 도구 및 이미지 지원을 위한 모델을 선택적으로 검사할 수 있습니다.

주요 플래그:

- `--no-probe`: 라이브 프로브 건너뛰기 (메타데이터만)
- `--min-params <b>`: 최소 파라미터 크기 (10억 단위)
- `--max-age-days <days>`: 더 오래된 모델 건너뛰기
- `--provider <name>`: 프로바이더 접두사 필터
- `--max-candidates <n>`: 백업 목록 크기
- `--set-default`: 첫 번째 선택을 `agents.defaults.model.primary`로 설정
- `--set-image`: 첫 번째 이미지 선택을 `agents.defaults.imageModel.primary`로 설정

스캔은 OpenRouter API 키가 필요합니다 (인증 프로파일이나 `OPENROUTER_API_KEY`에서). 키가 없는 경우, 후보 목록만 표시하려면 `--no-probe`를 사용하세요.

스캔 결과는 다음 순서로 평가됩니다:

1. 이미지 지원
2. 도구 대기 시간
3. 컨텍스트 크기
4. 파라미터 수

입력

- OpenRouter `/models` 목록 (필터 `:free`)
- 인증 프로파일이나 `OPENROUTER_API_KEY`에서 OpenRouter API 키가 필요 (보조 정보는 [/environment](/help/environment) 참조)
- 선택적 필터: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- 프로브 제어: `--timeout`, `--concurrency`

TTY에서 실행되면 상호작용적으로 백업을 선택할 수 있습니다. 비상호작용 모드에서는 기본값을 수락하려면 `--yes`를 전달하십시오.

## 모델 레지스트리 (`models.json`)

`models.providers`에 있는 커스텀 프로바이더는 에이전트 디렉토리 (기본 `~/.openclaw/agents/<agentId>/models.json`)의 `models.json`에 작성됩니다. 이 파일은 기본적으로 병합되며, `models.mode`가 `replace`로 설정된 경우를 제외합니다.
