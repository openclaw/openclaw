---
summary: "CLI 백엔드: 로컬 AI CLI를 통한 텍스트 전용 폴백"
read_when:
  - API 프로바이더가 실패할 때 신뢰할 수 있는 폴백을 원할 때
  - Claude Code CLI 또는 다른 로컬 AI CLI를 실행 중이며 재사용하고 싶을 때
  - 세션과 이미지를 지원하면서 도구 없이 텍스트 전용 경로가 필요할 때
title: "CLI 백엔드"
---

# CLI 백엔드 (폴백 런타임)

OpenClaw는 API 프로바이더가 다운되거나, 속도 제한에 걸리거나, 일시적으로 오작동할 때
**로컬 AI CLI**를 **텍스트 전용 폴백**으로 실행할 수 있습니다.
이 방식은 의도적으로 보수적입니다:

- **도구가 비활성화**됩니다 (도구 호출 없음).
- **텍스트 입력 → 텍스트 출력** (안정적).
- **세션이 지원됩니다** (후속 대화가 일관성 있게 유지됨).
- CLI가 이미지 경로를 수용하면 **이미지를 전달**할 수 있습니다.

이는 외부 API에 의존하지 않고 "항상 작동하는" 텍스트 응답을 원할 때 사용하는
**안전망**으로 설계되었습니다.

## 초보자를 위한 빠른 시작

Claude Code CLI는 **설정 없이** 바로 사용 가능합니다 (OpenClaw에 내장 기본값이 포함됨):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI도 바로 동작합니다:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

게이트웨이가 launchd/systemd 하에서 실행되고 PATH가 최소화된 경우, 명령어 경로만 추가하면 됩니다:

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

이게 전부입니다. CLI 자체 외에 추가 키나 인증 설정이 필요 없습니다.

## 폴백으로 사용하기

기본 모델이 실패할 때만 CLI 백엔드가 실행되도록 폴백 목록에 추가합니다:

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

주의사항:

- `agents.defaults.models` (허용 목록)을 사용하는 경우, `claude-cli/...`를 포함해야 합니다.
- 기본 프로바이더가 실패하면 (인증, 속도 제한, 타임아웃), OpenClaw는 다음으로 CLI 백엔드를 시도합니다.

## 설정 개요

모든 CLI 백엔드는 다음 위치에 있습니다:

```
agents.defaults.cliBackends
```

각 항목은 **프로바이더 id** (예: `claude-cli`, `my-cli`)를 키로 합니다.
프로바이더 id는 모델 참조(model ref)의 왼쪽이 됩니다:

```
<provider>/<model>
```

### 설정 예시

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

## 동작 방식

1. 프로바이더 접두사 (`claude-cli/...`)를 기반으로 **백엔드를 선택**합니다.
2. 동일한 OpenClaw 프롬프트 + 작업 공간 컨텍스트를 사용하여 **시스템 프롬프트를 구성**합니다.
3. 히스토리가 일관되도록 세션 id를 포함하여 **CLI를 실행**합니다 (지원되는 경우).
4. 출력을 **파싱** (JSON 또는 일반 텍스트)하고 최종 텍스트를 반환합니다.
5. 후속 요청이 동일한 CLI 세션을 재사용할 수 있도록 백엔드별로 **세션 id를 유지**합니다.

## 세션

- CLI가 세션을 지원하면 `sessionArg` (예: `--session-id`)를 설정하거나,
  ID를 여러 플래그에 삽입해야 할 때는 `sessionArgs` (플레이스홀더 `{sessionId}`)를 설정합니다.
- CLI가 다른 플래그를 가진 **재개 서브커맨드(resume subcommand)**를 사용하는 경우,
  `resumeArgs` (재개 시 `args`를 대체)와 선택적으로 `resumeOutput` (비JSON 재개용)을 설정합니다.
- `sessionMode`:
  - `always`: 항상 세션 id 전송 (저장된 것이 없으면 새 UUID 사용).
  - `existing`: 이전에 저장된 세션 id가 있을 때만 전송.
  - `none`: 세션 id를 절대 전송하지 않음.

## 이미지 (전달)

CLI가 이미지 경로를 수용하는 경우, `imageArg`를 설정합니다:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw는 base64 이미지를 임시 파일에 씁니다. `imageArg`가 설정된 경우, 해당 경로가 CLI 인수로
전달됩니다. `imageArg`가 없으면 OpenClaw는 파일 경로를 프롬프트에 추가합니다 (경로 주입 방식),
이는 일반 경로에서 로컬 파일을 자동으로 로드하는 CLI (Claude Code CLI 동작)에 충분합니다.

## 입력 / 출력

- `output: "json"` (기본값): JSON을 파싱하여 텍스트 + 세션 id를 추출합니다.
- `output: "jsonl"`: JSONL 스트림을 파싱 (Codex CLI `--json`)하여 마지막 에이전트 메시지와
  `thread_id` (있는 경우)를 추출합니다.
- `output: "text"`: stdout을 최종 응답으로 처리합니다.

입력 모드:

- `input: "arg"` (기본값): 프롬프트를 마지막 CLI 인수로 전달합니다.
- `input: "stdin"`: stdin을 통해 프롬프트를 전송합니다.
- 프롬프트가 매우 길고 `maxPromptArgChars`가 설정된 경우, stdin이 사용됩니다.

## 기본값 (내장)

OpenClaw는 `claude-cli`에 대한 기본값을 내장합니다:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw는 `codex-cli`에 대한 기본값도 내장합니다:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

필요한 경우에만 재정의하세요 (흔한 경우: 절대 `command` 경로 지정).

## 제한 사항

- **OpenClaw 도구 없음** (CLI 백엔드는 도구 호출을 받지 않음). 일부 CLI는
  자체 에이전트 도구를 실행할 수 있습니다.
- **스트리밍 없음** (CLI 출력이 수집된 후 반환됨).
- **구조화된 출력**은 CLI의 JSON 형식에 따라 다릅니다.
- **Codex CLI 세션**은 텍스트 출력으로 재개됩니다 (JSONL 없음), 초기 `--json` 실행보다
  덜 구조화되어 있습니다. OpenClaw 세션은 정상적으로 작동합니다.

## 문제 해결

- **CLI를 찾을 수 없음**: `command`를 전체 경로로 설정하세요.
- **잘못된 모델 이름**: `modelAliases`를 사용하여 `provider/model` → CLI 모델로 매핑하세요.
- **세션 연속성 없음**: `sessionArg`가 설정되어 있고 `sessionMode`가 `none`이 아닌지 확인하세요
  (Codex CLI는 현재 JSON 출력으로 재개할 수 없음).
- **이미지 무시됨**: `imageArg`를 설정하세요 (그리고 CLI가 파일 경로를 지원하는지 확인하세요).
