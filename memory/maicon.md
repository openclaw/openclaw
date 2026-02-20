---
type: project-memory
project: MAICON
tags: [vietnam, concierge, local-service, booking]
related:
  - "[[maistar7|MAISTAR7 - 인력 매칭]]"
  - "[[vietnam-beauty|MAIBEAUTY - 화장품 사업]]"
  - "[[maibotalks|MAIBOTALKS - 음성대화]]"
---

# MAICON (MAI Concierge) — AI 베트남 로컬 서비스 예약 에이전트

**상태:** 🟢 진행중
**시작일:** 2026-02-13
**로컬:** `C:\TEST\MAICON`
**GitHub:** https://github.com/jini92/MAICON

---

## 개요

베트남 호치민 거주/방문 외국인(특히 한국인)을 위한 AI 로컬 서비스 예약 에이전트.
사진관, 미용실, 병원 등 로컬 서비스를 한국어/영어로 검색 → 예약까지.

**발단:** 지니님 호치민 체류 중 사진관 예약 불편 경험 (2026-02-13)

## 핵심 전략

- 타겟: 호치민 한인 교민 20만+ (P0), 외국인 거주자 30만+ (P1)
- MVP: 텔레그램 챗봇 — 위치 기반 업체 검색 + 베트남어 예약 메시지 생성
- 수익: 건당 $2~5 → 구독 $9.99/월 → B2B $99/월/인
- 기술: Python + Claude API + Google Maps Places API + PostgreSQL

## 로드맵

- Phase 1 (MVP): 텔레그램 봇 — 검색 + 메시지 생성 (4주)
- Phase 2: Zalo 연동 + AI 전화 예약 (8주)
- Phase 3: 플랫폼화 + 도시 확장 (12주+)

## BOT Suite 연계 (2026-02-18 확정)

- **앱 이름:** BOTCON (Bot + Concierge) — BOT Suite #6
- **전략:** MAICON을 BOT Suite 라인업에 추가, 독립 앱으로 먼저 → 성공 시 BOTALKS 통합 검토
- **차이점:** BOTCON은 서버 비용 발생 (Google Maps + Vapi) → 구독 ₩9,900/월
- **스택:** React Native + Expo (BOTALKS와 동일) + `<gmp-map>` WebView
- **clawhub 스킬:** `botcon`

## 시너지

- MAIBEAUTY → 뷰티 업체 네트워크 + 고객 DB
- MAISTAR7 → B2B 기업 채널
- MAIBOTALKS → BOT Suite 공유 인프라, 사용자 기반
- BnF → 현지 사업자등록 + 네트워크

## 문서

- `docs/A001_market_analysis.md` — 시장 분석
- `docs/D001_PRD.md` — PRD

## 결정사항

- 2026-02-13: 프로젝트 생성, PRD 작성
- 2026-02-13: 문서 작업(PRD 등)은 서브에이전트 활용할 것 (지니님 요청)

## 다음 액션

- [ ] 시장 서베이 (한인 커뮤니티)
- [ ] MVP 개발 시작 (텔레그램 봇)
- [ ] Google Maps Places API 연동 테스트
- [ ] 시범 업체 5곳 확보
- [ ] GitHub 레포 생성
