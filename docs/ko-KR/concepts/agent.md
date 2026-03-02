---
summary: "에이전트 런타임 (embedded pi-mono), 워크스페이스 계약, 세션 부트스트랩"
read_when:
  - 에이전트 런타임, 워크스페이스 부트스트랩, 또는 세션 동작을 변경할 때
title: "에이전트 런타임"
---

# 에이전트 런타임 🤖

OpenClaw는 **pi-mono**에서 파생된 단일 embedded 에이전트 런타임을 실행합니다.

## 워크스페이스 (필수)

OpenClaw는 단일 에이전트 워크스페이스 디렉토리 (`agents.defaults.workspace`)를 에이전트의 **유일한** 작업 디렉토리 (`cwd`)로 도구 및 컨텍스트용으로 사용합니다.

권장: `openclaw setup`을 사용하여 누락된 경우 `~/.openclaw/openclaw.json`을 생성하고 워크스페이스 파일을 초기화하십시오.

전체 워크스페이스 레이아웃 및 백업 가이드: [에이전트 워크스페이스](/concepts/agent-workspace)

`agents.defaults.sandbox`가 활성화된 경우, non-main 세션은 `agents.defaults.sandbox.workspaceRoot`에서 세션별 워크스페이스로 이를 재정의할 수 있습니다 ([게이트웨이 설정](/gateway/configuration) 참조).

## 부트스트랩 파일 (주입됨)

`agents.defaults.workspace` 내에서 OpenClaw는 다음 사용자 편집 파일을 예상합니다:

- `AGENTS.md` — 작동 지침 + "메모리"
- `SOUL.md` — 페르소나, 경계, 톤
- `TOOLS.md` — 사용자 관리 도구 노트 (예: `imsg`, `sag`, 규칙)
- `BOOTSTRAP.md` — 일회성 첫 실행 의식 (완료 후 삭제됨)
- `IDENTITY.md` — 에이전트 이름/분위기/이모지
- `USER.md` — 사용자 프로필 + 선호 주소

새 세션의 첫 번째 턴에서 OpenClaw는 이러한 파일의 내용을 에이전트 컨텍스트에 직접 주입합니다.

빈 파일은 건너뜁니다. 큰 파일은 프롬프트를 간결하게 유지하기 위해 마커로 트림 및 잘립니다 (전체 콘텐츠는 파일을 읽으세요).

파일이 누락된 경우 OpenClaw는 단일 "missing file" 마커 라인을 주입합니다 (`openclaw setup`은 안전한 기본 템플릿을 생성합니다).

`BOOTSTRAP.md`는 **새로운 워크스페이스** (다른 부트스트랩 파일이 없을 때)에만 생성됩니다. 의식 완료 후 삭제하면 나중에 재시작할 때 재생성되지 않아야 합니다.

부트스트랩 파일 생성을 완전히 비활성화하려면 (사전 시드된 워크스페이스의 경우):

```json5
{ agent: { skipBootstrap: true } }
```

## 내장 도구

핵심 도구 (read/exec/edit/write 및 관련 시스템 도구)는 항상 사용 가능하며, 도구 정책에 따릅니다. `apply_patch`는 선택사항이며 `tools.exec.applyPatch`로 제어됩니다. `TOOLS.md`는 어떤 도구가 존재하는지 제어하지 **않습니다**; 이것은 *당신*이 이를 사용하는 방법에 대한 지침입니다.

## 스킬

OpenClaw는 세 가지 위치에서 스킬을 로드합니다 (워크스페이스가 이름 충돌에서 승리합니다):

- Bundled (설치와 함께 제공됨)
- Managed/local: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

스킬은 설정/환경으로 제어될 수 있습니다 ([게이트웨이 설정](/gateway/configuration)의 `skills` 참조).

## pi-mono 통합

OpenClaw는 pi-mono 코드베이스의 일부 (모델/도구)를 재사용하지만, **세션 관리, 발견 및 도구 와이어링은 OpenClaw 소유입니다**.

- No pi-coding 에이전트 런타임.
- No `~/.pi/agent` 또는 `<workspace>/.pi` 설정은 참조되지 않습니다.

## 세션

세션 트랜스크립트는 다음의 JSONL로 저장됩니다:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

세션 ID는 안정적이고 OpenClaw에 의해 선택됩니다.
Legacy Pi/Tau 세션 폴더는 **읽히지 않습니다**.

## 스트리밍 중 조향

큐 모드가 `steer`일 때, 인바운드 메시지는 현재 실행에 주입됩니다.
큐는 **각 도구 호출 후** 확인됩니다; 큐된 메시지가 있으면,
현재 어시스턴트 메시지의 나머지 도구 호출은 건너뛰어집니다 ("Queued user message로 인해 skipped되었습니다." 오류 도구
결과), 그 다음 큐된 사용자
메시지는 다음 어시스턴트 응답 전에 주입됩니다.

큐 모드가 `followup` 또는 `collect`일 때, 인바운드 메시지는 현재 턴이 끝날 때까지 보류되고, 그 다음 새로운 에이전트 턴이 큐된 페이로드로 시작됩니다. [큐](/concepts/queue)에서 모드 + debounce/cap 동작을 참조하세요.

블록 스트리밍 완료된 어시스턴트 블록을 완료되는 즉시 전송합니다; 이는 **기본적으로 비활성화됨** (`agents.defaults.blockStreamingDefault: "off"`).
`agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; text_end로 기본값)를 통해 경계를 조정합니다.
`agents.defaults.blockStreamingChunk` (기본값:
800–1200 자; 단락 구분을 선호하고, 그 다음 줄바꿈; 마지막 문장)로 소프트 블록 청킹을 제어합니다.
`agents.defaults.blockStreamingCoalesce`를 사용하여 스트림된 청크를 병합하여 single-line spam을 줄입니다 (전송 전 idle-based 병합). Non-Telegram 채널은 블록 응답을 활성화하려면 명시적 `*.blockStreaming: true`가 필요합니다.
Verbose 도구 요약은 도구 시작 시 (debounce 없이) 내보내집니다; Control UI는 사용 가능할 때 에이전트 이벤트를 통해 도구 출력을 스트리밍합니다.
자세한 내용: [스트리밍 + 청킹](/concepts/streaming).

## 모델 refs

설정의 모델 refs (예: `agents.defaults.model` 및 `agents.defaults.models`)는 **첫 번째** `/`로 분할하여 파싱됩니다.

- 모델을 구성할 때 `provider/model`을 사용하세요.
- 모델 ID 자체에 `/`가 포함된 경우 (OpenRouter-style), 제공자 접두사를 포함하세요 (예: `openrouter/moonshotai/kimi-k2`).
- 제공자를 생략하면 OpenClaw는 입력을 별칭으로 취급하거나 **default provider**의 모델로 취급합니다 (모델 ID에 `/`가 없을 때만 작동함).

## 최소 설정

최소한 설정:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (강력히 권장됨)

---

다음: [그룹 채팅](/channels/group-messages) 🦞
