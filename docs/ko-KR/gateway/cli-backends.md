---
summary: "CLI 백엔드: 로컬 AI CLI를 통한 텍스트 전용 폴백"
read_when:
  - API 프로바이더 실패 시 안정적인 폴백이 필요할 때
  - Claude Code CLI 또는 다른 로컬 AI CLI를 실행하고 재사용하고 싶을 때
  - 세션과 이미지를 지원하면서 도구 없는 텍스트 전용 경로가 필요할 때
title: "CLI 백엔드"
x-i18n:
  source_path: docs/gateway/cli-backends.md
---

# CLI 백엔드 (폴백 런타임)

OpenClaw은 API 프로바이더가 다운되거나, 속도 제한이 걸리거나, 일시적으로 오작동할 때 **텍스트 전용 폴백**으로 **로컬 AI CLI**를 실행할 수 있습니다. 이것은 의도적으로 보수적입니다:

- **도구가 비활성화됩니다** (도구 호출 없음).
- **텍스트 입력 → 텍스트 출력** (안정적).
- **세션이 지원됩니다** (후속 턴이 일관성을 유지).
- **이미지를 전달할 수 있습니다** (CLI가 이미지 경로를 허용하는 경우).

이것은 기본 경로가 아닌 **안전망**으로 설계되었습니다. 외부 API에 의존하지 않고 "항상 작동하는" 텍스트 응답이 필요할 때 사용합니다.

## 초보자 친화적 빠른 시작

설정 없이 Claude Code CLI를 사용할 수 있습니다 (OpenClaw에 기본값이 내장됨):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI도 바로 사용 가능합니다:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.4
```

Gateway가 launchd/systemd에서 실행되고 PATH가 최소인 경우, 명령 경로만 추가합니다:

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

이것으로 끝입니다. CLI 자체 외에 키나 추가 인증 설정이 필요하지 않습니다.

## 폴백으로 사용

CLI 백엔드를 폴백 목록에 추가하여 기본 모델이 실패할 때만 실행되도록 합니다:

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

- `agents.defaults.models` (허용 목록)를 사용하는 경우, `claude-cli/...`를 포함해야 합니다.
- 기본 프로바이더가 실패하면 (인증, 속도 제한, 시간 초과), OpenClaw은 다음으로 CLI 백엔드를 시도합니다.

## 설정 개요

모든 CLI 백엔드는 다음 아래에 있습니다:

```
agents.defaults.cliBackends
```

각 항목은 **프로바이더 ID** (예: `claude-cli`, `my-cli`)로 키가 지정됩니다.
프로바이더 ID는 모델 참조의 왼쪽이 됩니다:

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
            "claude-opus-4-6": "opus",
            "claude-sonnet-4-6": "sonnet",
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

1. 프로바이더 접두사 (`claude-cli/...`)를 기반으로 **백엔드를 선택**합니다.
2. 동일한 OpenClaw 프롬프트 + 워크스페이스 컨텍스트를 사용하여 **시스템 프롬프트를 빌드**합니다.
3. 세션 ID (지원되는 경우)로 **CLI를 실행**하여 기록이 일관되게 유지됩니다.
4. **출력을 파싱** (JSON 또는 일반 텍스트)하고 최종 텍스트를 반환합니다.
5. 백엔드별로 **세션 ID를 유지**하여 후속 호출이 동일한 CLI 세션을 재사용합니다.

## 세션

- CLI가 세션을 지원하면 `sessionArg` (예: `--session-id`)를 설정하거나, ID가 여러 플래그에 삽입되어야 할 때 `sessionArgs` (플레이스홀더 `{sessionId}`)를 설정합니다.
- CLI가 다른 플래그를 가진 **이력 재개 부명령**을 사용하면 `resumeArgs` (재개 시 `args` 대체)를 설정하고 선택적으로 `resumeOutput` (비 JSON 재개용)을 설정합니다.
- `sessionMode`:
  - `always`: 항상 세션 ID를 전송합니다 (저장된 것이 없으면 새 UUID).
  - `existing`: 이전에 저장된 것이 있을 때만 세션 ID를 전송합니다.
  - `none`: 세션 ID를 전송하지 않습니다.

## 이미지 (패스스루)

CLI가 이미지 경로를 허용하면 `imageArg`를 설정합니다:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw은 base64 이미지를 임시 파일에 씁니다. `imageArg`가 설정되면 해당 경로가 CLI 인수로 전달됩니다. `imageArg`가 없으면 OpenClaw은 프롬프트에 파일 경로를 추가합니다 (경로 삽입). 이는 일반 경로에서 로컬 파일을 자동 로드하는 CLI에 충분합니다 (Claude Code CLI 동작).

## 입력 / 출력

- `output: "json"` (기본값)은 JSON을 파싱하고 텍스트 + 세션 ID를 추출합니다.
- `output: "jsonl"`은 JSONL 스트림 (Codex CLI `--json`)을 파싱하고 마지막 에이전트 메시지와 존재하는 경우 `thread_id`를 추출합니다.
- `output: "text"`는 stdout을 최종 응답으로 취급합니다.

입력 모드:

- `input: "arg"` (기본값)는 프롬프트를 마지막 CLI 인수로 전달합니다.
- `input: "stdin"`은 stdin을 통해 프롬프트를 전송합니다.
- 프롬프트가 매우 길고 `maxPromptArgChars`가 설정된 경우 stdin이 사용됩니다.

## 기본값 (내장)

OpenClaw은 `claude-cli`에 대한 기본값을 제공합니다:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw은 `codex-cli`에 대한 기본값도 제공합니다:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

필요한 경우에만 재정의합니다 (일반적: 절대 `command` 경로).

## 제한 사항

- **OpenClaw 도구 없음** (CLI 백엔드는 도구 호출을 받지 않음). 일부 CLI는 자체 에이전트 도구를 실행할 수 있습니다.
- **스트리밍 없음** (CLI 출력이 수집된 후 반환됨).
- **구조화된 출력**은 CLI의 JSON 형식에 따라 다릅니다.
- **Codex CLI 세션**은 텍스트 출력으로 재개합니다 (JSONL 아님), 이는 초기 `--json` 실행보다 덜 구조화됩니다. OpenClaw 세션은 여전히 정상적으로 작동합니다.

## 문제 해결

- **CLI를 찾을 수 없음**: `command`를 전체 경로로 설정합니다.
- **잘못된 모델 이름**: `modelAliases`를 사용하여 `provider/model` → CLI 모델을 매핑합니다.
- **세션 연속성 없음**: `sessionArg`가 설정되고 `sessionMode`가 `none`이 아닌지 확인합니다 (Codex CLI는 현재 JSON 출력으로 재개할 수 없음).
- **이미지 무시됨**: `imageArg`를 설정합니다 (CLI가 파일 경로를 지원하는지 확인).
