---
summary: "Research notes: offline memory system for Clawd workspaces (Markdown source-of-truth + derived index)"
read_when:
  - Designing workspace memory (~/.openclaw/workspace) beyond daily Markdown logs
  - Deciding: standalone CLI vs deep OpenClaw integration
  - Adding offline recall + reflection (retain/recall/reflect)
title: "Workspace Memory Research"
x-i18n:
  source_hash: 1753c8ee6284999fab4a94ff5fae7421c85233699c9d3088453d0c2133ac0feb
---

# Workspace Memory v2(오프라인): 연구 노트

대상: Clawd 스타일 작업 공간(`agents.defaults.workspace`, 기본 `~/.openclaw/workspace`) 여기서 "메모리"는 하루에 하나의 Markdown 파일(`memory/YYYY-MM-DD.md`)과 작은 안정적인 파일 세트(예: `memory.md`, `SOUL.md`)로 저장됩니다.

이 문서에서는 Markdown을 표준적이고 검토 가능한 정보 소스로 유지하면서 파생된 인덱스를 통해 **구조화된 회상**(검색, 엔터티 요약, 신뢰도 업데이트)을 추가하는 **오프라인 우선** 메모리 아키텍처를 제안합니다.

## 왜 바꾸나요?

현재 설정(하루에 하나의 파일)은 다음에 적합합니다.

- "추가 전용" 저널링
- 인간 편집
- git 기반 내구성 + 감사 가능성
- 저마찰 캡처(“그냥 적어보세요”)

다음과 같은 경우에는 약합니다:

- 높은 회상 검색(“X에 대해 우리는 무엇을 결정했습니까?”, “마지막으로 Y를 시도했을 때?”)
- 많은 파일을 다시 읽지 않고도 엔터티 중심 답변(“Alice / The Castle / warelay에 대해 알려주세요”)
- 의견/선호 안정성(및 변경 시 증거)
- 시간 제약(“2025년 11월에는 무엇이 사실이었나요?”) 및 갈등 해결

## 디자인 목표

- **오프라인**: 네트워크 없이 작동합니다. 노트북/성에서 실행할 수 있습니다. 클라우드 종속성이 없습니다.
- **설명 가능**: 검색된 항목은 속성(파일 + 위치)이 있어야 하며 추론과 분리 가능해야 합니다.
- **낮은 세레모니**: 일일 로깅은 마크다운으로 유지되며 과도한 스키마 작업은 없습니다.
- **증분**: v1은 FTS에만 유용합니다. 의미/벡터 및 그래프는 선택적 업그레이드입니다.
- **에이전트 친화적**: "토큰 예산 내에서 회수"를 쉽게 만듭니다(소량의 사실 묶음 반환).

## 북극성 모델(Hindsight × Letta)

혼합할 두 조각:

1. **Letta/MemGPT 스타일 제어 루프**

- 항상 맥락에 맞게 작은 "핵심"을 유지합니다(페르소나 + 주요 사용자 사실).
- 그 밖의 모든 것은 컨텍스트를 벗어나 도구를 통해 검색됩니다.
- 메모리 쓰기는 명시적인 도구 호출(추가/교체/삽입)이고 지속된 후 다음 차례에 다시 주입됩니다.

2. **사후 판단 스타일 메모리 기판**

- 관찰한 것, 믿는 것, 요약한 것을 분리하세요.
- 유지/회상/반영 지원
- 증거를 통해 발전할 수 있는 자신감 있는 의견
- 엔터티 인식 검색 + 임시 쿼리(전체 지식 그래프가 없더라도)

## 제안된 아키텍처(마크다운 정보 소스 + 파생 인덱스)

### 정식 저장소(git 친화적)

`~/.openclaw/workspace`를 사람이 읽을 수 있는 표준 메모리로 유지합니다.

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

- **일일 로그는 일일 로그로 유지됩니다**. JSON으로 변환할 필요가 없습니다.
- `bank/` 파일은 **큐레이팅**되어 리플렉션 작업을 통해 생성되며 여전히 직접 편집할 수 있습니다.
- `memory.md`는 "작고 핵심적인" 상태로 유지됩니다. Clawd가 모든 세션에서 보길 원합니다.

### 파생 저장소(머신 회수)

작업 공간 아래에 파생 인덱스를 추가합니다(반드시 Git 추적일 필요는 없음).

```
~/.openclaw/workspace/.memory/index.sqlite
```

다음을 사용하여 백업하세요.

- 사실 + 엔터티 링크 + 의견 메타데이터에 대한 SQLite 스키마
- 어휘 회상을 위한 SQLite **FTS5**(빠르고 작음, 오프라인)
- 의미적 회상을 위한 선택적 임베딩 테이블(여전히 오프라인)

인덱스는 항상 **Markdown에서 재구성 가능**합니다.

## 유지/회상/반영(작업 루프)

### 유지: 일일 로그를 '사실'로 정규화합니다.

여기서 중요한 Hindsight의 핵심 통찰력은 작은 단편이 아닌 **서술적이고 독립적인 사실**을 저장합니다.

`memory/YYYY-MM-DD.md`에 대한 실제 규칙:

- 하루가 끝날 때(또는 도중) 다음과 같은 2~5개의 글머리 기호가 포함된 `## Retain` 섹션을 추가합니다.
  - 내러티브(교차적 맥락 보존)
  - 독립형(나중에 독립형이 의미가 있음)
  - 유형 + 엔터티 언급 태그가 지정됨

예:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

최소한의 구문 분석:

- 유형 접두사: `W`(세계), `B`(경험/전기), `O`(의견), `S`(관찰/요약; 일반적으로 생성됨)
- 엔터티: `@Peter`, `@warelay` 등(슬러그는 `bank/entities/*.md`에 매핑됨)
- 의견 신뢰도 : `O(c=0.0..1.0)` 선택사항

작성자가 그것에 대해 생각하는 것을 원하지 않는 경우, 반영 작업은 로그의 나머지 부분에서 이러한 글머리 기호를 추론할 수 있지만 명시적인 `## Retain` 섹션을 갖는 것이 가장 쉬운 "품질 레버"입니다.

### 회상: 파생 인덱스에 대한 쿼리

리콜은 다음을 지원해야 합니다.

- **어휘**: "정확한 용어/이름/명령 찾기"(FTS5)
- **엔티티**: “X에 대해 알려주세요”(엔티티 페이지 + 엔터티 연결 사실)
- **일시적**: “11월 27일쯤에 무슨 일이 있었는지” / “지난주부터”
- **의견**: “피터는 무엇을 선호하나요?” (자신감 + 증거)

반환 형식은 상담원 친화적이어야 하며 출처를 인용해야 합니다.

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (소스 날짜 또는 추출된 시간 범위(있는 경우))
- `entities` (`["Peter","warelay"]`)
- `content` (서사적 사실)
- `source` (`memory/2025-11-27.md#L12` 등)

### 반영: 안정적인 페이지 생성 + 신념 업데이트

리플렉션은 다음과 같은 예약된 작업(매일 또는 하트비트 `ultrathink`)입니다.

- 최근 사실(엔티티 요약)로부터 `bank/entities/*.md` 업데이트
- 강화/모순을 기반으로 `bank/opinions.md` 신뢰도를 업데이트합니다.
- 선택적으로 `memory.md`에 대한 편집을 제안합니다("핵심적인" 지속성 사실).

의견 진화(간단하고 설명 가능):

- 각 의견에는 다음이 포함됩니다.
  - 진술
  - 자신감 `c ∈ [0,1]`
  - 마지막\_업데이트
  - 증거 링크(증거 + 모순되는 사실 ID)
- 새로운 사실이 도착했을 때:
  - 엔터티 중복 + 유사성 기준으로 후보 의견 찾기(FTS 우선, 임베딩 후)
  - 작은 델타로 신뢰도를 업데이트합니다. 큰 도약에는 강력한 모순 + 반복된 증거가 필요합니다.

## CLI 통합: 독립형 대 심층 통합

권장 사항: **OpenClaw와의 긴밀한 통합**, 분리 가능한 코어 라이브러리를 유지하세요.

### OpenClaw에 통합하는 이유는 무엇인가요?

- OpenClaw는 이미 다음 사항을 알고 있습니다.
  - 작업공간 경로(`agents.defaults.workspace`)
  - 세션 모델 + 하트비트
  - 로깅 + 문제 해결 패턴
- 에이전트 자체가 도구를 호출하도록 하려는 경우:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### 왜 아직도 라이브러리를 분할하나요?

- 게이트웨이/런타임 없이 메모리 로직을 테스트 가능하게 유지
- 다른 컨텍스트에서 재사용(로컬 스크립트, 향후 데스크톱 앱 등)

모양:
메모리 도구는 작은 CLI + 라이브러리 계층을 위한 것이지만 이는 탐색용일 뿐입니다.

## “S-Collide” / SuCo: 언제 사용하는가(연구)

"S-Collide"가 **SuCo(하위 공간 충돌)**을 참조하는 경우: 이는 하위 공간에서 학습/구조화된 충돌을 사용하여 강력한 재현율/지연 시간 상쇄를 목표로 하는 ANN 검색 접근 방식입니다(논문: arXiv 2411.14754, 2024).

`~/.openclaw/workspace`에 대한 실용적인 해석:

- SuCo로 **시작하지 마세요**.
- SQLite FTS + (선택 사항) 단순 임베딩으로 시작합니다. 대부분의 UX 승리를 즉시 얻을 수 있습니다.
- SuCo/HNSW/ScaNN 클래스 솔루션을 한 번만 고려하십시오.
  - 코퍼스가 크다(수만/수십만 청크)
  - 무차별 삽입 검색이 너무 느려집니다.
  - 어휘 검색으로 인해 회상 품질이 의미 있게 병목 현상을 겪습니다.

오프라인 친화적인 대안(복잡성 증가):

- SQLite FTS5 + 메타데이터 필터(ML 없음)
- 임베딩 + 무차별 대입(청크 수가 적은 경우 놀랍게도 작동함)
- HNSW 인덱스(공통, 견고함, 라이브러리 바인딩 필요)
- SuCo(연구 등급, 포함할 수 있는 견고한 구현이 있는 경우 매력적)

공개 질문:

- 귀하의 컴퓨터(노트북 + 데스크탑)에서 "개인 비서 메모리"를 위한 **가장 좋은** 오프라인 임베딩 모델은 무엇입니까?
  - 이미 Ollama가 있는 경우: 로컬 모델을 포함합니다. 그렇지 않으면 툴체인에 작은 임베딩 모델을 제공합니다.

## 가장 작은 유용한 파일럿

최소한의 유용한 버전을 원한다면:

- 일일 로그에 `bank/` 엔터티 페이지와 `## Retain` 섹션을 추가합니다.
- 인용(경로 + 줄 번호)을 통해 회상하려면 SQLite FTS를 사용하세요.
- 재현율이나 규모가 요구하는 경우에만 임베딩을 추가하세요.

## 참고자료

- Letta / MemGPT 개념: "코어 메모리 블록" + "아카이브 메모리" + 도구 기반 자체 편집 메모리.
- Hindsight Technical Report: “유지/회상/반영”, 4-네트워크 기억, 서술적 사실 추출, 의견 신뢰 진화.
- SuCo: arXiv 2411.14754 (2024): "부분 공간 충돌"은 가장 가까운 이웃 검색에 가깝습니다.
