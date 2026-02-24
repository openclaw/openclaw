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

## 다음 액션 (Phase 5: 고도화)

- [ ] UPbit API 키 설정 (.env) → 포트폴리오/매매 기능 활성화
- [ ] models/ 테스트 (lstm, ensemble — tensorflow 의존)
- [ ] Transformer 모델 추가
- [ ] PyPI 퍼블리시
- [ ] Jupyter 교육 노트북

## Phase 4 (미래)

- [ ] Transformer 모델 추가
- [ ] 앙상블 모델 실전 적용
- [ ] Jupyter 노트북 (분석 데모)
- [ ] PyPI 퍼블리시

---

_Last updated: 2026-02-25_
