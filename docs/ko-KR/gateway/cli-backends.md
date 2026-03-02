---
summary: "CLI 백엔드: API 공급자 실패 시 로컬 AI CLI를 통한 텍스트 전용 폴백"
read_when:
  - API 공급자가 실패할 때 안정적인 폴백이 필요한 경우
  - 로컬 AI CLI를 실행 중이고 재사용하려는 경우
  - 도구 없는 텍스트 전용 경로가 필요한 경우
title: "CLI 백엔드"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/cli-backends.md
  workflow: 15
---

# CLI 백엔드(폴백 런타임)

OpenClaw는 API 공급자가 다운되었거나, 속도 제한이 있거나, 일시적으로 작동하지 않을 때 **로컬 AI CLI**를 **텍스트 전용 폴백**으로 실행할 수 있습니다. 이는 의도적으로 보수적입니다:

- **도구 비활성화**(도구 호출 없음).
- **텍스트 입력 → 텍스트 출력**(안정적).
- **세션 지원**(후속 차례는 일관성 유지).
- **이미지 통과 가능**(CLI가 이미지 경로를 수락하는 경우).

이는 주요 경로가 아닌 **안전망**으로 설계되었습니다. 외부 API에 의존하지 않고 "항상 작동"하는 텍스트 응답을 원할 때 사용하세요.

## 초보자 친화적 빠른 시작

설정 없이 Claude Code CLI를 사용할 수 있습니다(OpenClaw는 기본 제공 기본값을 제공합니다):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI도 즉시 작동합니다:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

게이트웨이가 launchd/systemd에서 실행되고 PATH가 최소한인 경우 명령 경로만 추가하세요:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

그게 다입니다. 키 또는 추가 인증 설정이 필요하지 않습니다.

## 폴백으로 사용

주요 모델이 실패할 때만 실행되도록 폴백 목록에 CLI 백엔드를 추가하세요:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

참고:

- `agents.defaults.models`를 사용하는 경우(허용 목록) `claude-cli/...`을 포함해야 합니다.
- 주요 공급자가 실패하면(인증, 속도 제한, 시간 초과), OpenClaw가 다음으로 CLI 백엔드를 시도합니다.

## 설정 개요

모든 CLI 백엔드는 다음에 있습니다:

```
agents.defaults.cliBackends
```

각 항목은 **공급자 id**(예: `claude-cli`, `my-cli`)로 키 지정됩니다.
공급자 id는 모델 참조의 왼쪽 측이 됩니다:

```
<provider>/<model>
```

### 예제 구성

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## 작동 방식

1. **공급자 접두사**(예: `claude-cli/...`)를 기반으로 백엔드를 선택합니다.
2. **시스템 프롬프트를 구축**하여 동일한 OpenClaw 프롬프트 + 작업 공간 컨텍스트를 사용합니다.
3. **CLI를 실행**하여 세션 id를 포함합니다(지원되는 경우) 따라서 기록이 일관성 있게 유지됩니다.
4. **출력을 구문 분석**(JSON 또는 일반 텍스트) 최종 텍스트를 반환합니다.
5. **세션 id를 유지**하므로 후속 재개에서 동일한 CLI 세션을 재사용합니다.

## 세션

- CLI가 세션을 지원하면 `sessionArg`(예: `--session-id`) 또는 세션 id를 여러 플래그에 삽입해야 할 때 `sessionArgs`(자리 표시자 `{sessionId}`)를 설정하세요.
- CLI가 다른 플래그를 사용하는 **이력 서브명령**을 사용하는 경우 `resumeArgs`(이력 시 `args` 교체)를 설정하고 선택사항으로 `resumeOutput`을 설정합니다(JSON이 아닌 이력).
- `sessionMode`:
  - `always`: 항상 세션 id를 보냅니다(저장되지 않은 경우 새 UUID).
  - `existing`: 이전에 저장된 세션 id인 경우만 보냅니다.
  - `none`: 세션 id를 보내지 마세요.

## 이미지(통과)

CLI가 이미지 경로를 수락하면 `imageArg`을 설정하세요:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw는 base64 이미지를 임시 파일에 씁니다. `imageArg`이 설정되면 해당 경로가 CLI 인수로 전달됩니다. `imageArg`이 누락된 경우 OpenClaw는 파일 경로를 프롬프트에 추가합니다(경로 주입). 이는 일반 경로에서 로컬 파일을 자동 로드하는 CLI(Claude Code CLI 동작)에 충분합니다.

## 입출력

- `output: "json"` (기본값) JSON을 구문 분석하고 텍스트 + 세션 id를 추출하려고 시도합니다.
- `output: "jsonl"` JSONL 스트림(Codex CLI `--json`)을 구문 분석하고 `thread_id`가 있을 때 마지막 에이전트 메시지를 추출합니다.
- `output: "text"` stdout을 최종 응답으로 취급합니다.

입력 모드:

- `input: "arg"` (기본값) 프롬프트를 마지막 CLI 인수로 전달합니다.
- `input: "stdin"` stdin을 통해 프롬프트를 전송합니다.
- 프롬프트가 매우 길고 `maxPromptArgChars`가 설정된 경우 stdin이 사용됩니다.

## 기본값(기본 제공)

OpenClaw는 `claude-cli`에 기본값을 제공합니다:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw는 또한 `codex-cli`에 기본값을 제공합니다:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

필요한 경우만 재정의하세요(일반적: 절대 `command` 경로).

## 제한 사항

- **OpenClaw 도구 없음**(CLI 백엔드는 절대 도구 호출을 수신하지 않음). 일부 CLI는 여전히 자체 에이전트 도구를 실행할 수 있습니다.
- **스트리밍 없음**(CLI 출력이 수집된 후 반환됨).
- **구조화된 출력은** CLI의 JSON 형식에 따라 다릅니다.
- **Codex CLI 세션은** 텍스트 출력을 통해 재개됩니다(초기 `--json` 실행보다 덜 구조화됨). OpenClaw 세션은 정상적으로 작동합니다.

## 문제 해결

- **CLI를 찾을 수 없음**: `command`를 전체 경로로 설정하세요.
- **잘못된 모델 이름**: `modelAliases`를 사용하여 `provider/model` → CLI 모델을 매핑하세요.
- **세션 연속성 없음**: `sessionArg`이 설정되어 있고 `sessionMode`이 `none`이 아닌지 확인하세요(Codex CLI는 현재 JSON 출력으로 재개할 수 없음).
- **이미지가 무시됨**: `imageArg`을 설정하고 CLI가 파일 경로를 지원하는지 확인하세요.
