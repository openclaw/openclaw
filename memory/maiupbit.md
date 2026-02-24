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

## 다음 액션 (Phase 10 이후)

- [ ] Transformer 모델 실제 학습 (BTC 90일 데이터)
- [ ] HEARTBEAT에 주간 모델 재학습 크론 추가
- [ ] Jupyter 교육 노트북
- [ ] README에 PyPI 배지 추가
- [ ] `pip install -e .` 전역 설치 (scripts/quant.py PYTHONPATH 이슈 해결)
- [x] ~~HEARTBEAT에 퀀트 전략 주기 실행 크론 추가~~ → **등록 완료** (2026-02-25)
  - `0f9d2724`: 퀀트 시즌 체크 (매일 06:35 KST)
  - `a56da9fb`: 퀀트 모멘텀 리포트 (매주 월 07:00 KST)
- [ ] Obsidian \_DASHBOARD.md Phase 7/8 반영

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
