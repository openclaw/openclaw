# 🇻🇳 베트남 호치민 화장품 사업 (BnF)

## 개요

- **회사:** (주)뷰티앤팩토리 (BeautyNFactory)
- **시장:** 베트남 호치민 (HCMC)
- **핵심 전략:** 인건비 집약 → AI 기술 집약 고마진 모델 전환
- **자료 폴더:** `C:\Users\jini9\OneDrive\01.COMPANY\DATABROKER\02.PROJECT\110.베트남 화장품사업`
- **아이디어 도구:** Google NotebookLM

### 개발 환경
- **로컬 워크스페이스:** `C:\TEST\MAIBEAUTY`
- **GitHub:** https://github.com/jini92/MAIBEAUTY
- **개발 도구:** Claude Code
- **플로우:** Claude Code 개발 → 커밋 → `git push origin main`
- **문서:** `docs/` — A(분석)/D(설계)/I(구현)/T(테스트)
- **소스:** `src/agents/`, `src/workflows/`, `src/scripts/`, `src/config/`

---

## AI 6대 모델 (블루프린트)

### Phase 1. Discovery (발견)
| 모델 | 설명 | 상태 |
|------|------|------|
| Model 01 — Faceless Salesman | AI 아바타 + TikTok Symphony, 베트남어 영상 하루 3~5개 자동 생성 | ⬜ 미착수 |
| Model 02 — Viral Content Factory | Opus Clip으로 라이브 1시간 → 숏폼 10개+ 자동 클리핑 | ⬜ 미착수 |

### Phase 2. Search (검색/비교)
| 모델 | 설명 | 상태 |
|------|------|------|
| Model 06 — Ecommerce Agent | Shopee/Lazada 가격·재고 24시간 자동 방어 (마진 15% 사수) | ⬜ 미착수 |
| Model 04 — AI Product Photography | Midjourney + Photoshop AI → 백화점급 연출 컷 변환 | ⬜ 미착수 |

### Phase 3. Loyalty (관계/재구매)
| 모델 | 설명 | 상태 |
|------|------|------|
| Model 05 — AI Mediator (n8n) | TikTok→Zalo→CRM 전체 파이프라인 자동화 | ⬜ 미착수 |
| Model 03 — AI Copywriting | Dead Lead Reactivator, Zalo 초개인화 메시지 자동 발송 | ⬜ 미착수 |

---

## 회사 정보

### 원청 — (주)뷰티앤팩토리 (BeautyNFactory Co., Ltd.)
- **역할:** 화장품 제조·유통 (원청)
- **설립:** 2015년 10월
- **CEO:** 오창렬
- **사업자번호:** 261-87-00227
- **보유 브랜드:** ~100개 K-Beauty 브랜드
- **주요 제품:** &done 톤업선프로텍터, DERMA:EL 마스크팩, SCINIC, CLIO 등
- **베트남 경험:** 2015 합작법인 설립 → 2023 페리페라/구달 공급 → 2024 KBS JOY 라이브 방송

### 판매 — 러브 투 러브 (Lov2Luv)
- **역할:** 전자상거래 소매·중개 (베트남 시장 판매)
- **대표자:** 김미정
- **사업자번호:** 315-20-72461
- **과세유형:** 간이과세자
- **업태/종목:** 소매업 / 전자상거래 소매업, 전자상거래 소매 중개업
- **소재지:** 경기도 고양시 일산동구 위시티4로 79, 308동 1101호
- **개업일:** 2026-03-03

---

## 진행 기록

### 2026-01-30
- [x] 프로젝트 자료 폴더 확인 및 분석
- [x] PT 15페이지 (AI 기반 베트남 뷰티 세일즈 오토메이션) 전체 분석 완료
- [x] 전략 분석 문서 (BeautyNFactory_Vietnam_Strategy_Analysis.md) 확인
- [x] 프로젝트 관리 구조 생성 (MEMORY.md + memory/)

### 2026-01-31
- [x] A004 — 문서 리뷰 분석 (강점·약점·보안 감사)
- [x] A005 — 약점 보완 계획 (24건 상세 대응)
- [x] D001~D005 — A005 보완사항 반영 (웹훅 HMAC, 관측성, GPU 스케줄링 등)
- [x] D006 — n8n MCP 연동 설계 (방향A: Claude Code → n8n 채택)
- [x] n8n 인스턴스 URL + API Key 설정 완료
  - URL: `https://mai-n8n.app.n8n.cloud`
  - 프로젝트: MAIBEAUTY (`ovmDGUOrf012DVLX`)
  - MCP: `n8n-mcp` 패키지 사용 (stdio 모드)
  - `.mcp.json` 설정 완료

### 다음 액션
- [ ] n8n MCP 설정 완료 → `.mcp.json` 업데이트
- [ ] 6대 모델 중 우선 착수할 모델 결정
- [ ] n8n 워크플로우 설계 (PT 권장: 첫 번째 마이크로플로우)
- [ ] TikTok + Zalo 연동 파이프라인 구체화

---

## 결정 사항

| 날짜 | 결정 | 근거 |
|------|------|------|
| 2026-01-30 | 블루프린트 6대 AI 모델 확정 | PT_Vietnam_AI_Sales_AutoPilot.pdf |
| 2026-01-31 | n8n MCP 연동 방향 A 채택 (Claude Code → n8n) | 개발 중 자연어 실행, 설정 간편, IDE 내 전체 시스템 제어 |

---

## 참고 자료

- `01.분석/BeautyNFactory_Vietnam_Strategy_Analysis.md` — 시장 전략 매칭 분석
- `01.분석/! 03_PT_Vietnam_AI_Sales_AutoPilot.pdf` — AI 세일즈 오토메이션 블루프린트 (15p)
- `01.분석/! 01_PT-*.pdf` — BnF 쇼퍼테인먼트 전략
- `01.분석/! 02_PT-*_n8n.pdf` — n8n 통합 전략

---

*Last updated: 2026-01-31*
