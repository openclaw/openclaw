# M.AI.UPbit — AI 디지털 자산 분석

## 기본 정보

- **GitHub:** https://github.com/jini92/M.AI.UPbit
- **로컬:** `C:\TEST\M.AI.UPbit`
- **언어:** Python 3.10+
- **Obsidian:** `01.PROJECT/16.M.AI.UPbit`
- **상태:** 🟢 진행중
- **시작일:** 2024 (추정)
- **공개:** private
- **라이선스:** Apache-2.0

## 프로젝트 개요

UPbit API + OpenAI GPT-4o + LSTM을 활용한 디지털 자산(암호화폐) 분석 엔진.
**OSS 코어 (PyPI) + MAIBOTALKS(UI) + OpenClaw(에이전트)** 아키텍처.

## 아키텍처 v2.1 (2026-02-25 확정)

```
User → MAIBOTALKS(음성/텍스트) → MAIBOT(OpenClaw) → maiupbit(엔진) → UPbit Exchange
```

- **UI:** MAIBOTALKS 앱 (기존 음성대화 앱 재활용)
- **에이전트:** OpenClaw/MAIBOT이 scripts/\*.py 호출
- **엔진:** maiupbit PyPI 패키지 (Apache-2.0 OSS)
- **Streamlit/FastAPI/Next.js 제거** — 기존 인프라 활용으로 80% 코드 감소

### 수익 모델

| 티어    | 가격              | 내용                                 |
| ------- | ----------------- | ------------------------------------ |
| Free    | 무료              | PyPI OSS — indicators, backtest, CLI |
| Premium | ₩19,900/월        | MAIBOTALKS+OpenClaw 실시간 트레이딩  |
| Pro API | ₩49,900/월 (미래) | 기관용 API                           |

## POC → v2.1 변환 요약

### POC (app.py, 800+ LOC Streamlit 모놀리스)

주요 기능: fetch_data, add_indicators, train_lstm, predict_prices, analyze_data_with_gpt4, get_coin_news, execute_buy/sell, fetch_portfolio_data, generate_report, recommend_symbols

### v2.1 모듈 구조 (41파일, 3,854 LOC)

```
maiupbit/
├── __init__.py (v0.1.0)
├── cli.py (analyze, portfolio, trade, recommend)
├── indicators/ (trend, momentum, volatility, signals)
├── models/ (lstm, ensemble)
├── analysis/ (technical, llm, sentiment)
├── exchange/ (base, upbit — JSON trade history)
├── backtest/ (engine — Strategy Protocol)
└── utils/ (data, report — PDF)

scripts/ (analyze, trade, portfolio, monitor, daily_report, train_model)
tests/unit/ (test_indicators — 7 tests passing)
```

## 생태계 연결

- **MAIBOTALKS:** UI 레이어 (음성/텍스트 대화 → 매매 지시)
- **MAIBOT(OpenClaw):** 에이전트 오케스트레이터 (scripts/ 호출)
- **MAITHINK:** AI 추론 기술 공유
- **MAITB:** 분석 결과 → 블로그 콘텐츠

## 진행 기록

- 2024: POC 개발 (app.py Streamlit monolith)
- 2026-02-22: MAI Universe 등록, CLAUDE.md + .mcp.json 생성
- 2026-02-25: PRD v2.0 작성 (FastAPI+Next.js) → v2.1 피봇 (OpenClaw+MAIBOTALKS)
- 2026-02-25: **Phase 2 완료** — maiupbit v0.1.0 패키지 모듈화
  - 서브에이전트 3개 (Sonnet 4.6): core-engine ✅, ml-analysis ✅, scaffolding ⚠️(부분 성공)
  - pytest 7/7 통과, CLI 4 커맨드, 실제 API 연동 확인 (BTC ₩94,490,000)
  - commit `0cd20147`, pushed

## Phase 3 완료 ✅ (2026-02-25)

- [x] HEARTBEAT.md: 시장 모니터링 (05:30 KST) + 일일 분석 리포트 (06:30 KST)
- [x] TOOLS.md: 지니님 요청 패턴 → 스크립트 매핑 가이드
- [x] 매매 안전 규칙: --confirm 없이 실행 금지
- [x] 풀 플로우 테스트: analyze (BTC/ETH/XRP) + monitor (5코인) + trade (안전 차단 확인)
- [x] Obsidian 프로젝트 노트 업데이트
- commit `9055ce785` (MAIBOT), pushed

## Phase 4 완료 ✅ (2026-02-25)

- [x] 크론 등록: 시장 모니터링 (05:30) + 일일 분석 리포트 (06:30)
- [x] 테스트 136개 통과, coverage **79.5%** (목표 70% 초과)
  - test_exchange(22), test_backtest(18), test_analysis(29), test_cli(14), test_sentiment(17), test_utils(15)
- [x] README.md PyPI 수준 리라이트
- [x] CLAUDE.md v0.1.0 반영
- commit `fd54cec9`, pushed

## Phase 5 완료 ✅ (2026-02-25)

- [x] UPbit API 키 설정 (.env) — 포트폴리오 연동 확인 (BTT 보유중)
- [x] PyTorch Transformer 모델 (Multi-Head Self-Attention + Positional Encoding)
- [x] CLI train 서브커맨드 추가 (`maiupbit train KRW-BTC --model transformer`)
- [x] 모델 테스트 12개 추가 (148 passed, 3 skipped)
- [x] **PyPI 퍼블리시** — https://pypi.org/project/maiupbit/0.1.0/
- commit `e6e191bd`, pushed

## Phase 7 완료 ✅ (2026-02-25)

**강환국 퀀트 전략 6종 + 포트폴리오 백테스트 엔진**

- [x] `maiupbit/strategies/` 모듈 신설
  - `base.py` — Strategy Protocol (공통 인터페이스)
  - `momentum.py` — 듀얼 모멘텀 전략 (DualMomentumStrategy)
  - `volatility_breakout.py` — 래리 윌리엄스 변동성 돌파
  - `multi_factor.py` — 멀티팩터 랭킹 (모멘텀+변동성+거래량)
  - `allocation.py` — GTAA 자산배분 (Global Tactical Asset Allocation)
  - `seasonal.py` — 시즌 필터 (할빙 사이클 기반 강세/약세장)
  - `risk.py` — 리스크 관리 (손절/익절/포지션 사이징)
- [x] `scripts/quant.py` — MAIBOT 연동 스크립트 (6 서브커맨드)
- [x] 포트폴리오 백테스트 엔진
- commit `e13e4a90`, pushed

## Phase 8 완료 ✅ (2026-02-25)

**LLMAnalyzer OpenAI/Ollama 듀얼 백엔드 + 모델 선정**

- [x] LLMAnalyzer에 Ollama 로컬 LLM 백엔드 추가 (OpenAI 폴백)
- [x] 모델 자동 선정 로직 (환경 변수 기반)
- commit `5fde156d`, pushed

## Phase 9 완료 ✅ (2026-02-25)

**Mnemo(MAISECONDBRAIN) 지식그래프 연동**

- [x] `maiupbit/analysis/knowledge.py` — KnowledgeProvider 클래스
  - Mnemo integrated_search.py subprocess 래퍼
  - search(), search_for_coin(), search_market_context(), enrich_llm_context()
  - 코인별 키워드 매핑 (BTC→비트코인, ETH→이더리움 등)
  - Graceful degradation (Mnemo 없으면 빈 결과 → 기존 파이프라인 유지)
- [x] LLMAnalyzer.analyze()에 knowledge_context 파라미터 추가
- [x] CLI analyze에 Mnemo 컨텍스트 자동 탐색
- [x] daily_report.py에 knowledge enrichment
- [x] 28 tests (test_knowledge.py), knowledge.py 97% coverage
- [x] 전체: 225 passed, 3 skipped, 83.26% coverage
- commit `f517d662`, pushed

## Phase 10 완료 ✅ (2026-02-25)

**라이브 트레이딩 플라이휠 — 데이터→지식→수익 선순환**

MAI Universe "기여와 수익" 철학 반영:

- OSS 기여 (PyPI, 전략 코드, 교육) → 커뮤니티 신뢰
- 실전 트랙레코드 → Premium 구독 가치 증명

### 신규 모듈

- [x] `maiupbit/trading/journal.py` — 분석 근거 포함 구조화 거래 기록
- [x] `maiupbit/trading/auto_trader.py` — 분석→결정→실행→기록 오케스트레이터
- [x] `maiupbit/trading/outcome.py` — 24h 사후 평가 (승률/정확도)
- [x] `maiupbit/integrations/obsidian.py` — 거래→Obsidian 노트→Mnemo 지식그래프

### 크론 (하루 2회 매매)

- `e5cb7200`: 오전 자동매매 (매일 07:00 KST)
- `3fae6309`: 오후 자동매매 (매일 19:00 KST)
- `4303f35d`: 사후 평가 (매일 07:30 KST)
- `d397594f`: 주간 성과 리포트 (매주 월 08:00 KST)

### 플라이휠 구조

```
① TRADE (하루 2회) → ② RECORD (분석 근거) → ③ LEARN (Obsidian→Mnemo)
→ ④ IMPROVE (지식 기반 LLM) → ⑤ PROVE (트랙레코드) → ⑥ MONETIZE
```

### 실거래 검증 (2026-02-25)

- SELL 11M BTT → ₩5,280 체결 ✅
- BUY ₩5,200 → 10.8M BTT 체결 ✅
- dry-run 전체 파이프라인: 기술지표+Mnemo(5건)+Ollama LLM+Obsidian노트 ✅

commit `24c61b9f`, pushed

### 문서

- `docs/O-001-Operation-Plan.md` — MAI Universe 운용 계획서
- `docs/D-002-LiveTrading-Flywheel.md` — 플라이휠 설계서

## 운용 결정 (2026-02-27)

- [x] BTT 전량 매도 후 BTC 중심 포지션으로 전환 완료
- [x] **지니님 결정:** 현재는 BTC 매매 플랜(DCA/익절/손절) 즉시 설정하지 않고, 백데이터를 충분히 확보한 뒤 분석 기반으로 설정
- [ ] 백데이터 축적 기간 동안은 현 상태 유지 + 정기 리포트 데이터 누적

## 다음 액션

- [ ] 백데이터 누적 후 BTC 매매 플랜(분할매수/익절/손절) 재설계
- [ ] Transformer 모델 실제 학습 (BTC 90일 데이터)
- [ ] Jupyter 교육 노트북
- [ ] README에 PyPI 배지 추가
- [ ] `pip install -e .` 전역 설치
- [ ] Obsidian \_DASHBOARD.md 업데이트
- [ ] min_confidence 튜닝 (현재 0.6 → 실전 데이터 기반 조정)
- [ ] Premium 가격 페이지 (MAIBOTALKS 연동)

---

## 기여-수익화 전략 (2026-03-09 확정)

### 채널 구조 (한글/영어 분리)

- **한글**: Substack KR + 티스토리 → 국내 투자자
- **영어**: Medium + Substack EN → 해외 개발자/퀀트
- **OSS**: GitHub (public 전환 예정) + PyPI

### 자동화 파이프라인

- GitHub Actions: 매주 월요일 07:00 KST → README 배지 자동 업데이트
- MAIBOT HEARTBEAT: 매일 리포트 → Obsidian 저장
- n8n: Obsidian → Substack/Medium 자동 발행 (구축 예정)

### 수익 모델 (Substack 뉴스레터)

| 티어  | 가격       | 내용                            |
| ----- | ---------- | ------------------------------- |
| Free  | 0          | 주간 TOP5 (1주 딜레이)          |
| Basic | ₩4,900/월  | 실시간 TOP5 + BTC/ETH 분석      |
| Pro   | ₩14,900/월 | 전종목 시그널 + MAIBOTALKS 알림 |

### 파일

- `.github/workflows/weekly-report.yml` — 주간 자동 리포트
- `scripts/ci_weekly_report.py` — CI 리포트 생성기
- `scripts/update_readme_badges.py` — README 배지 업데이트
- `blog/drafts/` — 뉴스레터 초안 (한글/영어)

### Substack 채널 설정 완료 (2026-03-09)

**채널**: https://jinilee.substack.com
**방식**: 영어 단일 채널 (한글 채널 별도 개설 안 함)

| 설정 항목         | 값                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publication name  | AI Quant Letter                                                                                                                                                                                 |
| Short description | Weekly UPbit crypto quant signals — 6 strategies (Dual Momentum, Volatility Breakout, Multi-Factor, GTAA) auto-generated by open-source AI engine maiupbit (Apache 2.0)                         |
| Categories        | Crypto + Technology                                                                                                                                                                             |
| Email sender      | Jinhee from AI Quant Letter                                                                                                                                                                     |
| Mailing address   | Tower D, Room 6.12, Sunrise Riverside Apt, Ho Chi Minh City, Vietnam 700000                                                                                                                     |
| RSS email         | jini92.lee@gmail.com                                                                                                                                                                            |
| Introduction      | AI Quant Letter delivers weekly crypto quant signals for UPbit, powered by maiupbit — an open-source engine implementing 6 proven strategies. Real trading data, fully transparent, Apache 2.0. |
| Copyright         | Jini Lee                                                                                                                                                                                        |

### 남은 설정 단계

- [ ] About 페이지 (영어로 작성)
- [ ] Welcome email (영어로 수정)
- [x] **첫 뉴스레터 발행 완료** (2026-03-09 19:17 GMT+7)
  - URL: https://jinilee.substack.com/p/ai-quant-letter-1-weekly-upbit-crypto
  - 제목: AI Quant Letter #1 — Weekly UPbit Crypto Signals
  - 대상: Everyone (무료 공개)
- [ ] Stripe 결제 연동 (지니님 직접)
- [ ] GitHub public 전환
- [ ] n8n 자동 발행 파이프라인

---

## 점검 이력

- 2026-02-25 08:05: Phase 7/8 종합 점검 완료
  - 197 tests, 82.44% coverage ✅
  - 전략 6종 실행 확인 (season JSON 정상)
  - CLI quant 6 서브커맨드 동작 확인
  - MAIBOT 연동: TOOLS.md ✅, HEARTBEAT.md ✅, 크론 2건 신규 등록
  - docs I-001/T-001/PRD-v2 Phase 7/8 반영 완료

---

_Last updated: 2026-02-25_

## MAIBOT 연동 — 스크립트 매핑

### 지니님 요청 패턴 → 실행 매핑

| 지니님 말              | 실행                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| "비트코인 분석해줘"    | `cd C:\TEST\M.AI.UPbit; python scripts/analyze.py KRW-BTC`          |
| "이더리움 지금 어때?"  | `cd C:\TEST\M.AI.UPbit; python scripts/analyze.py KRW-ETH`          |
| "시장 상황 알려줘"     | `cd C:\TEST\M.AI.UPbit; python scripts/monitor.py`                  |
| "내 포트폴리오 보여줘" | `cd C:\TEST\M.AI.UPbit; python scripts/portfolio.py`                |
| "비트코인 5만원 사줘"  | `scripts/trade.py buy KRW-BTC 50000` (미리보기) → 확인 후 --confirm |
| "리포트 만들어줘"      | `cd C:\TEST\M.AI.UPbit; python scripts/daily_report.py`             |
| "추천 종목 알려줘"     | `maiupbit recommend --method performance --top 5 --format json`     |

### 퀀트 전략 (Phase 7, 강환국 전략)

| 지니님 말                 | 실행                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| "지금 시즌 어때?"         | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py season`            |
| "모멘텀 좋은 코인 알려줘" | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py momentum --top 5`  |
| "돌파 전략 BTC"           | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py breakout KRW-BTC`  |
| "팩터 분석해줘"           | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py factor --top 5`    |
| "GTAA 자산배분 알려줘"    | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py allocate`          |
| "퀀트 백테스트 해줘"      | `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"; python scripts/quant.py backtest momentum` |

> ⚠️ `scripts/quant.py` 직접 실행 시 `$env:PYTHONPATH="C:\TEST\M.AI.UPbit"` 필수
> 대안: `python -m maiupbit quant <서브커맨드>` (PYTHONPATH 불필요)

### ⚠️ 매매 안전 규칙

- `trade.py`는 **절대 --confirm 없이 실행 금지**
- 지니님 명시 확인 후에만 --confirm
- API 키: `.env`에 `UPBIT_ACCESS_KEY`, `UPBIT_SECRET_KEY`
