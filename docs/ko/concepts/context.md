---
summary: "컨텍스트: 모델이 무엇을 보는지, 어떻게 구성되는지, 그리고 이를 검사하는 방법"
read_when:
  - OpenClaw 에서 '컨텍스트'가 무엇을 의미하는지 이해하고 싶을 때
  - 모델이 왜 어떤 것을 '알고' 있는지(또는 잊었는지) 디버깅할 때
  - 컨텍스트 오버헤드를 줄이고 싶을 때 (/context, /status, /compact)
title: "컨텍스트"
---

# 컨텍스트

'컨텍스트'는 **하나의 실행(run)을 위해 OpenClaw 가 모델에 보내는 모든 것**입니다. 이는 모델의 **컨텍스트 윈도우**(토큰 한도)에 의해 제한됩니다.

초보자를 위한 멘탈 모델:

- **시스템 프롬프트** (OpenClaw 가 구성): 규칙, 도구, Skills 목록, 시간/런타임, 주입된 워크스페이스 파일.
- **대화 기록**: 이 세션에서의 사용자 메시지 + 어시스턴트 메시지.
- **도구 호출/결과 + 첨부물**: 명령 출력, 파일 읽기, 이미지/오디오 등.

컨텍스트는 '메모리'와 _같은 것이 아닙니다_: 메모리는 디스크에 저장되었다가 나중에 다시 로드될 수 있지만, 컨텍스트는 모델의 현재 윈도우 안에 있는 것입니다.

## 빠른 시작 (컨텍스트 검사)

- `/status` → '내 윈도우가 얼마나 찼나?'를 빠르게 보는 뷰 + 세션 설정.
- `/context list` → 무엇이 주입되었는지 + 대략적인 크기 (파일별 + 합계).
- `/context detail` → 더 깊은 분해: 파일별, 도구 스키마별 크기, Skills 항목별 크기, 시스템 프롬프트 크기.
- `/usage tokens` → 일반 응답에 응답별 사용량 푸터를 추가.
- `/compact` → 오래된 기록을 요약하여 컴팩트 항목으로 만들고 윈도우 공간을 확보.

참고: [슬래시 명령](/tools/slash-commands), [토큰 사용량 및 비용](/reference/token-use), [컴팩션](/concepts/compaction).

## 예시 출력

값은 모델, 프로바이더, 도구 정책, 워크스페이스 내용에 따라 달라집니다.

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

모델이 받는 모든 것이 포함되며, 다음을 포함합니다:

- 시스템 프롬프트 (모든 섹션).
- 대화 기록.
- 도구 호출 + 도구 결과.
- 첨부물/전사본 (이미지/오디오/파일).
- 컴팩션 요약 및 프루닝 산출물.
- 프로바이더의 '래퍼' 또는 숨겨진 헤더 (보이지 않지만 계산에는 포함됨).

## OpenClaw 가 시스템 프롬프트를 구성하는 방법

시스템 프롬프트는 **OpenClaw 소유**이며 매 실행마다 재구성됩니다. 포함 내용은 다음과 같습니다:

- 도구 목록 + 짧은 설명.
- Skills 목록 (메타데이터만; 아래 참고).
- 워크스페이스 위치.
- 시간 (UTC + 설정된 경우 변환된 사용자 시간).
- 런타임 메타데이터 (호스트/OS/모델/사고 방식).
- **Project Context** 아래에 주입된 워크스페이스 부트스트랩 파일.

전체 분해: [시스템 프롬프트](/concepts/system-prompt).

## 주입된 워크스페이스 파일 (Project Context)

기본적으로 OpenClaw 는 다음의 고정된 워크스페이스 파일 집합을 (존재하는 경우) 주입합니다:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (최초 실행 시에만)

큰 파일은 파일별로 `agents.defaults.bootstrapMaxChars` 를 사용해 잘립니다 (기본값 `20000` 문자). `/context` 는 **원본 대비 주입된** 크기와 잘림 발생 여부를 표시합니다.

## Skills: 무엇이 주입되고 무엇이 온디맨드로 로드되는가

시스템 프롬프트에는 컴팩트한 **Skills 목록**(이름 + 설명 + 위치)이 포함됩니다. 이 목록은 실제 오버헤드를 가집니다.

Skill 지침은 기본적으로 포함되지 않습니다. 모델은 필요할 때에만 해당 Skill 의 `SKILL.md` 을 `read` 할 것으로 기대됩니다.

## 도구: 두 가지 비용이 있습니다

도구는 두 가지 방식으로 컨텍스트에 영향을 줍니다:

1. 시스템 프롬프트의 **도구 목록 텍스트** (사용자에게 보이는 'Tooling').
2. **도구 스키마** (JSON). 이것들은 모델에 전송되어 도구를 호출할 수 있게 합니다. 일반 텍스트로 보이지 않더라도 컨텍스트에 포함됩니다.

`/context detail` 는 가장 큰 도구 스키마를 분해하여 무엇이 지배적인지 볼 수 있게 합니다.

## 명령, 지시어, 그리고 '인라인 단축키'

슬래시 명령은 Gateway(게이트웨이)에서 처리됩니다. 몇 가지 서로 다른 동작이 있습니다:

- **독립형 명령**: 메시지가 오직 `/...` 인 경우 명령으로 실행됩니다.
- **지시어**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` 는 모델이 메시지를 보기 전에 제거됩니다.
  - 지시어만 있는 메시지는 세션 설정을 유지합니다.
  - 일반 메시지 안의 인라인 지시어는 메시지별 힌트로 작동합니다.
- **인라인 단축키** (허용 목록에 있는 발신자만): 일반 메시지 안의 특정 `/...` 토큰은 즉시 실행될 수 있으며 (예: 'hey /status'), 나머지 텍스트가 모델에 전달되기 전에 제거됩니다.

자세한 내용: [슬래시 명령](/tools/slash-commands).

## 세션, 컴팩션, 프루닝 (무엇이 유지되는가)

메시지 간에 유지되는 것은 메커니즘에 따라 달라집니다:

- **일반 기록**은 정책에 의해 컴팩트/프루닝되기 전까지 세션 전사본에 유지됩니다.
- **컴팩션**은 요약을 전사본에 유지하고 최근 메시지는 그대로 둡니다.
- **프루닝**은 실행을 위한 _메모리 내_ 프롬프트에서 오래된 도구 결과를 제거하지만, 전사본을 다시 쓰지는 않습니다.

문서: [세션](/concepts/session), [컴팩션](/concepts/compaction), [세션 프루닝](/concepts/session-pruning).

## `/context` 가 실제로 보고하는 내용

`/context` 는 가능할 때 최신 **실행 시 구성된** 시스템 프롬프트 보고서를 선호합니다:

- `System prompt (run)` = 마지막 임베디드(도구 사용 가능) 실행에서 캡처되어 세션 저장소에 유지됨.
- `System prompt (estimate)` = 실행 보고서가 없을 때 (또는 보고서를 생성하지 않는 CLI 백엔드를 통해 실행할 때) 즉석에서 계산됨.

어느 쪽이든 크기와 상위 기여자를 보고하며, 전체 시스템 프롬프트나 도구 스키마를 덤프하지는 않습니다.
