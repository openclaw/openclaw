---
summary: "에이전트 런타임, 워크스페이스 계약 및 세션 부트스트랩"
read_when:
  - 에이전트 런타임, 워크스페이스 부트스트랩 또는 세션 동작 변경 시
title: "에이전트 런타임"
x-i18n:
  source_path: "docs/concepts/agent.md"
---

# 에이전트 런타임

OpenClaw는 단일 내장 에이전트 런타임을 실행합니다.

## 워크스페이스 (필수)

OpenClaw는 단일 에이전트 워크스페이스 디렉토리(`agents.defaults.workspace`)를 도구와 컨텍스트를 위한 에이전트의 **유일한** 작업 디렉토리(`cwd`)로 사용합니다.

권장 사항: `openclaw setup`을 사용하여 `~/.openclaw/openclaw.json`이 없는 경우 생성하고 워크스페이스 파일을 초기화하세요.

전체 워크스페이스 레이아웃 + 백업 가이드: [에이전트 워크스페이스](/concepts/agent-workspace)

`agents.defaults.sandbox`가 활성화되면, 비메인 세션은 `agents.defaults.sandbox.workspaceRoot` 아래의 세션별 워크스페이스로 이를 재정의할 수 있습니다 ([Gateway 설정](/gateway/configuration) 참조).

## 부트스트랩 파일 (주입됨)

`agents.defaults.workspace` 내부에서 OpenClaw는 다음과 같은 사용자 편집 가능 파일을 기대합니다:

- `AGENTS.md` -- 운영 지침 + "메모리"
- `SOUL.md` -- 페르소나, 경계, 톤
- `TOOLS.md` -- 사용자 관리 도구 노트 (예: `imsg`, `sag`, 규칙)
- `BOOTSTRAP.md` -- 일회성 첫 실행 의식 (완료 후 삭제됨)
- `IDENTITY.md` -- 에이전트 이름/분위기/이모지
- `USER.md` -- 사용자 프로필 + 선호 호칭

새 세션의 첫 턴에서 OpenClaw는 이 파일들의 내용을 에이전트 컨텍스트에 직접 주입합니다.

빈 파일은 건너뜁니다. 큰 파일은 프롬프트를 간결하게 유지하기 위해 마커와 함께 잘리고 잘립니다 (전체 내용은 파일을 읽으세요).

파일이 누락된 경우, OpenClaw는 단일 "누락된 파일" 마커 라인을 주입합니다 (`openclaw setup`이 안전한 기본 템플릿을 생성합니다).

`BOOTSTRAP.md`는 **완전히 새로운 워크스페이스**(다른 부트스트랩 파일이 없는 경우)에서만 생성됩니다. 의식을 완료한 후 삭제하면 이후 재시작 시 재생성되지 않습니다.

부트스트랩 파일 생성을 완전히 비활성화하려면 (사전 시드된 워크스페이스의 경우) 다음을 설정하세요:

```json5
{ agent: { skipBootstrap: true } }
```

## 내장 도구

코어 도구(read/exec/edit/write 및 관련 시스템 도구)는 도구 정책에 따라 항상 사용 가능합니다. `apply_patch`는 선택 사항이며 `tools.exec.applyPatch`에 의해 제어됩니다. `TOOLS.md`는 어떤 도구가 존재하는지를 제어하지 **않습니다**. 도구를 _어떻게_ 사용할지에 대한 안내입니다.

## Skills

OpenClaw는 세 위치에서 Skills를 로드합니다 (이름 충돌 시 워크스페이스가 우선):

- 번들 (설치와 함께 제공)
- 관리/로컬: `~/.openclaw/skills`
- 워크스페이스: `<workspace>/skills`

Skills는 설정/환경에 의해 제어될 수 있습니다 ([Gateway 설정](/gateway/configuration)에서 `skills` 참조).

## 런타임 경계

내장 에이전트 런타임은 Pi 에이전트 코어(모델, 도구, 프롬프트 파이프라인)를 기반으로 구축됩니다. 세션 관리, 디스커버리, 도구 와이어링 및 채널 전달은 해당 코어 위에 있는 OpenClaw 소유 레이어입니다.

## 세션

세션 트랜스크립트는 다음 위치에 JSONL로 저장됩니다:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

세션 ID는 안정적이며 OpenClaw가 선택합니다.
다른 도구의 레거시 세션 폴더는 읽지 않습니다.

## 스트리밍 중 조향

대기열 모드가 `steer`일 때, 수신 메시지는 현재 실행에 주입됩니다.
대기열은 **각 도구 호출 후** 확인됩니다. 대기 중인 메시지가 있으면 현재 어시스턴트 메시지의 나머지 도구 호출은 건너뛰고("대기 중인 사용자 메시지로 인해 건너뜀." 오류 도구 결과), 대기 중인 사용자 메시지가 다음 어시스턴트 응답 전에 주입됩니다.

대기열 모드가 `followup` 또는 `collect`일 때, 수신 메시지는 현재 턴이 끝날 때까지 보류된 후 대기 중인 페이로드로 새로운 에이전트 턴이 시작됩니다. 모드 + 디바운스/캡 동작은 [대기열](/concepts/queue)을 참조하세요.

블록 스트리밍은 완료된 어시스턴트 블록이 완성되는 즉시 전송합니다. **기본값은 꺼짐**입니다 (`agents.defaults.blockStreamingDefault: "off"`).
`agents.defaults.blockStreamingBreak`로 경계를 조정하세요 (`text_end` vs `message_end`, 기본값 text_end).
`agents.defaults.blockStreamingChunk`로 소프트 블록 청킹을 제어하세요 (기본값 800-1200자, 단락 구분 선호, 그 다음 줄바꿈, 마지막으로 문장).
`agents.defaults.blockStreamingCoalesce`로 스트리밍된 청크를 병합하여 단일 라인 스팸을 줄이세요 (전송 전 유휴 기반 병합). Telegram이 아닌 채널은 블록 응답을 활성화하려면 명시적 `*.blockStreaming: true`가 필요합니다.
도구 시작 시 자세한 도구 요약이 발생합니다 (디바운스 없음). Control UI는 가능한 경우 에이전트 이벤트를 통해 도구 출력을 스트리밍합니다.
자세한 내용: [스트리밍 + 청킹](/concepts/streaming).

## 모델 참조

설정의 모델 참조(예: `agents.defaults.model` 및 `agents.defaults.models`)는 **첫 번째** `/`로 분할하여 파싱됩니다.

- 모델 설정 시 `provider/model`을 사용하세요.
- 모델 ID 자체에 `/`가 포함된 경우(OpenRouter 스타일), 프로바이더 접두사를 포함하세요 (예: `openrouter/moonshotai/kimi-k2`).
- 프로바이더를 생략하면, OpenClaw는 입력을 별칭 또는 **기본 프로바이더**의 모델로 취급합니다 (모델 ID에 `/`가 없을 때만 동작).

## 설정 (최소)

최소한 다음을 설정하세요:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (강력히 권장)

---

_다음: [그룹 채팅](/channels/group-messages)_
