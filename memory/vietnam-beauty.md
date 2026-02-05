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
- **⚠️ 필수:** 개발 진행 시마다 `docs/STATUS-Development-Overview.md` 반드시 업데이트할 것 (지니님 2026-02-03 요청)

---

## AI 6대 모델 (블루프린트)

### Phase 1. Discovery (발견)
| 모델 | 설명 | 상태 |
|------|------|------|
| Model 01 — Faceless Salesman | AI 아바타 + TikTok Symphony, 베트남어 영상 하루 3~5개 자동 생성 | 🟢 파이프라인 완성 (512px GFPGAN, T007) |
| Model 02 — Viral Content Factory | FFmpeg 씬 감지 + 바이럴 스코어 (Ollama) | 🟢 구현 완료 |

### Phase 2. Search (검색/비교)
| 모델 | 설명 | 상태 |
|------|------|------|
| Model 06 — Ecommerce Agent | Shopee/Lazada 가격 모니터링 + AI 방어 (Ollama) | 🟢 구현 완료 |
| Model 04 — AI Product Photography | 배경 제거 + 프롬프트 생성 + 멀티 해상도 | 🟢 구현 완료 |

### Phase 3. Loyalty (관계/재구매)
| 모델 | 설명 | 상태 |
|------|------|------|
| Model 05 — AI Mediator (n8n) | TikTok→Zalo→CRM 전체 파이프라인 자동화 | 🟡 인프라 구축 완료 |
| Model 03 — AI Copywriting | Dead Lead Reactivator, Zalo 초개인화 메시지 자동 발송 | 🟡 PoC 워크플로우 준비 완료 |

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

## 인프라 현황

| 컴포넌트 | 상태 | 상세 |
|----------|------|------|
| Ollama v0.15.2 | ✅ 정상 | RTX 4070 Super 12GB, CUDA 12.6 |
| qwen3:8b | ✅ 사용 가능 | Chat API 확인, 추론 ~225ms |
| llama3.1:8b | ✅ 설치됨 | 4.9GB |
| qwen2.5:14b | ✅ 설치됨 | 9.0GB (VRAM 제한 주의) |
| deepseek-r1:7b | ✅ 설치됨 | 4.7GB |
| n8n Docker | ✅ 실행중 | v2.4.8, localhost:5678, `maibeauty-n8n` |
| Cloudflare Tunnel | ✅ 설치됨 | cloudflared 2026.1.2, Quick Tunnel 모드 |
| Google Sheets API | ✅ 활성화 | 프로젝트: `maibeauty` |
| Google Drive API | ✅ 활성화 | 프로젝트: `maibeauty` |
| 서비스 계정 | ✅ 생성 | `maibeauty-crm@maibeauty.iam.gserviceaccount.com` |
| CRM 스프레드시트 | ✅ 생성 | [링크](https://docs.google.com/spreadsheets/d/1r_CSTQDPdZtiPTqPdXjYvpRmtZe0oH6cGoMaoboBFO4/edit) — 4탭 |
| 카카오 앱 (BnF AI Sales) | ✅ 설정 완료 | ID 1379417, REST API Key + Client Secret 활성화 |
| 카카오 OAuth 토큰 | ✅ 발급됨 | `~/.maibeauty/kakao-tokens.json`, 6시간 만료 + 자동 갱신 |
| WF-POC-01 | ✅ import | n8n에 배포됨 (Chat API 버전) |

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
- [x] n8n Cloud 인스턴스 설정 (`https://mai-n8n.app.n8n.cloud`)

### 2026-02-01
- [x] 멀티 LLM 전략 결정 및 문서화
- [x] On-Premise 환경 구축 (Ollama + 4개 모델)
- [x] On-Premise 착수 모델 결정: M05 + M03-PoC 2트랙
- [x] D007 — WF-POC-01 마이크로 워크플로우 설계
- [x] n8n 로컬 Docker 설치 (v2.4.8, localhost:5678)
- [x] WF-POC-01 n8n import + Ollama Chat API 전환
- [x] Ollama GPU 에러 해결 (PC 재부팅)
- [x] Google Cloud 인증 + Sheets/Drive API 활성화
- [x] 서비스 계정 생성 + 키 발급 + IAM editor
- [x] CRM 스프레드시트 생성 (4탭: Leads/Products/Campaigns/Analytics)
- [x] `.env` 설정 완료 (Ollama + Google Sheets)
- [x] I004, I005 문서 작성
- [x] git push 완료 (`7e0e4fa`, `69f21cb`, `3a378c7`)

### 2026-02-02 (저녁~)
- [x] M01 파이프라인 통합 (T007)
  - Step 1: Ollama qwen3:8b → 베트남어 TikTok 스크립트 (13초)
  - Step 1.5: Phonetic 후처리 (숫자/영어→베트남어 자동 변환)
  - Step 2: MMS-TTS-vie → WAV 음성 57.2초 (3.2초)
  - Step 3: SadTalker → MP4 영상 57.2초 (117.9초, 256px)
  - 총 소요 ~2분 14초, 비용 $0 (로컬 GPU)
  - 파이프라인 스크립트 5종 (pipeline + script-gen + postprocess + tts + avatar)
  - ✅ 512px 체크포인트 재다운로드 (725MB 정상)
  - ✅ GFPGAN enhancer로 512px 해결 (256px 렌더 → 512x512 출력, 340초)
  - 파이프라인 기본값: Size=256 + Enhancer=gfpgan

### 2026-02-02 (오전~오후)
- [x] WF-POC-02 설계 (D008 — CRM ↔ 카피 생성 연동)
- [x] Google Sheets 인증 라이브러리 구현 (SA JWT + ADC)
- [x] Sheets 클라이언트 구현 (read/write/append/addSheet)
- [x] CRM 시드 데이터 (Leads 5건 + Products 5건 + CopyResults 탭)
- [x] WF-POC-02 테스트 스크립트 구현 + 실행 → 4/4 PASS
- [x] n8n WF-POC-02 워크플로우 JSON (10노드)
- [x] T002, I006 문서 작성
- [x] git push 완료 (`65f459e`)
- [x] 품질 채점 v2 (9단계 세분화, 5~88점 분포)
- [x] WF-POC-03 Dead Lead Reactivator (상태별 3종 프롬프트)
- [x] A/B 프롬프트 테스트 프레임워크 (Friendly vs Expert)
- [x] Zalo OA API 리서치 (A006)
- [x] n8n WF-POC-03 워크플로우 (Schedule 9AM + 12노드)
- [x] D009, D010, A006, T003, I007 문서 작성
- [x] git push 완료
- [x] 카카오톡 채널 테스트 환경 구축 (I009)
  - Channel Dispatcher 추상화 (MessageChannel 인터페이스)
  - Kakao Client: OAuth 2.0 + "나에게 보내기" API + 3종 템플릿 빌더
  - 설정/테스트/파이프라인 스크립트 3종
  - I009 문서 작성
  - git push 완료 (`d6cdd0e`)
- [x] 전체 파이프라인 통합 테스트 (T004)
  - CRM 리드 3명 → 상품 매칭 → Ollama qwen3:8b 카피 생성 → 카카오톡 발송
  - 카피 생성 2/3 성공 (1건 Ollama 파싱 실패 → 폴백 처리)
  - 카카오 발송 3/3 PASS (91ms, 60ms, 72ms)
  - T004 문서 작성
- [x] n8n 외부 접근 터널 설정 (I010)
  - Cloudflare Tunnel (Quick Tunnel) — 무료, 계정 불필요
  - `localhost:5678` → `https://xxx.trycloudflare.com`
  - 시작/중지 스크립트 (`scripts/tunnel-start.ps1`, `tunnel-stop.ps1`)
  - n8n UI 외부 접근 + 웹훅 수신 검증 완료
- [x] 프로덕션 전환 가이드 작성 (D011)
  - 전체 인프라 전환 체크리스트 (터널/n8n/Ollama/CRM)
  - 채널 전환 플로우 (카카오→Zalo)
  - 알려진 이슈 & 해결 방법 정리
  - 보안·모니터링·비용·스케일링 참고사항
  - 4단계 전환 로드맵

---

## MAIBEAUTY Admin (통합 관리 시스템) — 2026-02-05 NEW

### 개요
- **목적**: 판매 관리자용 프로덕션 레벨 관리 사이트
- **기술**: Next.js 14 + FastAPI + PostgreSQL
- **배포**: GitHub Pages + GitHub Actions (Frontend) + Railway (Backend) — 2026-02-05 확정
- **설계 문서**: D015 (PRD), D016 (시스템 설계), D017 (개발 계획)

### 4대 모듈
1. **CRM 리드 관리** — 리드 CRUD, 상태 관리, 히스토리, Sheets 동기화
2. **콘텐츠 관리** — TikTok 영상 생성/미리보기/발행, M01 파이프라인 연동
3. **마케팅 메시지** — AI 카피 생성, 발송, A/B 테스트, WF-POC 연동
4. **가격 모니터링** — 경쟁사 현황, 알림, 차트, M06 Agent 연동

### 개발 일정 (5주)
| Phase | 기간 | 내용 | 시간 |
|-------|------|------|------|
| Phase 1 | Week 1 | 프로젝트 기반 + 인증 | 20h |
| Phase 2 | Week 2 | CRM + 대시보드 (MVP) | 29h |
| Phase 3 | Week 3 | 콘텐츠 모듈 | 30h |
| Phase 4 | Week 4 | 마케팅 모듈 | 35h |
| Phase 5 | Week 5 | 가격 모니터링 + 완성 | 34h |
| **Total** | **5주** | **전체 Admin** | **148h** |

### n8n 연동
- 기존 워크플로우(WF-POC-01~03) 100% 재활용
- Admin이 "예쁜 버튼", n8n이 실제 자동화 처리
- Webhook으로 양방향 통신

---

## 다음 액션

### 🔴 즉시 가능 (마이봇)
- [x] ~~WF-POC-01 파이프라인 실행 테스트~~ → 2회 PASS (T001)
- [x] ~~베트남어 카피 품질 검증~~ → 10/10 체크리스트 통과 (T001)
- [x] ~~WF-POC-02 설계 + 구현 + 테스트~~ → 4/4 PASS (D008, I006, T002)
- [x] ~~WF-POC-03 Dead Lead Reactivator~~ → PASS (D009, T003)
- [x] ~~A/B 프롬프트 테스트 프레임워크~~ → Friendly 승 (D010, T003)
- [x] ~~품질 채점 v2~~ → 9단계 세분화 완료
- [x] ~~Zalo OA API 리서치~~ → 연동 설계 완료 (A006)

### 🟡 지니 액션 필요
- [x] ~~카카오 디벨로퍼스 앱 설정~~ → 마이봇이 브라우저로 직접 완료 (앱 ID: 1379417, REST API Key 설정됨)
- [x] ~~OAuth 토큰 발급~~ → `setup:kakao` 실행 완료 (토큰 `~/.maibeauty/kakao-tokens.json` 저장)
- [x] ~~카카오 테스트 발송~~ → 3/3 PASS 확인 (지니님 카카오톡에서 메시지 확인 완료)
- [ ] Anthropic API Key → `.env`
- [ ] OpenAI API Key → `.env`
- [ ] Zalo OA 생성 ← ⚠️ +84 베트남 번호 필요. BnF 현지 스탭에게 요청 또는 베트남 eSIM
- [ ] Zalo Developer App 생성 → `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OA_ID`

### 🟢 다음 단계
- [x] ~~전체 파이프라인 검증~~ → T004 PASS (카피 생성 + 카카오 발송 3/3)
- [x] ~~n8n 외부 접근 설정~~ → I010 완료 (Cloudflare Tunnel)
- [ ] M03-PoC MVP 완성 (**Zalo 전환만 남음** — +84 번호 확보 시)
- [x] ~~TikTok Commerce API 연동 설계~~ → A007 리서치 완료 (4계층 파이프라인)
- [x] ~~M01 파이프라인 통합~~ → T007 PASS (스크립트→TTS→아바타 2분 14초)
- [x] ~~M01 512px 체크포인트 재다운로드~~ → 완료 (725MB), 단 OOM으로 긴 영상은 256px 사용
- [x] ~~M01 숫자 후처리~~ → m01-phonetic-postprocess.py 구축 완료 (80+종 매핑)
- [x] ~~M01 512px OOM 대응~~ → GFPGAN enhancer 채택 (256px→512px, 340초/건)
- [x] ~~M01 커스텀 AI 아바타 이미지~~ → SD Turbo로 3종 생성, #02 채택 (I011)
- [x] ~~M01 배경음악/자막 추가~~ → m01-postprod.py (FFmpeg, 9:16 세로, SRT 자막, BGM 믹스, I012)
- [ ] Zalo OA API 연동 설계

### 2026-02-03 (추가)
- [x] M06 Ecommerce Agent 전체 구현 (scraper/comparator/defender/scheduler)
  - Shopee/Lazada 스크래핑 (httpx + HTML 파싱)
  - 가격 비교 (5%/15% 알럿), AI 방어 (Ollama qwen3:8b)
  - 4시간 주기 모니터링, FastAPI 8 엔드포인트
  - 테스트 24/24, 문서 4종 (A009, D012, I013, T008)
- [x] M04 AI Product Photography 전체 구현
  - rembg 배경 제거 + Pillow 폴백
  - 5테마×5무드×8카테고리 프롬프트 (Midjourney/SD 호환)
  - 7 해상도 프리셋 (Shopee/Lazada/TikTok/Instagram)
  - 테스트 20/20, 문서 4종 (A010, D013, I014, T009)
- [x] M02 Viral Content Factory 전체 구현
  - FFmpeg 씬 체인지 감지 + 균등 분할 폴백
  - 바이럴 스코어 4축 (Hook/Value/Emotion/CTA, Ollama)
  - 4 프리셋 (tiktok/reels/shorts/square)
  - 테스트 18/18, 문서 4종 (A011, D014, I015, T010)

### 🔵 완료 (2026-02-03)
- [x] M06 Ecommerce Agent — 24/24 테스트 PASS (`5373c16`)
- [x] M04 AI Product Photography — 20/20 테스트 PASS (`50780e6`)
- [x] M02 Viral Content Factory — 18/18 테스트 PASS (`3e15c9a`)

---

## LLM 모델 전략

**원칙: "비싼 모델은 두뇌, 싼 모델은 근육"**

| 용도 | 추천 모델 | 이유 |
|------|----------|------|
| 전략/분석/코딩 | Claude | 품질 우선 |
| 고객 챗봇 (Zalo) | Qwen3 on-premise | 대량 처리 + 비용 절감 + 베트남어 |
| TikTok 스크립트 대량생산 | LLaMA / Qwen3 | 반복 작업은 로컬 |
| AI Copywriting (고품질) | GPT-4o or Claude | 핵심 마케팅 카피 |
| 가격/재고 모니터링 | 소형 오픈모델 | 단순 판단 |

---

## 결정 사항

| 날짜 | 결정 | 근거 |
|------|------|------|
| 2026-01-30 | 블루프린트 6대 AI 모델 확정 | PT_Vietnam_AI_Sales_AutoPilot.pdf |
| 2026-01-31 | n8n MCP 연동 방향 A 채택 | Claude Code → n8n, 설정 간편 |
| 2026-02-01 | 멀티 LLM 전략 채택 | Claude + ChatGPT + On-Premise 병용 |
| 2026-02-01 | On-Premise 착수: M05+M03-PoC | M05는 인프라 전제, M03은 LLM 가치 검증 |
| 2026-02-01 | n8n 로컬 Docker 채택 | On-Premise 일관성 + Ollama 직접 연동 + 비용 $0 |
| 2026-02-02 | 품질 채점 v2 (9단계) | v1 변별력 부족 → 세분화 |
| 2026-02-02 | Friendly 톤 > Expert 톤 (qwen3:8b) | A/B 테스트 결과 78 vs 20 |
| 2026-02-02 | Dead Lead에 Zalo Promotion 필요 | 48시간 규칙 때문에 CS Message 불가 |
| 2026-02-02 | Zalo OA 생성: +84 번호 필수 | 한국 번호(+82) 계정은 OA 생성 권한 없음 → BnF 현지 스탭 요청 또는 eSIM |
| 2026-02-02 | qwen3:8b `/no_think` 사용 금지 | 4/5 확률로 content 비고 thinking에만 응답 → 폴백 로직 추가 (T004-LL) |
| 2026-02-02 | Cloudflare Quick Tunnel 채택 | 무료, 계정 불필요, 즉시 사용. 프로덕션은 Named Tunnel로 업그레이드 |

---

## 문서 목록

| 코드 | 제목 | 상태 |
|------|------|------|
| A001 | PRD: BnF AI 세일즈 오토메이션 | Draft |
| A002 | 기술 스택 서베이 2026 | Draft |
| A003 | 리스크·문제점 분석 (SWOT) | Draft |
| A004 | 문서 리뷰 분석 | Complete |
| A005 | 약점 보완 계획 (24건) | Complete |
| D001~D005 | 시스템 아키텍처~인프라 설정 | Draft |
| D006 | n8n MCP 연동 설계 | Draft |
| D007 | On-Premise 착수 + WF-POC-01 설계 | Complete |
| I001 | 지니 설정 요청서 | 진행중 |
| I002 | 구현 진행 (2/1 오전) | Complete |
| I003 | 구현 진행 (2/1 오후) | Complete |
| I004 | Ollama GPU 복구 + Chat API 전환 | Complete |
| I005 | Google Sheets API 설정 + CRM 스프레드시트 | Complete |
| T001 | WF-POC-01 파이프라인 2회 PASS | Complete |
| D008 | WF-POC-02 CRM ↔ 카피 생성 연동 설계 | Complete |
| I006 | WF-POC-02 구현 기록 | Complete |
| T002 | WF-POC-02 파이프라인 4건 전체 PASS | Complete |
| D009 | WF-POC-03 Dead Lead Reactivator 설계 | Complete |
| D010 | A/B 프롬프트 테스트 프레임워크 설계 | Complete |
| A006 | Zalo OA API 리서치 | Complete |
| T003 | WF-POC-03 + A/B 테스트 결과 | Complete |
| T004 | 파이프라인 통합 테스트 (CRM→Ollama→카카오) | Complete |
| I007 | 마이봇 단독 기능 구현 기록 | Complete |
| I008 | Zalo OA 등록 차단 이슈 + 대책 | ⚠️ Blocked |
| I009 | 카카오톡 채널 테스트 환경 구축 | ✅ Complete |
| I010 | n8n 외부 접근 터널 설정 (Cloudflare Tunnel) | ✅ Complete |
| D011 | 프로덕션 전환 가이드 (Production Transition Reference) | ✅ Complete |
| A007 | M01 Faceless Salesman 기술 리서치 (TikTok + TTS + Avatar) | ✅ Complete |
| T005 | MMS-TTS-vie 벤치마크 결과 (20/20, CER 23.3%) | ✅ Complete |
| T006 | SadTalker 아바타 PoC — 첫 토킹헤드 생성 | ✅ Complete |
| T007 | M01 파이프라인 통합 테스트 (스크립트→TTS→아바타) | ✅ Complete |
| I011 | M01 커스텀 AI 아바타 이미지 생성 (SD Turbo) | ✅ Complete |
| I012 | M01 후처리 — BGM + 자막 + 세로 변환 (FFmpeg) | ✅ Complete |
| A008 | TikTok Content Posting API 리서치 | ✅ Complete |
| T004-LL | Lessons Learned: qwen3 /no_think 버그 | Complete |

---

## 주요 결정사항

| 날짜 | 결정 | 사유 |
|------|------|------|
| 2026-02-02 | Zalo OA +84 필수 확정 | 공식 정책 확인 |
| 2026-02-02 | 카카오톡을 테스트 발송 채널로 채택 | +82 즉시 가능, Dispatcher 추상화로 Zalo 교체 용이 |
| 2026-02-02 | 카카오 앱: BnF AI Sales (ID 1379417) | REST API Key + Client Secret 활성화, 마이봇이 브라우저로 직접 설정 |
| 2026-02-02 | 전체 파이프라인 E2E 검증 완료 | CRM→Ollama→카카오 3/3 PASS, M03-PoC는 Zalo 전환만 남음 |
| 2026-02-05 | Zalo OA: 베트남 현지 방문 시 +84 번호 개통 후 진행 | 회사 전용 번호로 Zalo 계정+Developer+OA 생성 예정, 직원 계정 의존 없이 진행 |
| 2026-02-02 | M01 파이프라인 통합 성공 | 스크립트→TTS→아바타 ~2분14초, $0 비용, 일일5건 ~11분 |
| 2026-02-02 | 512px 체크포인트 손상 확인 | 256px 폴백 사용, 재다운로드 필요 |
| 2026-02-03 | 512px 재다운로드 성공 (725MB) | GitHub Releases에서 정상 파일 확보 |
| 2026-02-03 | 512px + 긴오디오 = OOM | 64초(~1600프레임) 512px 렌더링 시 시스템 RAM 고갈 → 256px 유지 |
| 2026-02-03 | Phonetic 후처리 모듈 구축 | 숫자/영어/약어 80+종 자동 변환, 파이프라인 통합 |
| 2026-02-03 | GFPGAN enhancer 채택 | 256px+GFPGAN→512px 출력, 340초/건, OOM 문제 우회 |

---

## 참고 자료

- `01.분석/BeautyNFactory_Vietnam_Strategy_Analysis.md` — 시장 전략 매칭 분석
- `01.분석/! 03_PT_Vietnam_AI_Sales_AutoPilot.pdf` — AI 세일즈 오토메이션 블루프린트 (15p)
- `01.분석/! 01_PT-*.pdf` — BnF 쇼퍼테인먼트 전략
- `01.분석/! 02_PT-*_n8n.pdf` — n8n 통합 전략

### 2026-02-05
- [x] MAIBEAUTY Admin 설계 문서 작성 (D015 PRD, D016 시스템설계, D017 개발계획)
- [x] Phase 1 Frontend 완료 (`edba7fc`)
  - Next.js 14 + TypeScript + Tailwind CSS + shadcn/ui
  - 6개 페이지: 대시보드, CRM 리드, 콘텐츠, 마케팅, 가격 모니터링, 설정
  - GitHub Actions 자동 배포 워크플로우
- [x] Phase 1 Backend 착수 (Subagent: `maibeauty-backend-phase1`)
  - FastAPI + SQLAlchemy 2.x + Alembic + JWT 인증
  - 리드 CRUD API 구현 중
- [x] **Frontend-Backend 연결 설정 완료** (`e5b31f6` ~ `c59b7da`)
  - ✅ GitHub Actions 환경변수: `NEXT_PUBLIC_API_URL=https://maibeauty-api-production.up.railway.app/api/v1`
  - ✅ Railway CORS 설정: `https://jini92.github.io` 허용됨
  - ✅ 대시보드 Railway API 연결 (useQuery + dashboardApi)
  - ✅ **로그인 기능 테스트 완료** (`admin@maibeauty.vn`)
  - ✅ **CRM 리드 페이지 API 연결** (`63ff275`, BackendLead 타입 변환)
  - ✅ **리드 추가 CRUD 테스트 성공** (5 → 6명)
  - ✅ I018 문서화 완료

### 2026-02-06
- [x] **Phase 2 Step 1: CRM 모듈 심화** (`a5994a6`)
  - 리드 상태 변경 히스토리 API + UI
  - 리드 필터링 (상태별)
  - 리드 상세 페이지 개선
- [x] **Phase 2 Step 2: 대시보드 실제 데이터 연동** (`fe38c9a`)
  - 통계 API 구현 (리드 수, 상태별 분포)
  - 대시보드 차트 연동
- [x] **Phase 2 Step 3: Google Sheets 양방향 동기화** (`0c0c03c`)
  - sheets_sync 서비스 + 라우터 구현
  - Push (DB → Sheets) / Pull (Sheets → DB) API
  - 설정 페이지에 동기화 UI 추가
  - Frontend API 함수 (sheetsSyncApi) 추가

### Railway 인프라 현황
| 서비스 | URL | 상태 |
|--------|-----|------|
| maibeauty-api | maibeauty-api-production.up.railway.app | 🟢 Online |
| Postgres-qWem | postgres-qwem.railway.internal:5432 | 🟢 Online |

---

*Last updated: 2026-02-05 20:15*
