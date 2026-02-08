---
read_when:
    - 일일 Markdown 로그를 넘어서 작업 공간 메모리(~/.openclaw/workspace) 설계
    - Deciding: standalone CLI vs deep OpenClaw integration
    - 오프라인 회상 + 반성 추가 (보유/회상/반영)
summary: '연구 노트: Clawd 작업 공간을 위한 오프라인 메모리 시스템(Markdown 진실 소스 + 파생 인덱스)'
title: 작업 공간 메모리 연구
x-i18n:
    generated_at: "2026-02-08T15:58:08Z"
    model: gtx
    provider: google-translate
    source_hash: 1753c8ee6284999fab4a94ff5fae7421c85233699c9d3088453d0c2133ac0feb
    source_path: experiments/research/memory.md
    workflow: 15
---

# Workspace Memory v2(오프라인): 연구 노트

대상: Clawd 스타일 작업 공간(`agents.defaults.workspace`, 기본 `~/.openclaw/workspace`) 여기서 “메모리”는 하루에 하나의 Markdown 파일로 저장됩니다(`memory/YYYY-MM-DD.md`) 및 작은 안정적인 파일 세트(예: `memory.md`, `SOUL.md`).

이 문서는 다음을 제안합니다. **오프라인 우선** Markdown을 표준적이고 검토 가능한 정보 소스로 유지하지만 추가 기능을 추가하는 메모리 아키텍처 **구조화된 회상** (검색, 엔터티 요약, 신뢰도 업데이트) 파생된 인덱스를 통해.

## 왜 바꾸나요?

현재 설정(하루에 하나의 파일)은 다음에 적합합니다.

- "추가 전용" 저널링
- 인간 편집
- git 기반 내구성 + 감사 가능성
- 저마찰 캡처(“그냥 적어보세요”)

다음과 같은 경우에는 약합니다:

- 높은 회상 인출(“X에 대해 우리는 무엇을 결정했습니까?”, “마지막으로 Y를 시도했을 때?”)
- 많은 파일을 다시 읽지 않고도 엔터티 중심 답변(“Alice / The Castle / warelay에 대해 알려주세요”)
- 의견/선호 안정성(및 변경 시 증거)
- 시간 제약(“2025년 11월에는 무엇이 사실이었나요?”) 및 갈등 해결

## 디자인 목표

- **오프라인**: 네트워크 없이 작동합니다. 노트북/성에서 실행할 수 있습니다. 클라우드 종속성이 없습니다.
- **설명 가능**: 검색된 항목은 속성(파일 + 위치)이 있어야 하며 추론과 분리 가능해야 합니다.
- **낮은 의식**: 일일 로깅은 Markdown으로 유지되며 과도한 스키마 작업이 없습니다.
- **증분**: v1은 FTS에서만 유용합니다. 의미/벡터 및 그래프는 선택적 업그레이드입니다.
- **상담원 친화적**: "토큰 예산 내에서 회상"을 쉽게 만듭니다(소량의 사실 묶음을 반환).

## 북극성 모델(Hindsight × Letta)

혼합할 두 조각:

1. **Letta/MemGPT 스타일 제어 루프**

- 작은 "핵심"을 항상 맥락에 맞게 유지하세요(페르소나 + 주요 사용자 사실)
- 다른 모든 것은 컨텍스트를 벗어나 도구를 통해 검색됩니다.
- 메모리 쓰기는 명시적인 도구 호출(추가/교체/삽입)이고 지속된 후 다음 차례에 다시 주입됩니다.

2. **사후 판단 스타일의 메모리 기판**

- 관찰한 것, 믿는 것, 요약한 것을 구분하세요.
- 유지/회상/반영 지원
- 증거를 통해 진화할 수 있는 자신감 있는 의견
- 엔터티 인식 검색 + 임시 쿼리(전체 지식 그래프가 없더라도)

## 제안된 아키텍처(마크다운 정보 소스 + 파생 인덱스)

### 정식 저장소(git 친화적)

유지하다 `~/.openclaw/workspace` 사람이 읽을 수 있는 정식 메모리로 사용됩니다.

권장되는 작업 공간 레이아웃:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

참고:

- **일일 로그는 일일 로그로 유지됩니다.**. JSON으로 변환할 필요가 없습니다.
- 그만큼 `bank/` 파일은 **선별된**, 리플렉션 작업으로 생성되며 여전히 직접 편집할 수 있습니다.
- `memory.md` 여전히 "소형 + 핵심": Clawd가 모든 세션에서 보기를 원하는 것입니다.

### 파생 저장소(머신 리콜)

작업 공간 아래에 파생 인덱스를 추가합니다(반드시 Git 추적일 필요는 없음).

```
~/.openclaw/workspace/.memory/index.sqlite
```

다음을 사용하여 백업하세요.

- 사실 + 엔터티 링크 + 의견 메타데이터에 대한 SQLite 스키마
- SQLite **FTS5** 어휘 회상용(빠른, 아주 작은, 오프라인)
- 의미적 회상을 위한 선택적 임베딩 테이블(여전히 오프라인)

지수는 항상 **Markdown에서 다시 빌드 가능**.

## 유지/회상/반영(작업 루프)

### 유지: 일일 로그를 "사실"로 정규화합니다.

여기서 중요한 Hindsight의 핵심 통찰력: 매장 **서술형, 독립적인 사실**, 작은 조각이 아닙니다.

실제 규칙 `memory/YYYY-MM-DD.md`:

- 하루가 끝날 때(또는 도중)에 `## Retain` 2~5개의 글머리 기호가 있는 섹션은 다음과 같습니다.
  - 내러티브(교차적 맥락 보존)
  - 독립형(나중에 독립형이 의미가 있음)
  - 유형 + 엔터티 언급으로 태그됨

예:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

최소한의 구문 분석:

- 접두사 유형: `W` (세계), `B` (경험/전기), `O` (의견), `S` (관찰/요약; 일반적으로 생성됨)
- 엔터티: `@Peter`, `@warelay`등(슬러그는 다음으로 매핑됩니다. `bank/entities/*.md`)
- 의견 신뢰도: `O(c=0.0..1.0)` 선택 과목

작성자가 그것에 대해 생각하는 것을 원하지 않는 경우: 반영 작업은 로그의 나머지 부분에서 이러한 글머리 기호를 추론할 수 있지만 명시적인 `## Retain` 섹션은 가장 쉬운 "품질 레버"입니다.

### 회상: 파생 인덱스에 대한 쿼리

리콜은 다음을 지원해야 합니다.

- **어휘**: “정확한 용어/이름/명령 찾기” (FTS5)
- **실재**: "X에 대해 알려주세요"(엔티티 페이지 + 엔터티 연결 사실)
- **일시적인**: "11월 27일쯤에 무슨 일이 있었나요" / "지난주부터"
- **의견**: “피터는 무엇을 더 좋아하나요?” (자신감 + 증거)

반환 형식은 상담원 친화적이어야 하며 출처를 인용해야 합니다.

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (소스 날짜 또는 추출된 시간 범위(있는 경우))
- `entities` (`["Peter","warelay"]`)
- `content` (서사적 사실)
- `source` (`memory/2025-11-27.md#L12` 등)

### 반영: 안정적인 페이지 생성 + 신념 업데이트

Reflection은 예약된 작업입니다(매일 또는 하트비트). `ultrathink`) 저것:

- 업데이트 `bank/entities/*.md` 최근 사실(엔티티 요약)에서
- 업데이트 `bank/opinions.md` 강화/모순에 기초한 자신감
- 선택적으로 편집을 제안합니다. `memory.md` ("핵심적인" 내구성 있는 사실)

의견 진화(간단하고 설명 가능):

- 각 의견에는 다음이 포함됩니다.
  - 성명
  - 신뢰 `c ∈ [0,1]`
  - 마지막_업데이트
  - 증거 링크(지원 + 모순되는 사실 ID)
- 새로운 사실이 도착하면:
  - 엔터티 중복 + 유사성으로 후보 의견 찾기(FTS 우선, 임베딩 나중에)
  - 작은 델타로 신뢰도를 업데이트합니다. 큰 도약에는 강력한 모순 + 반복된 증거가 필요합니다.

## CLI 통합: 독립형 및 심층 통합

추천: **OpenClaw와의 긴밀한 통합**, 그러나 분리 가능한 코어 라이브러리를 유지하십시오.

### OpenClaw에 통합하는 이유는 무엇입니까?

- OpenClaw는 이미 다음 사항을 알고 있습니다.
  - 작업공간 경로(`agents.defaults.workspace`)
  - 세션 모델 + 하트비트
  - 로깅 + 문제 해결 패턴
- 에이전트 자체가 도구를 호출하도록 하려고 합니다.
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### 왜 아직도 라이브러리를 분할하나요?

- 게이트웨이/런타임 없이 메모리 로직을 테스트 가능하게 유지
- 다른 컨텍스트(로컬 스크립트, 향후 데스크톱 앱 등)에서 재사용

모양:
메모리 도구는 작은 CLI + 라이브러리 계층을 위한 것이지만 이는 탐색용일 뿐입니다.

## “S-Collide” / SuCo: 언제 사용하는가(연구)

S-Collide를 말한다면 **SuCo(부분 공간 충돌)**: 부분 공간에서 학습된/구조화된 충돌을 사용하여 강력한 재현율/지연 시간 균형을 목표로 하는 ANN 검색 접근 방식입니다(논문: arXiv 2411.14754, 2024).

실용적인 취지 `~/.openclaw/workspace`:

- **시작하지 마세요** 수코와 함께.
- SQLite FTS + (선택 사항) 단순 임베딩으로 시작합니다. 대부분의 UX 승리를 즉시 얻을 수 있습니다.
- SuCo/HNSW/ScaNN 클래스 솔루션을 한 번만 고려하십시오.
  - 말뭉치(corpus)가 크다(수만/수십만 청크)
  - 무차별 삽입 검색이 너무 느려짐
  - 회상 품질은 어휘 검색으로 인해 의미 있는 병목 현상이 발생합니다.

오프라인 친화적인 대안(복잡성 증가):

- SQLite FTS5 + 메타데이터 필터(ML 없음)
- 임베딩 + 무차별 대입(청크 수가 적은 경우 놀랍게도 작동함)
- HNSW 인덱스(공통, 견고함, 라이브러리 바인딩 필요)
- SuCo(연구 등급, 포함할 수 있는 견고한 구현이 있는 경우 매력적)

공개 질문:

- 그게 뭐야? **최상의** 귀하의 컴퓨터(노트북 + 데스크탑)에 "개인 비서 메모리"를 위한 오프라인 임베딩 모델이 있습니까?
  - 이미 Ollama가 있는 경우: 로컬 모델을 포함합니다. 그렇지 않으면 툴체인에 작은 임베딩 모델을 제공합니다.

## 가장 작은 유용한 파일럿

최소한의 유용한 버전을 원한다면:

- 추가하다 `bank/` 엔터티 페이지 및 `## Retain` 일일 로그 섹션.
- 인용(경로 + 줄 번호)을 통해 회상하려면 SQLite FTS를 사용하세요.
- 재현율이나 규모가 요구하는 경우에만 임베딩을 추가하세요.

## 참고자료

- Letta/MemGPT 개념: "코어 메모리 블록" + "아카이브 메모리" + 도구 기반 자체 편집 메모리.
- Hindsight 기술 보고서: "유지/회상/반영", 4-네트워크 메모리, 서술적 사실 추출, 의견 신뢰 진화.
- SuCo: arXiv 2411.14754 (2024): "부분 공간 충돌"은 가장 가까운 이웃 검색에 가깝습니다.
