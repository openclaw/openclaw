---
read_when:
    - OpenClaw에서 "컨텍스트"가 무엇을 의미하는지 이해하고 싶습니다.
    - 모델이 무언가를 "알고 있는"(또는 잊어버린) 이유를 디버깅하고 있습니다.
    - 컨텍스트 오버헤드를 줄이고 싶습니다(/context, /status, /compact).
summary: '컨텍스트: 모델이 보는 것, 구축 방법, 검사 방법'
title: 문맥
x-i18n:
    generated_at: "2026-02-08T15:50:39Z"
    model: gtx
    provider: google-translate
    source_hash: e6f42f515380ce125f474c969eb00a881f85885a4b1d1a7174423f6ef44046c1
    source_path: concepts/context.md
    workflow: 15
---

# 문맥

"컨텍스트"는 **OpenClaw가 실행을 위해 모델에 보내는 모든 것**. 모델의 경계에 속합니다. **컨텍스트 창** (토큰 제한).

초심자 정신 모델:

- **시스템 프롬프트** (OpenClaw 내장): 규칙, 도구, 기술 목록, 시간/런타임 및 삽입된 작업 공간 파일.
- **대화 기록**: 귀하의 메시지 + 이 세션에 대한 어시스턴트의 메시지입니다.
- **도구 호출/결과 + 첨부 파일**: 명령 출력, 파일 읽기, 이미지/오디오 등

맥락은 _똑같은 건 아니야_ "메모리"로서: 메모리는 디스크에 저장되고 나중에 다시 로드될 수 있습니다. 컨텍스트는 모델의 현재 창 안에 있는 것입니다.

## 빠른 시작(컨텍스트 검사)

- `/status` → 빠르게 “내 창문이 얼마나 꽉 찼나요?” 보기 + 세션 설정.
- `/context list` → 주입되는 내용 + 대략적인 크기(파일당 + 총계).
- `/context detail` → 심층 분석: 파일별, 도구별 스키마 크기, 스킬별 항목 크기 및 시스템 프롬프트 크기.
- `/usage tokens` → 일반 답글에 답글별 사용법 바닥글을 추가합니다.
- `/compact` → 오래된 역사를 간결한 항목으로 요약하여 창 공간을 확보합니다.

참조: [슬래시 명령](/tools/slash-commands), [토큰 사용 및 비용](/reference/token-use), [압축](/concepts/compaction).

## 예제 출력

값은 모델, 공급자, 도구 정책, 작업 공간에 따라 다릅니다.

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## 컨텍스트 창에 포함되는 사항

다음을 포함하여 모델이 수신하는 모든 것이 중요합니다.

- 시스템 프롬프트(모든 섹션).
- 대화 기록.
- 도구 호출 + 도구 결과.
- 첨부 파일/기록(이미지/오디오/파일).
- 압축 요약 및 가지치기 아티팩트.
- 공급자 "래퍼" 또는 숨겨진 헤더(표시되지 않지만 여전히 계산됨)

## OpenClaw가 시스템 프롬프트를 구축하는 방법

시스템 프롬프트는 **OpenClaw 소유** 각 실행을 다시 빌드했습니다. 여기에는 다음이 포함됩니다.

- 도구 목록 + 간단한 설명.
- 기술 목록(메타데이터만 해당, 아래 참조)
- 작업공간 위치.
- 시간(UTC + 구성된 경우 변환된 사용자 시간)입니다.
- 런타임 메타데이터(호스트/OS/모델/사고).
- 다음 위치에 삽입된 작업공간 부트스트랩 파일 **프로젝트 컨텍스트**.

전체 분석: [시스템 프롬프트](/concepts/system-prompt).

## 주입된 작업공간 파일(프로젝트 컨텍스트)

기본적으로 OpenClaw는 고정된 작업 공간 파일 세트(있는 경우)를 삽입합니다.

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (첫 실행에만 해당)

대용량 파일은 다음을 사용하여 파일별로 잘립니다. `agents.defaults.bootstrapMaxChars` (기본 `20000` 문자). `/context` 쇼 **원시 대 주입** 크기 및 잘림이 발생했는지 여부.

## 기술: 주입되는 것과 주문형으로 로드되는 것

시스템 프롬프트에는 컴팩트가 포함되어 있습니다. **스킬 목록** (이름 + 설명 + 위치). 이 목록에는 실제 오버헤드가 있습니다.

스킬 지시사항은 _~ 아니다_ 기본적으로 포함됩니다. 모델이 기대됩니다 `read` 스킬의 `SKILL.md` **필요할 때만**.

## 도구: 두 가지 비용이 있습니다.

도구는 두 가지 방식으로 상황에 영향을 미칩니다.

1. **도구 목록 텍스트** 시스템 프롬프트에서(“Tooling”으로 표시되는 것)
2. **도구 스키마** (JSON). 도구를 호출할 수 있도록 모델로 전송됩니다. 일반 텍스트로 표시되지 않더라도 컨텍스트에 포함됩니다.

`/context detail` 가장 큰 도구 스키마를 분석하여 무엇이 지배적인지 확인할 수 있습니다.

## 명령, 지시문 및 "인라인 단축키"

슬래시 명령은 게이트웨이에서 처리됩니다. 몇 가지 다른 동작이 있습니다.

- **독립형 명령**: 유일한 메시지 `/...` 명령으로 실행됩니다.
- **지시문**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` 모델이 메시지를 보기 전에 제거됩니다.
  - 지시어 전용 메시지는 세션 설정을 유지합니다.
  - 일반 메시지의 인라인 지시문은 메시지별 힌트 역할을 합니다.
- **인라인 단축키** (허용 목록에 있는 발신자만 해당): 특정 `/...` 일반 메시지 내의 토큰은 즉시 실행될 수 있으며(예: "hey /status") 모델이 나머지 텍스트를 보기 전에 제거됩니다.

세부: [슬래시 명령](/tools/slash-commands).

## 세션, 압축 및 가지치기(지속되는 것)

메시지 전반에 걸쳐 지속되는 내용은 메커니즘에 따라 다릅니다.

- **정상적인 역사** 정책에 의해 압축/정리될 때까지 세션 기록에 유지됩니다.
- **압축** 요약을 기록에 유지하고 최근 메시지를 그대로 유지합니다.
- **전정** 이전 도구 결과를 제거합니다. _메모리 내_ 실행을 요청하지만 기록을 다시 작성하지는 않습니다.

문서: [세션](/concepts/session), [압축](/concepts/compaction), [세션 가지치기](/concepts/session-pruning).

## 무엇 `/context` 실제로 보고한다

`/context` 최신을 선호한다 **실행 기반** 가능한 경우 시스템 프롬프트 보고서:

- `System prompt (run)` = 마지막 포함된(도구 사용 가능) 실행에서 캡처되어 세션 저장소에 유지됩니다.
- `System prompt (estimate)` = 실행 보고서가 없을 때(또는 보고서를 생성하지 않는 CLI 백엔드를 통해 실행할 때) 즉시 계산됩니다.

어느 쪽이든 규모와 최고 기여자를 보고합니다. 그렇죠 **~ 아니다** 전체 시스템 프롬프트 또는 도구 스키마를 덤프합니다.
