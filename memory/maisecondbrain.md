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
- **GraphRAG**: 벡터 임베딩 + 그래프 관계 탐색 하이브리드
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

| BOT | Mnemo 연동 효과 |
|-----|----------------|
| BOTALKS | 대화 히스토리 → 지식그래프 → 맥락 기억 강화 |
| BOTCON | 예약 패턴/선호도 → 그래프 → 개인화 추천 |
| BOTTOK | TikTok 댓글 분석 → 지식 축적 → 트렌드 예측 |
| BOTTUTOR | 학습 진도 → 그래프 관리 → 망각 곡선 복습 |

## 수익화 5채널

| # | 채널 | 가격 | 시기 |
|---|------|------|------|
| 1 | Obsidian 프리미엄 플러그인 | $5/월 | Phase 2 (4-8주) |
| 2 | clawhub 스킬 | 구독 | Phase 3 (8-12주) |
| 3 | BOTMEMO 앱 (BOT Suite #7) | ₩5,900/월 | Phase 3 (8-12주) |
| 4 | 교육 코스 | $49 | Phase 4 (12주+) |
| 5 | Mnemo Cloud (SaaS) | $15/월 | Phase 4 (12주+) |

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

## 결정사항

- 브랜드명: Mnemo (므네모)
- Neo4j 불필요 — Obsidian 볼트 자체가 지식그래프, NetworkX 인메모리로 충분
- Obsidian-native (노션 아닌 옵시디언: 데이터 소유권, 로컬 저장, 마크다운 파워)
- 첫 적용 대상: MAIBOT (3,037 파일 볼트 + memory 23개)
- BOT Suite #7 (BOTMEMO)로 편입 — MAICON(BOTCON) 패턴 동일
- Mnemo = BOT Suite의 "뇌" — 다른 봇의 활동 데이터를 지식으로 연결·축적·추론

## 다음 액션

- [ ] Sprint 1 착수: Python 프로젝트 초기화 + 볼트 파서 개발
- [ ] JINI_SYNC 3,037파일 그래프 빌드 테스트
- [ ] 임베딩 + GraphRAG 쿼리 엔진
- [ ] MAIBOT OpenClaw 스킬 연동

## 문서 목록

| 문서 | 내용 |
|------|------|
| A001-PRD.md | 제품 기획 전체 |
| A002-경쟁분석.md | 7개 경쟁사 비교 |
| A003-기술분석.md | 기술 스택 심층 |
| A004-수익화-전략.md | 5채널 수익 + BOT Suite 시너지 + GTM |
| D001-아키텍처-설계.md | 시스템 구성도 + API |
| D002-온톨로지-스키마.md | 9개 엔티티 + 11개 관계 |
| D003-노드링크-설계.md | 그래프 구조 + 옵시디언 적용법 |
| I001-개발계획.md | Sprint 1-2 상세 + 마일스톤 |
