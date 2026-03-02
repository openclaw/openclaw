---
summary: "컨텍스트: 모델이 보는 것, 어떻게 빌드되는지, 어떻게 검사하는지"
read_when:
  - OpenClaw에서 "context"의 의미를 이해하려고 할 때
  - 모델이 무언가를 "알고" 있는 이유를 디버깅할 때 (또는 잊었을 때)
  - 컨텍스트 오버헤드를 줄이려고 할 때 (/context, /status, /compact)
title: "컨텍스트"
---

# 컨텍스트

"Context"는 **OpenClaw가 실행을 위해 모델에 보내는 모든 것**입니다. 모델의 **컨텍스트 윈도우** (토큰 제한)로 한정됩니다.

초보자 정신 모델:

- **시스템 프롬프트** (OpenClaw-built): 규칙, 도구, 스킬 리스트, 시간/런타임, 및 주입된 워크스페이스 파일.
- **대화 히스토리**: 이 세션의 당신의 메시지 + 어시스턴트의 메시지.
- **도구 호출/결과 + 첨부파일**: 명령 출력, 파일 읽기, 이미지/오디오, 등.

Context는 _같지 않습니다_ "memory": 메모리는 디스크에 저장되고 나중에 재로드될 수 있습니다; context는 모델의 현재 윈도우 내에 있는 것입니다.

## 빠른 시작 (context 검사)

- `/status` → "my window는 얼마나 찼나?" 빠른 보기 + 세션 설정.
- `/context list` → 주입된 것 + 대략적 크기 (파일별 + 합계).
- `/context detail` → 더 깊은 분석: per-file, per-tool schema 크기, per-skill entry 크기, 및 system prompt 크기.
- `/usage tokens` → 일반 응답에 per-reply 사용 footer 추가.
- `/compact` → 더 오래된 히스토리를 compact 항목으로 요약하여 윈도우 공간을 확보합니다.

또한 [Slash 명령어](/tools/slash-commands), [토큰 사용 & 비용](/reference/token-use), [Compaction](/concepts/compaction)을 참조합니다.

## 예시 출력

값은 모델, provider, 도구 정책, 및 워크스페이스의 내용에 따라 변합니다.

### `/context list`

```
🧠 컨텍스트 분석
워크스페이스: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

주입된 워크스페이스 파일:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

스킬 리스트 (system prompt 텍스트): 2,184 chars (~546 tok) (12 스킬)
도구: read, edit, write, exec, process, browser, message, sessions_send, …
도구 리스트 (system prompt 텍스트): 1,032 chars (~258 tok)
도구 스키마 (JSON): 31,988 chars (~7,997 tok) (context를 계산에 포함; 텍스트로 표시되지 않음)
도구: (위와 동일)

세션 토큰 (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 컨텍스트 분석 (자세한)
…
Top 스킬 (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more 스킬)

Top 도구 (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more 도구)
```

## 컨텍스트 윈도우에 계산되는 것

모델이 받는 모든 것이 계산되며, 다음을 포함합니다:

- 시스템 프롬프트 (모든 섹션).
- 대화 히스토리.
- 도구 호출 + 도구 결과.
- 첨부파일/트랜스크립트 (이미지/오디오/파일).
- Compaction 요약 및 pruning 아티팩트.
- Provider "wrappers" 또는 hidden 헤더 (보이지 않음, 여전히 계산됨).

## OpenClaw가 시스템 프롬프트를 빌드하는 방법

시스템 프롬프트는 **OpenClaw-owned**이고 모든 실행마다 재빌드됩니다. 다음을 포함합니다:

- 도구 리스트 + short 설명.
- 스킬 리스트 (metadata 만; 아래 참조).
- 워크스페이스 위치.
- 시간 (UTC + configured된 경우 사용자 시간으로 변환).
- 런타임 메타데이터 (host/OS/model/thinking).
- **Project Context**아래 주입된 워크스페이스 bootstrap 파일.

전체 분석은 [시스템 프롬프트](/concepts/system-prompt)를 참조합니다.

## 주입된 워크스페이스 파일 (Project Context)

기본적으로 OpenClaw는 고정 워크스페이스 파일 세트를 주입합니다 (존재하는 경우):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (first-run만)

큰 파일은 `agents.defaults.bootstrapMaxChars` (기본값 `20000` chars)를 사용하여 파일별로 잘립니다. OpenClaw는 또한 `agents.defaults.bootstrapTotalMaxChars` (기본값 `150000` chars)를 사용하여 파일 전체의 total bootstrap injection cap을 강제합니다. `/context`는 **raw vs injected** 크기 및 truncation이 발생했는지 여부를 표시합니다.

## 스킬: 주입되는 것 vs on-demand로 로드되는 것

시스템 프롬프트는 compact **스킬 리스트** (이름 + 설명 + 위치)를 포함합니다. 이 리스트는 실제 오버헤드를 갖습니다.

스킬 지침은 _기본적으로_ 포함되지 않습니다. 모델은 필요할 때만 스킬의 `SKILL.md`를 `read` **해야 합니다**.

## 도구: 두 가지 비용

도구는 컨텍스트에 두 가지 방식으로 영향을 미칩니다:

1. **도구 리스트 텍스트** system prompt에 (당신이 "Tooling"으로 보는 것).
2. **도구 스키마** (JSON). 모델이 도구를 호출할 수 있도록 모델에 전송됩니다. 당신이 일반 텍스트로 보지 않더라도 context를 계산에 포함합니다.

`/context detail`은 가장 큰 도구 스키마를 분석하므로 무엇이 지배하는지 볼 수 있습니다.

## 명령, 지침, 및 "inline 바로가기"

Slash 명령어는 Gateway에 의해 처리됩니다. 몇 가지 다른 동작이 있습니다:

- **Standalone 명령어**: 메시지가 `/...`만인 경우 명령으로 실행합니다.
- **지침**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue`는 모델이 보기 전에 제거됩니다.
  - Directive-only 메시지는 세션 설정을 유지합니다.
  - 일반 메시지에서 inline 지침은 per-message 힌트로 작동합니다.
- **Inline 바로가기** (allowlisted senders 전용): 일반 메시지 내의 특정 `/...` 토큰은 즉시 실행될 수 있습니다 (예: "hey /status"), 남은 텍스트를 모델이 보기 전에 제거됩니다.

세부정보: [Slash 명령어](/tools/slash-commands).

## 세션, compaction, 및 pruning (유지되는 것)

메시지에 무엇이 유지되는지는 메커니즘에 따라 달라집니다:

- **일반 히스토리** 세션 트랜스크립트에서 compacted/pruned될 때까지 유지됩니다.
- **Compaction** 트랜스크립트에 요약을 유지하고 최근 메시지를 그대로 유지합니다.
- **Pruning** old 도구 결과를 실행의 _in-memory_ 프롬프트에서 제거하지만, 트랜스크립트를 재작성하지 않습니다.

문서: [세션](/concepts/session), [Compaction](/concepts/compaction), [세션 pruning](/concepts/session-pruning).

## `/context` 실제로 보고하는 것

`/context`는 latest **run-built** 시스템 프롬프트 보고서를 선호합니다 (available할 때):

- `System prompt (run)` = 마지막 embedded (tool-capable) 실행에서 캡처되고 세션 스토어에 유지됨.
- `System prompt (estimate)` = 실행 보고서가 존재하지 않을 때 (또는 보고서를 생성하지 않는 CLI 백엔드를 통해 실행할 때) on the fly로 계산됨.

어느 경우든 크기 및 top contributors를 보고합니다; 전체 시스템 프롬프트 또는 도구 스키마를 dump하지 **않습니다**.
