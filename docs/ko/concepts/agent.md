---
read_when:
    - 에이전트 런타임, 작업공간 부트스트랩 또는 세션 동작 변경
summary: 에이전트 런타임(임베디드 파이 모노), 작업 공간 계약 및 세션 부트스트랩
title: 에이전트 런타임
x-i18n:
    generated_at: "2026-02-08T15:51:59Z"
    model: gtx
    provider: google-translate
    source_hash: 121103fda29a5481cb43234a39494f038e5dba89d0257fd3f7150c896b142bca
    source_path: concepts/agent.md
    workflow: 15
---

# 에이전트 런타임 🤖

OpenClaw는 다음에서 파생된 단일 내장 에이전트 런타임을 실행합니다. **파이모노**.

## 작업공간(필수)

OpenClaw는 단일 에이전트 작업 공간 디렉터리(`agents.defaults.workspace`) 대리인의 경우 **오직** 작업 디렉토리(`cwd`) 도구 및 컨텍스트를 확인하세요.

권장사항: 사용 `openclaw setup` 창조하다 `~/.openclaw/openclaw.json` 누락된 경우 작업공간 파일을 초기화합니다.

전체 작업 공간 레이아웃 + 백업 가이드: [상담원 작업공간](/concepts/agent-workspace)

만약에 `agents.defaults.sandbox` 활성화되면 기본 세션이 아닌 세션에서 이를 재정의할 수 있습니다.
세션별 작업공간 `agents.defaults.sandbox.workspaceRoot` (보다
[게이트웨이 구성](/gateway/configuration)).

## 부트스트랩 파일(삽입됨)

내부에 `agents.defaults.workspace`, OpenClaw에서는 다음과 같은 사용자 편집 가능 파일을 기대합니다.

- `AGENTS.md` — 작동 지침 + "메모리"
- `SOUL.md` — 페르소나, 경계, 어조
- `TOOLS.md` — 사용자가 관리하는 도구 메모(예: `imsg`, `sag`, 규칙)
- `BOOTSTRAP.md` — 1회 최초 실행 의식(완료 후 삭제)
- `IDENTITY.md` — 에이전트 이름/분위기/이모지
- `USER.md` — 사용자 프로필 + 기본 주소

새 세션의 첫 번째 차례에서 OpenClaw는 이러한 파일의 내용을 에이전트 컨텍스트에 직접 삽입합니다.

빈 파일은 건너뜁니다. 큰 파일은 마커로 잘려서 메시지가 간결하게 유지됩니다(전체 콘텐츠를 보려면 파일을 읽으세요).

파일이 누락된 경우 OpenClaw는 단일 "누락된 파일" 표시 줄을 삽입합니다(그리고 `openclaw setup` 안전한 기본 템플릿이 생성됩니다).

`BOOTSTRAP.md` 에 대해서만 생성됩니다. **완전히 새로운 작업 공간** (다른 부트스트랩 파일은 없습니다). 의식을 완료한 후 삭제하면 나중에 다시 시작할 때 다시 생성되어서는 안 됩니다.

부트스트랩 파일 생성을 완전히 비활성화하려면(미리 시드된 작업공간의 경우) 다음을 설정하십시오.

```json5
{ agent: { skipBootstrap: true } }
```

## 내장 도구

핵심 도구(읽기/실행/편집/쓰기 및 관련 시스템 도구)를 항상 사용할 수 있습니다.
도구 정책이 적용됩니다. `apply_patch` 선택 사항이며 다음에 의해 제어됩니다.
`tools.exec.applyPatch`.`TOOLS.md` 하다 **~ 아니다** 어떤 도구가 존재하는지 제어합니다. 그것은
방법에 대한 지침 _너_ 그것들이 사용되기를 원합니다.

## 기술

OpenClaw는 세 위치에서 기술을 로드합니다(이름 충돌 시 작업 공간이 우선).

- 번들(설치 시 함께 제공)
- 관리형/로컬: `~/.openclaw/skills`
- 작업 공간: `<workspace>/skills`

기술은 구성/환경에 따라 제어될 수 있습니다(참조 `skills` ~에 [게이트웨이 구성](/gateway/configuration)).

## 파이-모노 통합

OpenClaw는 pi-mono 코드베이스(모델/도구)의 일부를 재사용하지만 **세션 관리, 검색 및 도구 배선은 OpenClaw 소유입니다.**.

- 파이 코딩 에이전트 런타임이 없습니다.
- 아니요 `~/.pi/agent` 또는 `<workspace>/.pi` 설정을 상담합니다.

## 세션

세션 기록은 다음 위치에 JSONL로 저장됩니다.

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

세션 ID는 안정적이며 OpenClaw에 의해 선택됩니다.
레거시 Pi/Tau 세션 폴더는 다음과 같습니다. **~ 아니다** 읽다.

## 스트리밍 중 조종

대기열 모드인 경우 `steer`, 인바운드 메시지가 현재 실행에 삽입됩니다.
대기열이 확인되었습니다. **각 도구 호출 후**; 대기 중인 메시지가 있는 경우
현재 보조 메시지의 나머지 도구 호출은 건너뜁니다(오류 도구
"대기 중인 사용자 메시지로 인해 건너뛰었습니다."라는 결과가 표시되면 대기열에 있는 사용자는
다음 어시스턴트 응답 전에 메시지가 삽입됩니다.

대기열 모드인 경우 `followup` 또는 `collect`, 인바운드 메시지는 다음 날짜까지 보관됩니다.
현재 턴이 끝나면 대기 중인 페이로드로 새 에이전트 턴이 시작됩니다. 보다
[대기줄](/concepts/queue) 모드 + 디바운스/캡 동작의 경우.

블록 스트리밍은 완료되는 즉시 완료된 보조 블록을 보냅니다. 그것은
**기본적으로 꺼짐** (`agents.defaults.blockStreamingDefault: "off"`).
다음을 통해 경계 조정 `agents.defaults.blockStreamingBreak` (`text_end` 대 `message_end`; 기본값은 text_end)입니다.
다음을 사용하여 소프트 블록 청킹을 제어합니다. `agents.defaults.blockStreamingChunk` (기본값은
800~1200자; 단락 나누기를 선호하고 그 다음 줄 바꿈을 선호합니다. 마지막 문장).
스트리밍된 청크를 다음과 같이 병합합니다. `agents.defaults.blockStreamingCoalesce` 줄이기 위해
한 줄 스팸(보내기 전 유휴 기반 병합). 텔레그램이 아닌 채널에는 다음이 필요합니다.
명시적인 `*.blockStreaming: true` 차단 답장을 활성화합니다.
자세한 도구 요약은 도구 시작 시 내보내집니다(디바운스 없음). 컨트롤 UI
가능한 경우 에이전트 이벤트를 통해 도구 출력을 스트리밍합니다.
자세한 내용: [스트리밍 + 청킹](/concepts/streaming).

## 모델 심판

구성의 모델 참조(예: `agents.defaults.model` 그리고 `agents.defaults.models`)는 분할하여 구문 분석됩니다. **첫 번째** `/`.

- 사용 `provider/model` 모델을 구성할 때.
- 모델 ID 자체에 다음이 포함된 경우 `/` (OpenRouter 스타일), 공급자 접두사를 포함합니다(예: `openrouter/moonshotai/kimi-k2`).
- 공급자를 생략하면 OpenClaw는 입력을 별칭이나 모델로 처리합니다. **기본 공급자** (없을 때만 작동합니다. `/` 모델 ID에서).

## 구성(최소)

최소한 다음을 설정하십시오.

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (강력히 권장)

---

_다음: [그룹 채팅](/channels/group-messages)_ 🦞
