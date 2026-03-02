---
summary: "OpenClaw system 프롬프트가 포함하는 것 및 어떻게 assembled되는지"
read_when:
  - System prompt 텍스트, 도구 리스트, 또는 time/heartbeat 섹션을 편집할 때
  - Workspace bootstrap 또는 스킬 injection 동작을 변경할 때
title: "시스템 프롬프트"
---

# 시스템 프롬프트

OpenClaw는 모든 에이전트 실행을 위해 custom system 프롬프트를 빌드합니다. 프롬프트는 **OpenClaw-owned**이고 pi-coding-agent default 프롬프트를 사용하지 않습니다.

프롬프트는 OpenClaw에 의해 assembled되고 각 에이전트 실행에 inject됩니다.

## 구조

프롬프트는 intentionally compact이고 fixed sections을 사용합니다:

- **Tooling**: 현재 도구 리스트 + short 설명.
- **Safety**: power-seeking 동작 또는 oversight bypassing을 피하도록 short guardrail reminder.
- **스킬** (사용 가능할 때): 모델에 how to load skill instructions on demand를 알려줍니다.
- **OpenClaw Self-Update**: `config.apply` 및 `update.run`을 실행하는 방법.
- **Workspace**: 작업 디렉토리 (`agents.defaults.workspace`).
- **Documentation**: local path to OpenClaw 문서 (repo 또는 npm 패키지) 및 when to read them.
- **Workspace 파일 (injected)**: bootstrap files이 아래에 포함된다는 것을 나타냅니다.
- **Sandbox** (활성화될 때): sandboxed runtime, sandbox paths, 및 whether elevated exec이 사용 가능한지를 나타냅니다.
- **현재 날짜 & 시간**: user-local 시간, 시간대, time format.
- **응답 태그**: 지원되는 providers에 대한 optional reply tag 구문.
- **Heartbeats**: heartbeat 프롬프트 및 ack 동작.
- **Runtime**: host, OS, node, model, repo root (감지된 경우), thinking level (한 라인).
- **Reasoning**: 현재 visibility level + /reasoning toggle hint.

System prompt의 Safety guardrails은 advisory입니다. 이들은 모델 동작을 guide합니다 하지만 정책을 enforce하지 않습니다. Hard enforcement에는 tool 정책, exec approvals, sandboxing, 및 channel allowlists를 사용합니다; operators는 설계별로 이들을 비활성화할 수 있습니다.

## 프롬프트 모드

OpenClaw는 sub-agents에 대해 더 작은 system 프롬프트를 render할 수 있습니다. 런타임은 각 run에 대해 `promptMode`를 설정합니다 (user-facing config가 아님):

- `full` (기본값): 위의 모든 섹션을 포함합니다.
- `minimal`: sub-agents에 사용됩니다; **스킬**, **메모리 Recall**, **OpenClaw Self-Update**, **모델 별칭**, **사용자 Identity**, **응답 태그**, **메시징**, **Silent 응답**, 및 **Heartbeats**를 omit합니다. Tooling, **Safety**, Workspace, Sandbox, Current Date & Time (알려진 경우), Runtime, 및 injected context은 available합니다.
- `none`: 베이스 identity line만 반환합니다.

`promptMode=minimal`일 때, extra injected 프롬프트는 **Group Chat Context** 대신 **Subagent Context**로 labeled됩니다.

## Workspace bootstrap injection

Bootstrap 파일은 trimmed되고 **Project Context** 아래 appended되어 모델이 explicit reads를 필요로 하지 않고 identity 및 profile context를 봅니다:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (brand-new workspaces에만)
- `MEMORY.md` 및/또는 `memory.md` (workspace에 present할 때; 하나 또는 둘 다 주입될 수 있음)

이들 파일은 모두 **context window에 inject**되므로, 이들은 토큰을 소비합니다. 이들을 concise하게 유지하세요 — 특히 `MEMORY.md`, 시간이 지남에 따라 grow할 수 있고 예상치 못한 높은 context usage 및 더 frequent compaction을 lead할 수 있습니다.

> **주:** `memory/*.md` daily files는 **자동으로 inject**되지 않습니다. `memory_search` 및 `memory_get` 도구를 통해 on demand로 accessed되므로, context window에 count되지 않습니다 unless 모델이 explicitly reads them.

큰 파일은 marker로 truncated됩니다. Per-file max size는 `agents.defaults.bootstrapMaxChars` (기본값: 20000)에 의해 제어됩니다. Total injected bootstrap content는 `agents.defaults.bootstrapTotalMaxChars` (기본값: 150000)에 의해 capped됩니다. 누락된 파일은 short missing-file marker를 inject합니다.

Sub-agent sessions은 오직 `AGENTS.md` 및 `TOOLS.md`만 inject합니다 (다른 bootstrap 파일은 sub-agent context를 작게 유지하기 위해 filtered out됩니다).

Internal hooks는 `agent:bootstrap`을 통해 이 step을 intercept할 수 있습니다mutate 또는 inject된 bootstrap 파일을 replace합니다 (예: alternate persona에 대해 `SOUL.md`를 swap).

각 injected 파일이 얼마나 contribute하는지 검사하려면 (raw vs injected, truncation, plus tool schema overhead), `/context list` 또는 `/context detail`를 사용합니다. [컨텍스트](/concepts/context) 참조.

## 시간 처리

System prompt는 user timezone이 알려져 있을 때 dedicated **Current Date & Time** 섹션을 포함합니다. Prompt cache를 stable하게 유지하기 위해, 이제는 **time zone**만 포함합니다 (no dynamic clock 또는 time format).

에이전트가 current time이 필요할 때 `session_status`를 사용합니다; status card는 timestamp line을 포함합니다.

다음으로 설정합니다:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

전체 동작 세부정보는 [날짜 & 시간](/date-time)을 참조합니다.

## 스킬

Eligible 스킬이 존재할 때, OpenClaw는 compact **available 스킬 리스트**를 inject합니다 (`formatSkillsForPrompt`) that includes 각 스킬의 **파일 경로**. 프롬프트는 listed location (workspace, managed, 또는 bundled)에서 스킬의 `SKILL.md`를 `read`하도록 모델을 instruct합니다. Eligible 스킬이 없으면, Skills section은 omitted됩니다.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

이는 base prompt를 작게 유지하면서 여전히 targeted skill usage를 enable합니다.

## Documentation

Available할 때, system prompt는 local OpenClaw docs directory를 가리키는 **Documentation** section를 포함합니다 (repo workspace의 `docs/` 또는 bundled npm 패키지 docs) 그리고 또한 public mirror, source repo, community Discord, 및 ClawHub ([https://clawhub.com](https://clawhub.com))를 notes합니다 skills discovery에 대해. 프롬프트는 OpenClaw 동작, 명령어, 설정, 또는 architecture를 위해 local docs를 먼저 consult하도록 모델을 instruct합니다, 그리고 `openclaw status`를 자체 실행합니다 (access가 없을 때만 사용자에게 asking).
