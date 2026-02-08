---
read_when:
    - API 공급자가 실패할 경우 안정적인 대체를 원합니다.
    - Claude Code CLI 또는 기타 로컬 AI CLI를 실행 중이며 이를 재사용하고 싶습니다.
    - 세션과 이미지를 계속 지원하는 도구가 필요 없는 텍스트 전용 경로가 필요합니다.
summary: 'CLI 백엔드: 로컬 AI CLI를 통한 텍스트 전용 대체'
title: CLI 백엔드
x-i18n:
    generated_at: "2026-02-08T15:53:32Z"
    model: gtx
    provider: google-translate
    source_hash: 8285f4829900bc810b1567264375fa92f3e25aebaee1bddaea4625a51a4e53d7
    source_path: gateway/cli-backends.md
    workflow: 15
---

# CLI 백엔드(대체 런타임)

OpenClaw를 실행할 수 있습니다 **로컬 AI CLI** 로서 **텍스트 전용 대체** API 제공업체가 다운되면
속도가 제한되어 있거나 일시적으로 오작동합니다. 이는 의도적으로 보수적입니다.

- **도구가 비활성화되었습니다.** (도구 호출 없음).
- **텍스트 입력 → 텍스트 출력** (믿을 수 있는).
- **세션이 지원됩니다** (따라서 후속 조치는 일관성을 유지합니다).
- **이미지는 통과될 수 있습니다** CLI가 이미지 경로를 허용하는 경우.

이것은 다음과 같이 설계되었습니다. **안전망** 기본 경로가 아닌 이럴 때 사용해보세요
외부 API에 의존하지 않고 "항상 작동하는" 텍스트 응답을 원합니다.

## 초보자 친화적인 빠른 시작

클로드 코드 CLI를 사용할 수 있습니다 **아무런 구성 없이** (OpenClaw에는 기본 제공되는 기본값이 제공됩니다):

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

- 당신이 사용하는 경우 `agents.defaults.models` (허용 목록)에는 다음을 포함해야 합니다. `claude-cli/...`.
- 기본 공급자가 실패하면(인증, 속도 제한, 시간 초과) OpenClaw는
  다음에는 CLI 백엔드를 사용해 보세요.

## 구성 개요

모든 CLI 백엔드는 다음 위치에 있습니다.

```
agents.defaults.cliBackends
```

각 항목의 키는 다음과 같습니다. **공급자 ID** (예: `claude-cli`, `my-cli`).
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

## 작동 원리

1. **백엔드를 선택합니다.** 공급자 접두사(`claude-cli/...`).
2. **시스템 프롬프트를 구축합니다.** 동일한 OpenClaw 프롬프트 + 작업 공간 컨텍스트를 사용합니다.
3. **CLI 실행** 세션 ID(지원되는 경우)를 사용하면 기록이 일관되게 유지됩니다.
4. **출력을 구문 분석합니다.** (JSON 또는 일반 텍스트) 최종 텍스트를 반환합니다.
5. **세션 ID 유지** 백엔드당이므로 후속 조치에서는 동일한 CLI 세션을 재사용합니다.

## 세션

- CLI가 세션을 지원하는 경우 다음을 설정하십시오. `sessionArg` (예: `--session-id`) 또는
  `sessionArgs` (자리 표시자 `{sessionId}`) ID를 삽입해야 하는 경우
  여러 플래그로.
- CLI가 **재개 하위 명령** 다른 플래그로 설정
  `resumeArgs` (대체 `args` 재개할 때) 그리고 선택적으로 `resumeOutput`
  (JSON이 아닌 이력서의 경우)
- `sessionMode`:
  - `always`: 항상 세션 ID를 보냅니다(저장된 것이 없으면 새 UUID).
  - `existing`: 이전에 세션 ID가 저장된 경우에만 세션 ID를 보냅니다.
  - `none`: 세션 ID를 보내지 마십시오.

## 이미지(통과)

CLI가 이미지 경로를 허용하는 경우 다음을 설정하십시오. `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw는 base64 이미지를 임시 파일에 기록합니다. 만약에 `imageArg` 설정되어 있습니다.
경로는 CLI 인수로 전달됩니다. 만약에 `imageArg` 누락된 경우 OpenClaw는
프롬프트에 대한 파일 경로(경로 삽입)는 자동으로 실행되는 CLI에 충분합니다.
일반 경로에서 로컬 파일을 로드합니다(Claude Code CLI 동작).

## 입력 / 출력

- `output: "json"` (기본값) JSON을 구문 분석하고 텍스트 + 세션 ID를 추출하려고 시도합니다.
- `output: "jsonl"` JSONL 스트림을 구문 분석합니다(Codex CLI `--json`)를 추출하고
  마지막 상담원 메시지 플러스 `thread_id` 존재할 때.
- `output: "text"` stdout을 최종 응답으로 처리합니다.

입력 모드:

- `input: "arg"` (기본값) 프롬프트를 마지막 CLI 인수로 전달합니다.
- `input: "stdin"` stdin을 통해 프롬프트를 보냅니다.
- 프롬프트가 너무 길고 `maxPromptArgChars` 설정되면 stdin이 사용됩니다.

## 기본값(내장)

OpenClaw는 다음을 위한 기본값을 제공합니다. `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw는 또한 다음을 위한 기본값을 제공합니다. `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

필요한 경우에만 재정의(공통: 절대 `command` 길).

## 제한사항

- **OpenClaw 도구 없음** (CLI 백엔드는 도구 호출을 수신하지 않습니다). 일부 CLI
  여전히 자체 에이전트 도구를 실행할 수 있습니다.
- **스트리밍 없음** (CLI 출력이 수집된 후 반환됩니다.)
- **구조화된 출력** CLI의 JSON 형식에 따라 달라집니다.
- **Codex CLI 세션** 텍스트 출력(JSONL 없음)을 통해 재개합니다.
  초기보다 구조화 `--json` 달리다. OpenClaw 세션은 계속 작동합니다.
  일반적으로.

## 문제 해결

- **CLI를 찾을 수 없습니다**: 세트 `command` 전체 경로로.
- **잘못된 모델 이름**: 사용 `modelAliases` 지도에 `provider/model` → CLI 모델.
- **세션 연속성 없음**: 보장하다 `sessionArg` 설정되어 있으며 `sessionMode` 아니다
  `none` (Codex CLI는 현재 JSON 출력으로 재개할 수 없습니다.)
- **이미지가 무시됨**: 세트 `imageArg` (그리고 CLI가 파일 경로를 지원하는지 확인하십시오).
