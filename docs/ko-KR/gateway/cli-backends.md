---
summary: "CLI backends: text-only fallback via local AI CLIs"
read_when:
  - You want a reliable fallback when API providers fail
  - You are running Claude Code CLI or other local AI CLIs and want to reuse them
  - You need a text-only, tool-free path that still supports sessions and images
title: "CLI Backends"
x-i18n:
  source_hash: 8285f4829900bc810b1567264375fa92f3e25aebaee1bddaea4625a51a4e53d7
---

# CLI 백엔드(대체 런타임)

OpenClaw는 API 제공업체가 다운되었을 때 **텍스트 전용 대체**로 **로컬 AI CLI**를 실행할 수 있습니다.
속도가 제한되어 있거나 일시적으로 오작동합니다. 이는 의도적으로 보수적입니다.

- **도구가 비활성화되었습니다**(도구 호출 없음).
- **텍스트 입력 → 텍스트 출력** (신뢰할 수 있음).
- **세션이 지원됩니다**(따라서 후속 조치가 일관되게 유지됩니다).
- CLI가 이미지 경로를 허용하는 경우 **이미지를 통과할 수 있습니다**.

이는 기본 경로가 아닌 **안전망**으로 설계되었습니다. 이럴 때 사용해보세요
외부 API에 의존하지 않고 "항상 작동하는" 텍스트 응답을 원합니다.

## 초보자 친화적인 빠른 시작

**구성 없이** Claude Code CLI를 사용할 수 있습니다(OpenClaw에는 기본 제공 기본값이 제공됨).

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI는 즉시 사용 가능합니다.

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

게이트웨이가 launchd/systemd에서 실행되고 PATH가 최소인 경우
명령 경로:

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

그게 다야. 키가 없으며 CLI 자체 외에 추가 인증 구성이 필요하지 않습니다.

## 대체 수단으로 사용

기본 모델이 실패할 때만 실행되도록 대체 목록에 CLI 백엔드를 추가하세요.

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

- `agents.defaults.models`(허용 목록)을 사용하는 경우 `claude-cli/...`를 포함해야 합니다.
- 기본 공급자가 실패하는 경우(인증, 속도 제한, 시간 초과) OpenClaw는
  다음에는 CLI 백엔드를 사용해 보세요.

## 구성 개요

모든 CLI 백엔드는 다음 위치에 있습니다.

```
agents.defaults.cliBackends
```

각 항목은 **공급자 ID**(예: `claude-cli`, `my-cli`)로 입력됩니다.
공급자 ID는 모델 참조의 왼쪽이 됩니다.

```
<provider>/<model>
```

### 예시 구성

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

1. **제공자 접두사(`claude-cli/...`)를 기반으로 백엔드를 선택합니다**.
2. 동일한 OpenClaw 프롬프트 + 작업 공간 컨텍스트를 사용하여 **시스템 프롬프트를 구축**합니다.
3. 기록이 일관되게 유지되도록 세션 ID(지원되는 경우)를 사용하여 **CLI를 실행**합니다.
4. **출력을 구문 분석**(JSON 또는 일반 텍스트)하고 최종 텍스트를 반환합니다.
5. 백엔드별로 **세션 ID를 유지**하므로 후속 작업에서 동일한 CLI 세션을 재사용합니다.

## 세션

- CLI가 세션을 지원하는 경우 `sessionArg`(예: `--session-id`)를 설정하거나
  `sessionArgs` (자리 표시자 `{sessionId}`) ID를 삽입해야 하는 경우
  여러 플래그로.
- CLI가 다른 플래그와 함께 **resume 하위 명령**을 사용하는 경우
  `resumeArgs` (재개 시 `args` 대체) 및 선택적으로 `resumeOutput`
  (JSON이 아닌 이력서의 경우)
- `sessionMode`:
  - `always`: 항상 세션 ID를 보냅니다(저장된 것이 없으면 새 UUID).
  - `existing`: 이전에 저장된 세션 ID만 보냅니다.
  - `none`: 세션 ID를 보내지 않습니다.

## 이미지(통과)

CLI가 이미지 경로를 허용하는 경우 `imageArg`를 설정합니다.

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw는 base64 이미지를 임시 파일에 기록합니다. `imageArg`가 설정되면
경로는 CLI 인수로 전달됩니다. `imageArg`가 누락된 경우 OpenClaw는
프롬프트에 대한 파일 경로(경로 삽입)는 자동으로 실행되는 CLI에 충분합니다.
일반 경로에서 로컬 파일을 로드합니다(Claude Code CLI 동작).

## 입력/출력

- `output: "json"`(기본값)은 JSON을 구문 분석하고 텍스트 + 세션 ID를 추출하려고 시도합니다.
- `output: "jsonl"`는 JSONL 스트림(Codex CLI `--json`)을 구문 분석하고
  마지막 에이전트 메시지에 `thread_id`를 더합니다.
- `output: "text"`는 stdout을 최종 응답으로 처리합니다.

입력 모드:

- `input: "arg"`(기본값)는 프롬프트를 마지막 CLI 인수로 전달합니다.
- `input: "stdin"`는 stdin을 통해 프롬프트를 보냅니다.
- 프롬프트가 매우 길고 `maxPromptArgChars`가 설정된 경우 stdin이 사용됩니다.

## 기본값(내장)

OpenClaw는 `claude-cli`에 대한 기본값을 제공합니다.

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw는 `codex-cli`에 대한 기본값도 제공합니다.

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

필요한 경우에만 재정의하세요(공통: 절대 `command` 경로).

## 제한사항

- **OpenClaw 도구 없음**(CLI 백엔드는 도구 호출을 수신하지 않습니다). 일부 CLI
  여전히 자체 에이전트 도구를 실행할 수 있습니다.
- **스트리밍 없음**(CLI 출력이 수집된 후 반환됨).
- **구조화된 출력**은 CLI의 JSON 형식에 따라 다릅니다.
- **Codex CLI 세션**은 텍스트 출력(JSONL 없음)을 통해 재개됩니다.
  초기 `--json` 실행보다 구조화되었습니다. OpenClaw 세션은 계속 작동합니다.
  일반적으로.

## 문제 해결

- **CLI를 찾을 수 없음**: `command`를 전체 경로로 설정합니다.
- **잘못된 모델 이름**: `modelAliases`을 사용하여 `provider/model` → CLI 모델을 매핑합니다.
- **세션 연속성 없음**: `sessionArg`가 설정되어 있고 `sessionMode`가 설정되어 있지 않은지 확인하세요.
  `none` (Codex CLI는 현재 JSON 출력으로 재개할 수 없습니다.)
- **이미지 무시됨**: `imageArg`를 설정하고 CLI가 파일 경로를 지원하는지 확인하세요.
