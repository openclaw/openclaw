---
summary: "Agent runtime (embedded pi-mono), workspace contract, and session bootstrap"
read_when:
  - Changing agent runtime, workspace bootstrap, or session behavior
title: "Agent Runtime"
---

# Agent Runtime 🤖

OpenClaw는 **pi-mono**에서 파생된 단일 임베디드 에이전트 런타임을 운영합니다.

## Workspace (required)

OpenClaw는 하나의 에이전트 워크스페이스 디렉토리(`agents.defaults.workspace`)를 에이전트의 **유일한** 작업 디렉토리(`cwd`)로 사용하여 도구와 컨텍스트를 제공합니다.

권장: `openclaw setup`를 사용하여 누락된 경우 `~/.openclaw/openclaw.json`을 생성하고 워크스페이스 파일을 초기화합니다.

전체 워크스페이스 레이아웃 + 백업 가이드: [에이전트 워크스페이스](/ko-KR/concepts/agent-workspace)

`agents.defaults.sandbox`가 활성화된 경우, 비주요 세션은 `agents.defaults.sandbox.workspaceRoot` 아래의 세션 별 워크스페이스로 이 값을 재정의할 수 있습니다 (참조 [게이트웨이 구성](/ko-KR/gateway/configuration)).

## Bootstrap files (injected)

`agents.defaults.workspace` 내에서, OpenClaw는 다음의 사용자가 편집 가능한 파일을 기대합니다:

- `AGENTS.md` — 운영 지침 + "메모리"
- `SOUL.md` — 페르소나, 경계, 톤
- `TOOLS.md` — 사용자 유지 관리 도구 노트 (예: `imsg`, `sag`, 규칙)
- `BOOTSTRAP.md` — 일회성 첫 실행 의식 (완료 후 삭제됨)
- `IDENTITY.md` — 에이전트 이름/분위기/이모지
- `USER.md` — 사용자 프로필 + 선호 주소

새 세션의 첫 턴에, OpenClaw는 이 파일들의 내용을 에이전트 컨텍스트에 직접 주입합니다.

빈 파일은 건너뜁니다. 큰 파일은 잘리고 트림되어 마커와 함께 삽입되므로 프롬프트가 가볍게 유지됩니다 (전체 내용을 읽으려면 파일을 확인하세요).

파일이 누락된 경우, OpenClaw는 "파일 누락" 마커 한 줄을 주입합니다 (그리고 `openclaw setup`가 안전한 기본 템플릿을 생성합니다).

`BOOTSTRAP.md`는 **완전히 새로운 워크스페이스**에만 생성됩니다 (다른 부트스트랩 파일이 존재하지 않을 경우). 의식을 완료한 후 이를 삭제하면 나중에 다시 시작할 때 재생성되지 않습니다.

부트스트랩 파일 생성을 완전히 비활성화하려면 (사전 시드된 워크스페이스의 경우), 다음과 같이 설정합니다:

```json5
{ agent: { skipBootstrap: true } }
```

## Built-in tools

핵심 도구들 (읽기/실행/편집/쓰기 및 관련 시스템 도구들)은 항상 사용 가능하며, 도구 정책에 따릅니다. `apply_patch`는 선택 사항이며 `tools.exec.applyPatch`에 의해 제한됩니다. `TOOLS.md`는 어떤 도구가 존재하는지를 제어하지 않습니다; 이는 당신이 그들을 어떻게 사용하길 원하는지에 대한 지침입니다.

## Skills

OpenClaw는 세 곳에서 스킬을 로드합니다 (이름 충돌 시 워크스페이스가 우선):

- 번들 (설치와 함께 제공됨)
- 관리형/지역: `~/.openclaw/skills`
- 워크스페이스: `<workspace>/skills`

스킬은 설정/환경 변수에 의해 제한될 수 있습니다 (참조 `skills` [게이트웨이 구성](/ko-KR/gateway/configuration)).

## pi-mono integration

OpenClaw는 pi-mono 코드베이스의 일부(모델/도구)를 재사용하지만, **세션 관리, 디스커버리, 도구 연결은 OpenClaw가 소유**합니다.

- pi-코딩 에이전트 런타임 없음.
- `~/.pi/agent` 또는 `<workspace>/.pi` 설정은 참조되지 않습니다.

## Sessions

세션 기록은 JSONL로 저장됩니다:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

세션 ID는 고정되며 OpenClaw에 의해 선택됩니다.
기존 Pi/Tau 세션 폴더는 **읽히지 않습니다**.

## Steering while streaming

큐 모드가 `steer`일 때, 들어오는 메시지는 현재 실행에 주입됩니다. 큐는 **각 도구 호출 후** 검사됩니다; 대기 중인 메시지가 있는 경우, 현재 보조 메시지의 나머지 도구 호출은 건너뛰어 ("대기 중인 사용자 메시지로 인해 건너뜀."이라는 오류 도구 결과와 함께), 다음 보조 응답 전까지 대기 중인 사용자 메시지가 주입됩니다.

큐 모드가 `followup` 또는 `collect`일 때, 들어오는 메시지는 현재 턴이 종료될 때까지 보류된 다음, 대기 중인 페이로드와 함께 새 에이전트 턴이 시작됩니다. 모드 + 디바운스/캡 동작에 대해 [큐](/ko-KR/concepts/queue)를 참조하세요.

블록 스트리밍은 완료된 보조 블록을 완료되자마자 보냅니다; 기본값으로는 **꺼져 있습니다** (`agents.defaults.blockStreamingDefault: "off"`).
경계를 `agents.defaults.blockStreamingBreak`를 통해 조정합니다 (`text_end` vs `message_end`; 기본값은 text_end).
소프트 블록 청킹은 `agents.defaults.blockStreamingChunk`를 통해 제어합니다 (기본값은 800–1200 자; 단락 구분을 우선으로 하고, 그 다음 줄바꿈; 마지막으로 문장).
스트리밍된 청크를 `agents.defaults.blockStreamingCoalesce`로 결합하여 단일 라인 스팸을 줄입니다 (보내기 전 유휴 기반 병합). Telegram이 아닌 채널은 블록 응답을 활성화하려면 명시적으로 `*.blockStreaming: true`가 필요합니다.
이용 가능한 경우 도구 시작 시 자세한 도구 요약이 제공됩니다 (디바운스 없음); Control UI는 에이전트 이벤트를 통해 도구 출력을 스트리밍합니다.
더 많은 세부사항: [Streaming + chunking](/ko-KR/concepts/streaming).

## Model refs

설정에서의 모델 참조(예: `agents.defaults.model` 및 `agents.defaults.models`)는 **첫 번째** `/`에서 분리하여 해석됩니다.

- 모델을 구성할 때 `provider/model`을 사용하세요.
- 모델 ID 자체가 `/`을 포함하는 경우 (OpenRouter 스타일), 프로바이더 접두사를 포함하세요 (예: `openrouter/moonshotai/kimi-k2`).
- 프로바이더를 생략하면, OpenClaw는 입력을 **기본 프로바이더**의 별칭이나 모델로 처리합니다 (모델 ID에 `/`이 없을 때만 작동).

## Configuration (minimal)

최소한 다음을 설정하세요:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (강력히 권장됨)

---

_Next: [Group Chats](/ko-KR/channels/group-messages)_ 🦞