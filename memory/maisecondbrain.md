# MAISECONDBRAIN (Mnemo)

- **시작일:** 2026-02-20
- **로컬:** C:\TEST\MAISECONDBRAIN
- **GitHub:** https://github.com/jini92/MAISECONDBRAIN
- **Obsidian:** 01.PROJECT/13.MAISECONDBRAIN
- **상태:** 🟢 진행중
- **브랜드명:** Mnemo (므네모) — 기억의 여신 Mnemosyne에서 착안

## 목표

개인의 지식과 경험을 온톨로지 기반 지식그래프로 구조화하고, GraphRAG로 맥락적 검색·추론을 수행하는 개인화 AI 세컨드브레인 시스템 구축.

### 핵심 기술 스택

- **데이터 레이크 + 지식그래프**: Obsidian (Markdown + YAML + `[[위키링크]]`) — 볼트 자체가 source of truth
- **그래프 엔진**: NetworkX (Python 인메모리) — 볼트에서 동적 빌드
- **GraphRAG**: Microsoft GraphRAG / LightRAG / 커스텀
- **AI 에이전트**: OpenClaw (MAIBOT)
- **언어**: Python (그래프/RAG) + TypeScript (Obsidian 플러그인)

### 4단계 로드맵

1. 지식 수집 파이프라인 (RSS, 웹클리핑, YouTube 요약)
2. 온톨로지 그래프 구축 (엔티티 추출, 관계 매핑, NetworkX 인메모리)
3. GraphRAG 검색 엔진 (벡터+그래프 하이브리드, 멀티홉 추론)
4. AI 에이전트 자동화 (복습, 브리핑, 연결 제안)

### 수익화 모델

1. SaaS (Mnemo Cloud)
2. Obsidian 프리미엄 플러그인
3. 기업용 지식그래프 API
4. 온라인 교육 코스
5. 컨설팅

## 아이디어 원천

- "평범한 사업가" YouTube 팟캐스트 #74 (GraphRAG+온톨로지), #77 (옵시디언 플러그인)
- 옵시디언이 개인용 최적 RAG 시스템인 이유: 데이터 소유권, 마크다운 위계, 무한 확장성
- 기업 온톨로지 시스템(팔란티어 등)을 개인 수준으로 축소·적용

## 진행상황

- 2026-02-20: 프로젝트 초기화 (workspace, GitHub, Obsidian, memory)

## 결정사항

- 브랜드명: Mnemo (므네모)
- Neo4j 불필요 — Obsidian 볼트 자체가 지식그래프, NetworkX 인메모리로 충분
- Obsidian을 데이터 레이크로 활용 (노션 아닌 옵시디언 선택 이유: 데이터 소유권, 로컬 저장, 마크다운 파워)

## 다음 액션

- [ ] PRD 작성 (A001-PRD.md)
- [ ] 온톨로지 스키마 설계
- [ ] Obsidian 마크다운 파서 프로토타입
- [ ] 경쟁 분석 (Mem, Reflect, Notion AI, Obsidian Copilot)
