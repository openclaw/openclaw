---
summary: "연구 노트: Clawd 워크스페이스를 위한 오프라인 메모리 시스템 (Markdown 단일 소스 오브 트루스 + 파생 인덱스)"
read_when:
  - 일일 Markdown 로그를 넘어서는 워크스페이스 메모리 (~/.openclaw/workspace) 설계 시
  - Deciding: 독립형 CLI vs OpenClaw 심층 통합 결정 시
  - 오프라인 회상 + 성찰 (retain/recall/reflect) 추가 시
title: "워크스페이스 메모리 연구"
---

# Workspace Memory v2 (offline): 연구 노트

대상: Clawd 스타일 워크스페이스 (`agents.defaults.workspace`, 기본값 `~/.openclaw/workspace`)로, “메모리”가 하루당 하나의 Markdown 파일 (`memory/YYYY-MM-DD.md`)과 소수의 안정적인 파일 집합 (예: `memory.md`, `SOUL.md`)으로 저장되는 구조입니다.

이 문서는 Markdown 을 검토 가능하고 정본(canonical)인 단일 소스 오브 트루스로 유지하면서, 파생 인덱스를 통해 **구조화된 회상** (검색, 엔티티 요약, 신뢰도 업데이트)을 추가하는 **오프라인 우선** 메모리 아키텍처를 제안합니다.

## 왜 변경하는가?

현재 설정 (하루당 하나의 파일)은 다음에 매우 적합합니다:

- “append-only” 저널링
- 사람에 의한 편집
- git 기반 내구성 + 감사 가능성
- 낮은 마찰의 기록 (“그냥 적기”)

약한 부분:

- 높은 회상률의 검색 (“X 에 대해 무엇을 결정했지?”, “마지막으로 Y 를 시도한 게 언제였지?”)
- 여러 파일을 다시 읽지 않고는 어려운 엔티티 중심 답변 (“Alice / The Castle / warelay 에 대해 알려줘”)
- 의견/선호의 안정성 (그리고 변경 시의 근거)
- 시간 제약 (“2025년 11월에는 무엇이 사실이었나?”) 및 충돌 해결

## 설계 목표

- **오프라인**: 네트워크 없이 동작하며, 노트북/Castle 에서 실행 가능; 클라우드 의존성 없음.
- **설명 가능성**: 검색된 항목은 출처 (파일 + 위치)가 명확해야 하며, 추론과 분리 가능해야 함.
- **낮은 의식 비용**: 일일 로깅은 Markdown 을 유지하고, 무거운 스키마 작업을 요구하지 않음.
- **점진성**: v1 은 FTS 만으로도 유용해야 하며, 시맨틱/벡터 및 그래프는 선택적 업그레이드.
- **에이전트 친화적**: “토큰 예산 내 회상”을 쉽게 함 (작은 사실 묶음을 반환).

## 노스 스타 모델 (Hindsight × Letta)

혼합할 두 가지 요소:

1. **Letta/MemGPT 스타일 제어 루프**

- 항상 컨텍스트에 유지되는 작은 “코어” (페르소나 + 핵심 사용자 사실)
- 나머지는 모두 컨텍스트 외부에 있으며 도구를 통해 검색
- 메모리 쓰기는 명시적 도구 호출 (append/replace/insert)로 수행되고, 영속화된 후 다음 턴에 재주입됨

2. **Hindsight 스타일 메모리 서브스트레이트**

- 관측된 것 vs 믿는 것 vs 요약된 것을 분리
- retain/recall/reflect 지원
- 증거에 따라 진화할 수 있는 신뢰도 포함 의견
- 엔티티 인식 검색 + 시간적 질의 (완전한 지식 그래프 없이도)

## 제안 아키텍처 (Markdown 단일 소스 오브 트루스 + 파생 인덱스)

### 정본 저장소 (git 친화적)

`~/.openclaw/workspace` 을 사람이 읽을 수 있는 정본 메모리로 유지합니다.

권장 워크스페이스 레이아웃:

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

노트:

- **일일 로그는 일일 로그로 유지**합니다. JSON 으로 바꿀 필요가 없습니다.
- `bank/` 파일은 성찰 작업에 의해 생성되는 **큐레이션된** 결과물이지만, 여전히 수동 편집이 가능합니다.
- `memory.md` 은 “작고 + 코어에 가까운” 상태를 유지합니다. 즉, Clawd 가 매 세션마다 보기를 원하는 내용입니다.

### 파생 저장소 (머신 회상)

워크스페이스 하위에 파생 인덱스를 추가합니다 (반드시 git 추적일 필요는 없음):

```
~/.openclaw/workspace/.memory/index.sqlite
```

다음으로 보완하세요:

- 사실 + 엔티티 링크 + 의견 메타데이터를 위한 SQLite 스키마
- 어휘 기반 회상을 위한 SQLite **FTS5** (빠르고, 작고, 오프라인)
- 시맨틱 회상을 위한 선택적 임베딩 테이블 (여전히 오프라인)

이 인덱스는 항상 **Markdown 으로부터 재구성 가능**해야 합니다.

## Retain / Recall / Reflect (운영 루프)

### Retain: 일일 로그를 “사실”로 정규화

여기서 중요한 Hindsight 의 핵심 통찰: 아주 작은 스니펫이 아니라 **서사적이고 자족적인 사실**을 저장하라는 점입니다.

`memory/YYYY-MM-DD.md` 을 위한 실용적 규칙:

- 하루가 끝날 때 (또는 중간에), 2–5 개의 불릿으로 구성된 `## Retain` 섹션을 추가:
  - 서사적임 (턴 간 맥락 유지)
  - 자족적임 (나중에 단독으로 읽어도 이해 가능)
  - 타입 + 엔티티 언급 태그 포함

예시:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

최소 파싱:

- 타입 접두사: `W` (world), `B` (experience/biographical), `O` (opinion), `S` (observation/summary; 보통 생성됨)
- 엔티티: `@Peter`, `@warelay` 등 (슬러그는 `bank/entities/*.md` 에 매핑)
- 의견 신뢰도: `O(c=0.0..1.0)` (선택)

작성자가 이를 신경 쓰고 싶지 않다면, reflect 작업이 로그의 나머지 부분에서 이러한 불릿을 추론할 수 있습니다. 그러나 명시적인 `## Retain` 섹션을 두는 것이 가장 쉬운 “품질 레버”입니다.

### Recall: 파생 인덱스에 대한 질의

Recall 은 다음을 지원해야 합니다:

- **어휘 기반**: “정확한 용어 / 이름 / 명령 찾기” (FTS5)
- **엔티티 기반**: “X 에 대해 알려줘” (엔티티 페이지 + 엔티티 연결 사실)
- **시간 기반**: “11월 27일 전후에 무슨 일이 있었지” / “지난주 이후”
- **의견 기반**: “Peter 는 무엇을 선호하나?” (신뢰도 + 근거 포함)

반환 형식은 에이전트 친화적이어야 하며 출처를 인용해야 합니다:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (출처 날짜, 또는 존재할 경우 추출된 시간 범위)
- `entities` (`["Peter","warelay"]`)
- `content` (서사적 사실)
- `source` (`memory/2025-11-27.md#L12` 등)

### Reflect: 안정 페이지 생성 + 신념 업데이트

Reflection 은 스케줄된 작업 (일일 또는 하트비트 `ultrathink`)으로, 다음을 수행합니다:

- 최근 사실로부터 `bank/entities/*.md` 업데이트 (엔티티 요약)
- 강화/모순에 따라 `bank/opinions.md` 신뢰도 업데이트
- 선택적으로 `memory.md` (“코어에 가까운” 지속 사실)에 대한 편집 제안

의견 진화 (단순하고 설명 가능):

- 각 의견은 다음을 가짐:
  - 진술
  - 신뢰도 `c ∈ [0,1]`
  - last_updated
  - 증거 링크 (지지 + 반박 사실 ID)
- 새로운 사실이 도착하면:
  - 엔티티 겹침 + 유사도로 후보 의견 탐색 (먼저 FTS, 이후 임베딩)
  - 작은 델타로 신뢰도 업데이트; 큰 변화는 강한 모순 + 반복된 증거가 필요

## CLI 통합: 독립형 vs 심층 통합

권장 사항: **OpenClaw 에 심층 통합**, 단 분리 가능한 코어 라이브러리는 유지.

### 왜 OpenClaw 에 통합하는가?

- OpenClaw 는 이미 다음을 알고 있음:
  - 워크스페이스 경로 (`agents.defaults.workspace`)
  - 세션 모델 + 하트비트
  - 로깅 + 문제 해결 패턴
- 에이전트 자체가 도구를 호출하길 원함:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### 왜 라이브러리는 분리하는가?

- Gateway/런타임 없이도 메모리 로직을 테스트 가능하게 유지
- 다른 컨텍스트 (로컬 스크립트, 미래의 데스크톱 앱 등)에서 재사용

형태:
메모리 도구는 작은 CLI + 라이브러리 레이어를 의도하지만, 이는 탐색적 단계에 불과합니다.

## “S-Collide” / SuCo: 언제 사용할 것인가 (연구)

“S-Collide” 가 **SuCo (Subspace Collision)** 를 의미한다면, 이는 서브스페이스에서의 학습/구조화된 충돌을 사용해 강한 회상률/지연 시간 트레이드오프를 목표로 하는 ANN 검색 접근법입니다 (논문: arXiv 2411.14754, 2024).

`~/.openclaw/workspace` 을 위한 실용적 관점:

- SuCo 로 **시작하지 말 것**.
- SQLite FTS + (선택적) 단순 임베딩으로 시작하면 대부분의 UX 이득을 즉시 얻을 수 있음.
- 다음 조건이 충족될 때만 SuCo/HNSW/ScaNN 계열 솔루션을 고려:
  - 코퍼스가 큼(수만~수십만 개의 청크)
  - 브루트포스 임베딩 검색이 너무 느려짐
  - 회상 품질이 어휘 검색에 의해 의미 있게 병목됨

오프라인 친화적 대안 (복잡도 증가 순):

- SQLite FTS5 + 메타데이터 필터 (ML 없음)
- 임베딩 + 무차별 대입(청크 수가 적으면 놀랄 만큼 잘 작동함)
- HNSW 인덱스 (일반적이고 견고함; 라이브러리 바인딩 필요)
- SuCo (연구 등급; 임베드 가능한 견고한 구현이 있다면 매력적)

열린 질문:

- 노트북 + 데스크톱 환경에서 “개인 비서 메모리”에 **가장 적합한** 오프라인 임베딩 모델은 무엇인가?
  - 이미 Ollama 가 있다면 로컬 모델로 임베딩; 아니라면 도구체인에 작은 임베딩 모델을 포함.

## 가장 작은 유용한 파일럿

최소하지만 여전히 유용한 버전을 원한다면:

- `bank/` 엔티티 페이지와 일일 로그에 `## Retain` 섹션을 추가.
- 인용 (경로 + 라인 번호)과 함께 SQLite FTS 를 사용한 회상 구현.
- 회상 품질이나 규모가 요구할 때만 임베딩 추가.

## References

- Letta / MemGPT 개념: “core memory blocks” + “archival memory” + 도구 기반 자기 편집 메모리.
- Hindsight Technical Report: “retain / recall / reflect”, 네트워크 4중 메모리, 서사적 사실 추출, 의견 신뢰도 진화.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” 근사 최근접 이웃 검색.
