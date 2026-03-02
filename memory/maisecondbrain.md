---
type: project-memory
project: MAISECONDBRAIN
tags: [knowledge-graph, second-brain, mnemo, obsidian]
related:
  - "[[maioss|MAIOSS - OSS 보안]]"
  - "[[maitutor|MAITUTOR - AI 튜터]]"
  - "[[tech-intelligence|기술 인텔리전스]]"
---

# MAISECONDBRAIN (Mnemo)

- **시작일:** 2026-02-20
- **로컬:** C:\TEST\MAISECONDBRAIN
- **GitHub:** https://github.com/jini92/MAISECONDBRAIN
- **Obsidian:** 01.PROJECT/13.MAISECONDBRAIN
- **상태:** 🟢 진행중
- **브랜드명:** Mnemo (므네모) — 기억의 여신 Mnemosyne에서 착안

## 목표

개인의 지식과 경험을 온톨로지 기반 지식그래프로 구조화하고, GraphRAG로 맥락적 검색·추론을 수행하는 개인화 AI 세컨드브레인 시스템 구축.

**첫 번째 적용 대상: MAIBOT** — 볼트 3,037개 파일 + memory 23개를 GraphRAG로 검색, 기존 memory_search 보강/대체.

## 핵심 기술 스택

- **데이터 레이크 + 지식그래프**: Obsidian (Markdown + YAML + `[[위키링크]]`) — 볼트 자체가 source of truth
- **그래프 엔진**: NetworkX (Python 인메모리) — 볼트에서 동적 빌드
- **임베딩 모델**: qwen3-embedding:0.6b (1024d, MTEB 다국어 1위) — nomic-embed-text(768d)에서 전환 (2026-02-24)
- **GraphRAG**: 벡터 임베딩 + 그래프 관계 탐색 하이브리드 + Cross-Encoder Reranker
- **AI 에이전트**: OpenClaw (MAIBOT) — 크론, 수집, 분석, 복습
- **언어**: Python (그래프/RAG) + TypeScript (Obsidian 플러그인)

## 생태계 포지셔닝: BOT Suite의 "뇌"

```
Mnemo
├── OpenClaw 스킬 (mnemo) → 모든 MAI 프로젝트에 적용
├── Obsidian 플러그인 → 커뮤니티 200만+ 배포
├── clawhub 스킬 → OpenClaw 생태계
└── BOTMEMO 앱 → BOT Suite #7
```

### BOT Suite 시너지

| BOT      | Mnemo 연동 효과                             |
| -------- | ------------------------------------------- |
| BOTALKS  | 대화 히스토리 → 지식그래프 → 맥락 기억 강화 |
| BOTCON   | 예약 패턴/선호도 → 그래프 → 개인화 추천     |
| BOTTOK   | TikTok 댓글 분석 → 지식 축적 → 트렌드 예측  |
| BOTTUTOR | 학습 진도 → 그래프 관리 → 망각 곡선 복습    |

## 수익화 5채널

| #   | 채널                       | 가격      | 시기             |
| --- | -------------------------- | --------- | ---------------- |
| 1   | Obsidian 프리미엄 플러그인 | $5/월     | Phase 2 (4-8주)  |
| 2   | clawhub 스킬               | 구독      | Phase 3 (8-12주) |
| 3   | BOTMEMO 앱 (BOT Suite #7)  | ₩5,900/월 | Phase 3 (8-12주) |
| 4   | 교육 코스                  | $49       | Phase 4 (12주+)  |
| 5   | Mnemo Cloud (SaaS)         | $15/월    | Phase 4 (12주+)  |

목표: 6개월 ~$825/월 → 12개월 ~$4,845/월

## 개발 로드맵

### Phase 1: MAIBOT 적용 (4주) ← 현재

- Sprint 1 (W1-2): 볼트 파서 + NetworkX 그래프 빌더
- Sprint 2 (W3-4): 임베딩 + GraphRAG 쿼리 + MAIBOT 연동

### Phase 2: Obsidian 플러그인 (4-8주)

- Obsidian Plugin API (TypeScript)
- 인라인 질의 UI + 관계 시각화

### Phase 3: clawhub + BOTMEMO (8-12주)

- clawhub 스킬 배포
- BOTMEMO 앱 (React Native, BOTALKS 인프라 공유)

### Phase 4: Cloud + 교육 (12주+)

- Mnemo Cloud SaaS
- 온라인 코스

## 아이디어 원천

- "평범한 사업가" YouTube #74 (GraphRAG+온톨로지), #77 (옵시디언 플러그인)
- 옵시디언 = 개인용 최적 RAG (데이터 소유권, 마크다운 위계, 무한 확장성)
- 기업 온톨로지(팔란티어) → 개인 수준 축소 적용

## 진행상황

- 2026-02-20: 프로젝트 초기화 (workspace, GitHub, Obsidian, memory)
- 2026-02-20: 문서 8종 작성 완료 (PRD, 경쟁분석, 기술분석, 수익화전략, 아키텍처, 온톨로지스키마, 노드링크설계, 개발계획)
- 2026-02-20: **Sprint 1 완료** — 볼트 파서 + 그래프 빌더 + CLI (3,113 노트 → 2,475 노드 + 16,576 엣지, 19초)
- 2026-02-20: **Sprint 2 완료** — 임베딩(Ollama nomic-embed-text, 2,164개, 46초) + GraphRAG 하이브리드 검색(키워드50%+벡터30%+그래프20%) + FastAPI API + MAIBOT 스킬
- 2026-02-20: **종합 검증 T002** — 빌드(2.8s) ✅, 검색 4/5 정확(80%), daily_enrich 39.1s 풀 파이프라인 ✅, 캐시 경로 이슈 발견→수정, 최종 그래프 2,481노드 29,352엣지
- 2026-02-21: **대규모 개선** — YAML relations 위키링크 수정, Mnemo MAIBOT 통합 (search.py + integrated_search.py)
- 2026-02-21: **팀에이전트 풀 점검** — 품질분석(T003) + frontmatter보강(T004) + 임베딩99.9%(T005) + memory24개 보강
- 2026-02-21: **P001 개선** — 댕글링 스텁 31개 생성(댕글링 0 달성) + 경로 기반 고유키(중복 932개 분리)
- 2026-02-21: **최종 수치** — 3,474 노드 / 30,328 엣지 / 381 컴포넌트 / 댕글링 0 / 임베딩 99.9% / 검색 5/5
- 2026-02-21: **MAI Universe Pipeline v1.0** — 6단계 풀사이클 자동화 스킬
- 2026-02-21: **Stage 2/5/6 자동화** — 기회 스코어링 + 배포 스킬 + KPI 대시보드
- 2026-02-24: **Daily Enrichment (cron)** — 3,395 볼트 + 36 memory 파싱 → struct 27 + related 17 + content 57 보강 | 그래프 3,486 노드 39,590 엣지 (1 컴포넌트!) | 스텁 50개 생성 | 임베딩 3,423개(+29 new) | 외부지식 22개 수집 | 대시보드 2개 갱신 | 84초 완료
- 2026-02-25: **Daily Enrichment (cron)** — 3,442 볼트 + 37 memory 파싱 → struct 34 + content 84 보강 | 그래프 2,918 노드 32,034 엣지 (1 컴포넌트) | 스텁 50개 생성 | 임베딩 3,471개(+9 new) | 외부지식 22개 수집 | 기회 100건(황금 0) | 대시보드 7섹션 갱신 | 89초 완료
- 2026-02-24: **Stage 2 DISCOVER 자동화 완성** — daily_enrich.py에 10단계(기회 스캔) 추가 + 주간 기회 리뷰 크론 등록 (월 07:30 KST) | 지식 수집 → 기회 탐지 → 스코어링 → 프로젝트 도출 풀 파이프라인 완성
- 2026-02-24: **온톨로지 v2** — 엔티티 분류 보강(tool 618개, concept 163개, decision 3개 새로 분류) + 의미적 관계 자동 추출(uses 1,144 / derived_from 807 / alternatives 278 / supports 249 / contradicts 3 = 총 2,481 엣지) + 가비지 노드 745개 정리(3,511→2,893) + 밀도 0.0029→0.0038(+30%)
- 2026-02-24: **Phase 3.5 person 추출** — extract_persons.py(llama3.1:8b) 생성, 12 person stubs (Sam Altman, Jensen Huang, 김철수, 이진희 등), cleanup_person_stubs.py로 오탐(Morgan Stanley, Temasek 등) 제거
- 2026-02-24: **Phase 4 검색 고도화** — Reranker A/B 테스트(8쿼리×4구성): Reranker +8% 관련도(0.521→0.562), 동적 가중치 단독 효과 미미(-8%). query_classifier.py(factual/relational/exploratory) + GraphRAG 프롬프트 쿼리타입별 분기 + search_ab_test.py 벤치마크 스크립트
- 2026-02-24: **임베딩 모델 전환** — nomic-embed-text(768d, hit 6%) → qwen3-embedding:0.6b(1024d, hit 33%, 5.5배 개선). 전체 3,462 벡터 재빌드. MNEMO_EMBED_MODEL 환경변수 오버라이드 지원. 전환 후 baseline 0.583(+12%), reranker 0.604
- 2026-02-24: **A002 온톨로지 개선 계획 전체 완료** — Phase 1(엔티티 분류) + Phase 2(가비지 정리) + Phase 3(의미적 관계) + Phase 3.5(person LLM 추출) + Phase 4(검색 고도화) 모두 ✅
- 2026-02-27: **Obsidian 커뮤니티 플러그인 PR #10406** — ObsidianReviewBot 자동 스캔 결과 수신 (Required: any 타입 제거, sentence case, await 누락, style 직접 설정, default hotkey, console.log 등)
- 2026-03-01: **PR #10406 봇 검증 통과** — 코드 수정 push 후 봇 재스캔 통과. "Ready for review" 라벨 부여, 휴먼 리뷰어 배정 대기 중. 수 주 소요 가능

## 결정사항

- 브랜드명: Mnemo (므네모)
- Neo4j 불필요 — Obsidian 볼트 자체가 지식그래프, NetworkX 인메모리로 충분
- Obsidian-native (노션 아닌 옵시디언: 데이터 소유권, 로컬 저장, 마크다운 파워)
- 첫 적용 대상: MAIBOT (3,037 파일 볼트 + memory 23개)
- BOT Suite #7 (BOTMEMO)로 편입 — MAICON(BOTCON) 패턴 동일
- Mnemo = BOT Suite의 "뇌" — 다른 봇의 활동 데이터를 지식으로 연결·축적·추론
- Reranker ON 기본 추천: `MNEMO_USE_RERANKER=true` (cross-encoder +8% 관련도)
- 동적 가중치: opt-in only (`--dynamic-weights` 플래그)
- LLM 추출 기본: llama3.1:8b (qwen3:8b thinking mode empty response 이슈)
- 임베딩 모델 환경변수: `MNEMO_EMBED_MODEL` (기본값: qwen3-embedding:0.6b)

## 다음 액션

- [x] Sprint 1: 볼트 파서 + 그래프 빌더 + CLI
- [x] Sprint 2: 임베딩 + GraphRAG + API + 스킬
- [x] 태그 공유 엣지 추가 → 3,820 tag_shared 엣지
- [x] daily_enrich.py 7단계 파이프라인 (외부 지식 수집 포함)
- [x] **종합 검증 (T002)**: 빌드 ✅ | 검색 80% 정확/100% 관련 | 파이프라인 39초 | 캐시 경로 수정
- [x] Mnemo를 memory_search 대체/보강으로 MAIBOT 핵심 루프에 통합 (search.py + integrated_search.py)
- [x] YAML relations 엣지 수정 ([[위키링크]] 형식)
- [x] **P001 개선**: 댕글링 스텁 생성 (31개) + 경로 기반 고유키 (전체 모듈 리팩토링)
- [x] 옵시디언 대시보드 자동 싱크 (daily_enrich 8단계)
- [x] 기회 탐지 + 스코어링 시스템 (Stage 2 DISCOVER)
- [x] **온톨로지 v2**: 엔티티 7/8종 활용 + 의미적 엣지 2,481건 + 가비지 745노드 정리
- [x] **Phase 3.5**: LLM 기반 person 추출 (llama3.1:8b, 12 person stubs)
- [x] **Phase 4 검색 고도화**: Reranker A/B (+8% 관련도) + 쿼리 분류기 + GraphRAG 프롬프트 개선
- [ ] Phase 2: Obsidian 플러그인 (TypeScript)
- [ ] NotebookLM 공식 API 출시 시 Mnemo 통합

## 이슈 자동 대응

- **활성화:** 2026-02-21
- **방식:** HEARTBEAT Active Tracking (매 하트비트마다 체크)
- **대응 정책:** 버그→직접 수정, 기능요청→분석+보고, 질문→답변
- **마지막 체크 이슈:** #0 (아직 이슈 없음, 2026-03-02 04:00 KST 확인)
- **Repo visibility:** PUBLIC (2026-02-21 전환)

## 문서 목록

| 문서                    | 내용                                |
| ----------------------- | ----------------------------------- |
| A001-PRD.md             | 제품 기획 전체                      |
| A002-경쟁분석.md        | 7개 경쟁사 비교                     |
| A003-기술분석.md        | 기술 스택 심층                      |
| A004-수익화-전략.md     | 5채널 수익 + BOT Suite 시너지 + GTM |
| D001-아키텍처-설계.md   | 시스템 구성도 + API                 |
| D002-온톨로지-스키마.md | 9개 엔티티 + 11개 관계              |
| D003-노드링크-설계.md   | 그래프 구조 + 옵시디언 적용법       |
| I001-개발계획.md        | Sprint 1-2 상세 + 마일스톤          |
| A002-온톨로지-개선-계획 | 4 Phase 온톨로지 개선 로드맵        |
