---
read_when:
    - 모델 CLI 추가 또는 수정(모델 목록/설정/스캔/별칭/폴백)
    - 모델 대체 동작 또는 선택 UX 변경
    - 모델 스캔 프로브 업데이트(도구/이미지)
summary: '모델 CLI: 목록, 설정, 별칭, 대체, 스캔, 상태'
title: 모델 CLI
x-i18n:
    generated_at: "2026-02-08T15:54:59Z"
    model: gtx
    provider: google-translate
    source_hash: 13e17a306245e0cc24914b24c6d20437e35c16944f379bf92af8e7f0d5b0287f
    source_path: concepts/models.md
    workflow: 15
---

# 모델 CLI

보다 [/개념/모델-장애 조치](/concepts/model-failover) 인증 프로필용
회전, 재사용 대기시간 및 대체와 상호 작용하는 방식.
빠른 공급자 개요 + 예: [/개념/모델 제공자](/concepts/model-providers).

## 모델 선택 작동 방식

OpenClaw는 다음 순서로 모델을 선택합니다.

1. **주요한** 모델 (`agents.defaults.model.primary` 또는 `agents.defaults.model`).
2. **폴백** ~에 `agents.defaults.model.fallbacks` (순서대로).
3. **공급자 인증 장애 조치** 공급자 내부로 이동하기 전에 공급자 내부에서 발생합니다.
   다음 모델.

관련된:

- `agents.defaults.models` OpenClaw가 사용할 수 있는 모델의 허용 목록/카탈로그입니다(별칭 포함).
- `agents.defaults.imageModel` 사용된다 **오직 언제** 기본 모델은 이미지를 허용할 수 없습니다.
- 에이전트별 기본값을 재정의할 수 있습니다. `agents.defaults.model` ~을 통해 `agents.list[].model` 플러스 바인딩(참조 [/개념/다중 에이전트](/concepts/multi-agent)).

## 빠른 모델 선택(일화)

- **GLM**: 코딩/툴 호출에 조금 더 좋습니다.
- **미니맥스**: 글쓰기와 분위기에 더 좋습니다.

## 설정 마법사(권장)

구성을 직접 편집하지 않으려면 온보딩 마법사를 실행하세요.

```bash
openclaw onboard
```

다음을 포함하여 일반 공급자에 대한 모델 + 인증을 설정할 수 있습니다. **OpenAI 코드(Codex)
구독** (OAuth) 및 **인류학** (API 키 권장; `claude
setup-token` 도 지원됩니다).

## 구성 키(개요)

- `agents.defaults.model.primary` 그리고 `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` 그리고 `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (허용 목록 + 별칭 + 공급자 매개변수)
- `models.providers` (맞춤 공급자는 `models.json`)

모델 참조는 소문자로 정규화됩니다. 다음과 같은 공급자 별칭 `z.ai/*` 정규화하다
에 `zai/*`.

공급자 구성 예제(OpenCode Zen 포함)는 다음 위치에 있습니다.
[/게이트웨이/구성](/gateway/configuration#opencode-zen-multi-model-proxy).

## “모델은 허용되지 않습니다”(그리고 응답이 중지되는 이유)

만약에 `agents.defaults.models` 설정되면 **허용 목록** ~을 위한 `/model` 그리고
세션 재정의. 사용자가 해당 허용 목록에 없는 모델을 선택하면,
OpenClaw는 다음을 반환합니다.

```
Model "provider/model" is not allowed. Use /model to list available models.
```

이런 일이 일어난다 **~ 전에** 정상적인 응답이 생성되므로 메시지가 느껴질 수 있습니다.
"응답하지 않았다"처럼요. 해결 방법은 다음 중 하나입니다.

- 모델 추가 `agents.defaults.models`, 또는
- 허용 목록 지우기(제거 `agents.defaults.models`), 또는
- 다음에서 모델을 선택하세요. `/model list`.

허용 목록 구성 예시:

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

## 채팅에서 모델 전환(`/model`)

다시 시작하지 않고도 현재 세션의 모델을 전환할 수 있습니다.

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

참고:

- `/model` (그리고 `/model list`)는 번호가 매겨진 간단한 선택기입니다(모델 제품군 + 사용 가능한 공급자).
- `/model <#>` 해당 선택기에서 선택합니다.
- `/model status` 세부 보기(인증 후보 및 구성된 경우 공급자 끝점)입니다. `baseUrl` + `api` 방법).
- 모델 참조는 분할하여 구문 분석됩니다. **첫 번째** `/`. 사용 `provider/model` 타이핑할 때 `/model <ref>`.
- 모델 ID 자체에 다음이 포함된 경우 `/` (OpenRouter 스타일), 공급자 접두사를 포함해야 합니다(예: `/model openrouter/moonshotai/kimi-k2`).
- 공급자를 생략하면 OpenClaw는 입력을 별칭이나 모델로 처리합니다. **기본 공급자** (없을 때만 작동합니다. `/` 모델 ID에서).

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

`openclaw models` (하위 명령 없음)은 다음의 단축키입니다. `models status`.

### `models list`

기본적으로 구성된 모델을 표시합니다. 유용한 플래그:

- `--all`: 전체 카탈로그
- `--local`: 지역 공급자만 해당
- `--provider <name>`: 공급자별로 필터링
- `--plain`: 한 줄에 하나의 모델
- `--json`: 기계 판독 가능 출력

### `models status`

해결된 기본 모델, 대체, 이미지 모델 및 인증 개요를 표시합니다.
구성된 공급자 중 또한 발견된 프로필의 OAuth 만료 상태도 표시합니다.
인증 스토어에서(기본적으로 24시간 이내에 경고) `--plain` 만 인쇄합니다.
해결된 기본 모델.
OAuth 상태는 항상 표시되며 `--json` 산출). 구성된 경우
공급자에게 자격 증명이 없습니다. `models status` 인쇄하다 **인증 누락** 부분.
JSON에는 다음이 포함됩니다. `auth.oauth` (경고 창 + 프로필) 및 `auth.providers`
(공급자당 유효 인증).
사용 `--check` 자동화를 위해(종료 `1` 누락/만료된 경우, `2` 만료 시).

선호하는 Anthropic 인증은 Claude Code CLI 설정 토큰입니다(어디서나 실행 가능, 필요한 경우 게이트웨이 호스트에 붙여넣기).

```bash
claude setup-token
openclaw models status
```

## 스캐닝(OpenRouter 무료 모델)

`openclaw models scan` OpenRouter를 검사합니다. **무료 모델 카탈로그** 그리고 할 수 있다
선택적으로 도구 및 이미지 지원을 위한 프로브 모델.

주요 플래그:

- `--no-probe`: 라이브 프로브 건너뛰기(메타데이터만 해당)
- `--min-params <b>`: 최소 매개변수 크기(십억)
- `--max-age-days <days>`: 이전 모델 건너뛰기
- `--provider <name>`: 공급자 접두사 필터
- `--max-candidates <n>`: 대체 목록 크기
- `--set-default`: 세트 `agents.defaults.model.primary` 첫 번째 선택으로
- `--set-image`: 세트 `agents.defaults.imageModel.primary` 첫 번째 이미지 선택으로

프로브에는 OpenRouter API 키가 필요합니다(인증 프로필 또는
`OPENROUTER_API_KEY`). 열쇠 없이 이용하세요 `--no-probe` 후보자만 나열합니다.

스캔 결과의 순위는 다음과 같습니다.

1. 이미지 지원
2. 도구 대기 시간
3. 컨텍스트 크기
4. 매개변수 개수

입력

- 오픈라우터 `/models` 목록(필터 `:free`)
- 인증 프로필의 OpenRouter API 키가 필요합니다. `OPENROUTER_API_KEY` (보다 [/환경](/help/environment))
- 선택적 필터: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- 프로브 제어: `--timeout`, `--concurrency`

TTY에서 실행할 때 대화형으로 대체를 선택할 수 있습니다. 비대화형
모드, 통과 `--yes` 기본값을 수락합니다.

## 모델 레지스트리(`models.json`)

사용자 지정 공급자 `models.providers` 에 기록됩니다 `models.json` 아래에
에이전트 디렉터리(기본값 `~/.openclaw/agents/<agentId>/models.json`). 이 파일
않는 한 기본적으로 병합됩니다. `models.mode` 로 설정되었습니다 `replace`.
