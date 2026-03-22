---
summary: "컨텍스트: 모델이 보는 것, 어떻게 구축되는지, 검사하는 방법"
read_when:
  - OpenClaw에서 "컨텍스트"의 의미를 이해하고 싶을 때
  - 모델이 무언가를 "알고 있는" (또는 잊어버린) 이유를 디버깅할 때
  - 컨텍스트 오버헤드를 줄이고 싶을 때 (/context, /status, /compact)
title: "컨텍스트"
x-i18n:
  source_path: "docs/concepts/context.md"
---

# 컨텍스트

"컨텍스트"는 **OpenClaw가 실행을 위해 모델에 보내는 모든 것**입니다. 모델의 **컨텍스트 윈도우** (토큰 제한)에 의해 제한됩니다.

초보자를 위한 개념 모델:

- **시스템 프롬프트** (OpenClaw 구축): 규칙, 도구, Skills 목록, 시간/런타임, 주입된 워크스페이스 파일.
- **대화 기록**: 이 세션에서의 사용자 메시지 + 어시스턴트 메시지.
- **도구 호출/결과 + 첨부 파일**: 명령 출력, 파일 읽기, 이미지/오디오 등.

컨텍스트는 "메모리"와 _같은 것이 아닙니다_: 메모리는 디스크에 저장되어 나중에 다시 로드될 수 있지만, 컨텍스트는 모델의 현재 윈도우 안에 있는 것입니다.

## 빠른 시작 (컨텍스트 검사)

- `/status` → 빠른 "내 윈도우가 얼마나 찼나?" 뷰 + 세션 설정.
- `/context list` → 주입된 것 + 대략적인 크기 (파일별 + 합계).
- `/context detail` → 더 깊은 분석: 파일별, 도구 스키마 크기별, skill 항목 크기별, 시스템 프롬프트 크기.
- `/usage tokens` → 일반 응답에 응답별 사용량 푸터 추가.
- `/compact` → 오래된 기록을 간결한 항목으로 요약하여 윈도우 공간 확보.

참조: [슬래시 명령](/tools/slash-commands), [토큰 사용 및 비용](/reference/token-use), [압축](/concepts/compaction).

## 예제 출력

값은 모델, 프로바이더, 도구 정책 및 워크스페이스 내용에 따라 다릅니다.

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

## 컨텍스트 윈도우에 포함되는 것

모델이 수신하는 모든 것이 포함됩니다:

- 시스템 프롬프트 (모든 섹션).
- 대화 기록.
- 도구 호출 + 도구 결과.
- 첨부 파일/트랜스크립트 (이미지/오디오/파일).
- 압축 요약 및 프루닝 아티팩트.
- 프로바이더 "래퍼" 또는 숨겨진 헤더 (보이지 않지만 여전히 포함됨).

## OpenClaw가 시스템 프롬프트를 구축하는 방법

시스템 프롬프트는 **OpenClaw 소유**이며 매 실행마다 재구축됩니다. 포함되는 내용:

- 도구 목록 + 짧은 설명.
- Skills 목록 (메타데이터만, 아래 참조).
- 워크스페이스 위치.
- 시간 (UTC + 설정된 경우 변환된 사용자 시간).
- 런타임 메타데이터 (호스트/OS/모델/thinking).
- **Project Context** 아래에 주입된 워크스페이스 부트스트랩 파일.

전체 분석: [시스템 프롬프트](/concepts/system-prompt).

## 주입된 워크스페이스 파일 (Project Context)

기본적으로 OpenClaw는 고정된 워크스페이스 파일 세트를 주입합니다 (존재하는 경우):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (첫 실행 시만)

큰 파일은 `agents.defaults.bootstrapMaxChars` (기본값 `20000`자)를 사용하여 파일별로 잘립니다. OpenClaw는 또한 `agents.defaults.bootstrapTotalMaxChars` (기본값 `150000`자)로 파일 전체의 총 부트스트랩 주입 상한을 적용합니다. `/context`는 **원본 대 주입** 크기와 잘림 발생 여부를 보여줍니다.

잘림이 발생하면, 런타임은 Project Context 아래에 프롬프트 내 경고 블록을 주입할 수 있습니다. `agents.defaults.bootstrapPromptTruncationWarning` (`off`, `once`, `always`, 기본값 `once`)으로 설정하세요.

## Skills: 주입 vs 요청 시 로드

시스템 프롬프트는 간결한 **skills 목록** (이름 + 설명 + 위치)을 포함합니다. 이 목록은 실제 오버헤드가 있습니다.

Skill 지침은 기본적으로 포함되지 _않습니다_. 모델은 **필요할 때만** skill의 `SKILL.md`를 `read`할 것으로 기대됩니다.

## 도구: 두 가지 비용이 있습니다

도구는 컨텍스트에 두 가지 방식으로 영향을 줍니다:

1. 시스템 프롬프트의 **도구 목록 텍스트** ("Tooling"으로 보이는 것).
2. **도구 스키마** (JSON). 모델이 도구를 호출할 수 있도록 전송됩니다. 일반 텍스트로 보이지 않더라도 컨텍스트에 포함됩니다.

`/context detail`은 가장 큰 도구 스키마를 분석하여 무엇이 지배적인지 볼 수 있게 합니다.

## 명령, 디렉티브 및 "인라인 단축키"

슬래시 명령은 Gateway에서 처리됩니다. 몇 가지 다른 동작이 있습니다:

- **독립 실행형 명령**: `/...`만 있는 메시지는 명령으로 실행됩니다.
- **디렉티브**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue`는 모델이 메시지를 보기 전에 제거됩니다.
  - 디렉티브만 있는 메시지는 세션 설정을 영속화합니다.
  - 일반 메시지의 인라인 디렉티브는 메시지별 힌트로 작용합니다.
- **인라인 단축키** (허용 목록 발신자만): 일반 메시지 내의 특정 `/...` 토큰은 즉시 실행될 수 있으며 (예: "hey /status"), 모델이 나머지 텍스트를 보기 전에 제거됩니다.

세부 사항: [슬래시 명령](/tools/slash-commands).

## 세션, 압축 및 프루닝 (영속되는 것)

메시지 간에 영속되는 것은 메커니즘에 따라 다릅니다:

- **일반 기록**은 정책에 의해 압축/프루닝될 때까지 세션 트랜스크립트에 영속됩니다.
- **압축**은 요약을 트랜스크립트에 영속하고 최근 메시지를 유지합니다.
- **프루닝**은 실행을 위한 _인메모리_ 프롬프트에서 오래된 도구 결과를 제거하지만, 트랜스크립트를 다시 쓰지는 않습니다.

문서: [세션](/concepts/session), [압축](/concepts/compaction), [세션 프루닝](/concepts/session-pruning).

기본적으로 OpenClaw는 조립 및 압축을 위해 내장 `legacy` 컨텍스트 엔진을 사용합니다. `kind: "context-engine"`을 제공하는 플러그인을 설치하고 `plugins.slots.contextEngine`으로 선택하면, OpenClaw는 컨텍스트 조립, `/compact` 및 관련 서브 에이전트 컨텍스트 라이프사이클 후크를 해당 엔진에 위임합니다. `ownsCompaction: false`는 레거시 엔진으로 자동 폴백되지 않습니다. 활성 엔진은 여전히 `compact()`를 올바르게 구현해야 합니다. 전체 플러그 가능 인터페이스, 라이프사이클 후크 및 설정은 [컨텍스트 엔진](/concepts/context-engine)을 참조하세요.

## `/context`가 실제로 보고하는 것

`/context`는 가능한 경우 최신 **실행 빌드** 시스템 프롬프트 보고서를 선호합니다:

- `System prompt (run)` = 마지막 내장(도구 기능) 실행에서 캡처되어 세션 저장소에 영속됨.
- `System prompt (estimate)` = 실행 보고서가 없을 때 (또는 보고서를 생성하지 않는 CLI 백엔드를 통해 실행될 때) 즉석에서 계산됨.

어느 쪽이든 크기와 주요 기여자를 보고합니다. 전체 시스템 프롬프트나 도구 스키마를 덤프하지는 **않습니다**.
