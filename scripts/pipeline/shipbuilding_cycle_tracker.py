#!/usr/bin/env python3
"""shipbuilding_cycle_tracker.py — 조선업 사이클 분석 파이프라인 v6.2

3단계 슈퍼사이클 + 피크아웃 3축 + 다올 방법론 기반.
v6.2: 축별 산출 근거 컨텍스트 내러티브 강화 — 숫자→"왜(Why)" 해설 추가.
      컨테이너 시황 스냅샷, 수요 그룹별 내러티브, 기업/선종/밸류에이션 코멘트.
v6.1: 텔레그램 PDF-only 전송, NanumGothic 폰트, HJ중공업 종목코드 수정(097230),
      축별 산출 근거 5축 상세 강화, ROE DART fallback.
v6.0: pykrx/FDR/OpenDartReader 데이터계층, 대한조선 추가, 4-pass 선종분류,
      투자판단 요약/시나리오/선행-후행 프레임워크, DM 개선.
5축 스코어링: Demand 15% + Financial/Order/Valuation/Structural 85%.

Usage:
    python3 pipeline/shipbuilding_cycle_tracker.py --collect
    python3 pipeline/shipbuilding_cycle_tracker.py --report --notify
    python3 pipeline/shipbuilding_cycle_tracker.py --manual-update regulation=8 vessel_age=7
    python3 pipeline/shipbuilding_cycle_tracker.py --status
    python3 pipeline/shipbuilding_cycle_tracker.py --setup
    python3 pipeline/shipbuilding_cycle_tracker.py --remind
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# -- path setup --
SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from shared.log import make_logger  # noqa: E402

# ── 선택적 라이브러리 (graceful degradation) ──────────────────────
try:
    from pykrx import stock as krx_stock
    HAS_PYKRX = True
except ImportError:
    HAS_PYKRX = False

try:
    import FinanceDataReader as fdr
    HAS_FDR = True
except ImportError:
    HAS_FDR = False

try:
    import OpenDartReader as _OpenDartReader
    HAS_OPENDART = True
except ImportError:
    HAS_OPENDART = False

# KR 종목 6자리 코드 (pykrx/FDR용, .KS suffix 불필요)
_KR_TICKERS = {"hhi", "mipo", "engine", "hanwha", "samsung", "etf", "hanjin", "daehan"}

KST = timezone(timedelta(hours=9))

# ── 디렉토리 & 상수 ─────────────────────────────────────────────
OUTPUT_DIR = SCRIPTS_DIR.parent / "memory" / "shipbuilding-indicators"
REPORT_DIR = OUTPUT_DIR / "reports"
REPORT_DATA_DIR = OUTPUT_DIR / "report_data"
MANUAL_FILE = OUTPUT_DIR / "manual_indicators.json"
DART_ORDERS_FILE = OUTPUT_DIR / "dart_orders.json"
DART_CORP_CACHE = OUTPUT_DIR / ".dart_corp_codes.json"
VALUATION_FILE = OUTPUT_DIR / "valuation.json"
DART_FINANCIALS_FILE = OUTPUT_DIR / "dart_financials.json"
DART_SUPPLEMENTARY_FILE = OUTPUT_DIR / "dart_supplementary.json"
VALUATION_HISTORY_FILE = OUTPUT_DIR / "valuation_history.json"
LONGTERM_FILE = OUTPUT_DIR / "longterm_proxies.json"
SCORE_HISTORY_FILE = OUTPUT_DIR / "score_history.json"
from shared.vault_paths import REPORTS as VAULT_REPORT_DIR

CHART_DIR = OUTPUT_DIR / "charts"

# PDF 차트 크기 매핑 (mm)
CHART_SIZES: dict[str, dict] = {
    "기업 종합 대시보드": {"w": 160, "center": True},
    "선종 믹스": {"w": 120, "center": True},
    "장기 사이클 프록시": {"w": 140, "center": True},
    "스코어 추이": {"w": 120, "center": True},
    "수요지표 Z-Score": {"w": 110, "center": True},
    "인도 스케줄": {"w": 110, "center": True},
    "피크아웃 추이": {"w": 120, "center": True},
}

PEAKOUT_HISTORY_FILE = OUTPUT_DIR / "peakout_history.json"
VESSEL_MIX_HISTORY_FILE = OUTPUT_DIR / "vessel_mix_history.json"
ORDER_HISTORY_FILE = OUTPUT_DIR / "order_history.json"
PRICE_HISTORY_FILE = OUTPUT_DIR / "price_history.json"

DART_API_KEY_FILE = Path.home() / ".openclaw" / "dart_api_key"
TANKER_DATA_FILE = OUTPUT_DIR / "tanker_data.json"
from shared.telegram import (
    send_dm, send_dm_chunked, send_document, send_group_chunked,
    DM_CHAT_ID, GROUP_CHAT_ID, RON_TOPIC_ID,
)

log = make_logger(log_file=str(SCRIPTS_DIR.parent / "logs" / "shipbuilding_cycle.log"))

# ── Tier 1: yfinance 자동 수집 ───────────────────────────────────
TIER1_INDICATORS = {
    # 수요측 (Market Pulse score)
    "bdi":      {"ticker": "BDRY",      "name": "BDI (건화물운임)",      "category": "demand"},
    "wti":      {"ticker": "CL=F",      "name": "WTI 유가",             "category": "demand"},
    "brent":    {"ticker": "BZ=F",      "name": "Brent 유가",           "category": "demand"},
    "natgas":   {"ticker": "NG=F",      "name": "천연가스",              "category": "demand"},
    "krw":      {"ticker": "KRW=X",     "name": "원/달러 환율",         "category": "fx"},
    "steel":    {"ticker": "SLX",       "name": "철강 ETF (후판프록시)",  "category": "supply"},
    # 운임 프록시 (structural 자동화)
    "container_proxy": {"ticker": "ZIM",  "name": "ZIM (컨테이너운임)",   "category": "freight"},
    "tanker_proxy":    {"ticker": "BWET", "name": "BWET (탱커운임ETF)",   "category": "freight"},
    "tanker_proxy2":   {"ticker": "FRO",  "name": "FRO (탱커운임주)",     "category": "freight"},
    "tanker_proxy3":   {"ticker": "STNG", "name": "STNG (탱커운임주2)",   "category": "freight"},
    "tanker_proxy4":   {"ticker": "TNK",  "name": "TNK (탱커운임주3)",    "category": "freight"},
    # 참고용 (score 미반영 — 주가는 결과물). ksoe 제거 (지주회사 — HHI+Mipo 연결 중복)
    "hhi":      {"ticker": "329180.KS", "name": "HD현대중공업",          "category": "stock"},
    "mipo":     {"ticker": "267250.KS", "name": "HD현대미포",            "category": "stock",
                  "note": "비상장(2023 완전자회사). 267250=지주 HD현대. DART 재무는 010620(사업회사)으로 수집"},
    "engine":   {"ticker": "071970.KS", "name": "HD현대마린엔진",        "category": "stock"},
    "hanwha":   {"ticker": "042660.KS", "name": "한화오션",              "category": "stock"},
    "samsung":  {"ticker": "010140.KS", "name": "삼성중공업",            "category": "stock"},
    "etf":      {"ticker": "466920.KS", "name": "조선Top3+ ETF",        "category": "stock"},
    "hanjin":   {"ticker": "097230.KS", "name": "HJ중공업",              "category": "stock"},
    "daehan":   {"ticker": "439260.KS", "name": "대한조선",              "category": "stock"},
}

# ── 장기 시계열 (월 1회, period="max") ────────────────────────────
LONGTERM_TICKERS: dict[str, dict[str, str]] = {
    "fro":  {"ticker": "FRO",   "name": "Frontline (탱커 24년)", "period": "max"},
    "sblk": {"ticker": "SBLK",  "name": "Star Bulk (벌크 18년)", "period": "max"},
    "bdry": {"ticker": "BDRY",  "name": "BDRY (BDI 5년)",       "period": "max"},
    "hrc":  {"ticker": "HRC=F", "name": "HRC (철강 5년)",       "period": "max"},
    "lng":  {"ticker": "LNG",   "name": "Cheniere (LNG 18년)",  "period": "max"},
    "zim":  {"ticker": "ZIM",   "name": "ZIM (컨테이너 4년)",    "period": "max"},
    "rig":  {"ticker": "RIG",   "name": "Transocean (해양 20년)", "period": "max"},
}

# Market Pulse 가중치 (scored only, total=100)
MARKET_PULSE_WEIGHTS: dict[str, int] = {
    "bdi": 25, "wti": 15, "brent": 15, "natgas": 25, "steel": 10, "krw": 10,
}

# ── DART 수주공시 대상 ───────────────────────────────────────────
SHIPBUILDER_STOCKS = {
    "hhi":     {"stock_code": "329180", "name": "HD현대중공업", "tier": "major"},
    "mipo":    {"stock_code": "010620", "name": "HD현대미포", "tier": "major"},
    "hanwha":  {"stock_code": "042660", "name": "한화오션", "tier": "major"},
    "samsung": {"stock_code": "010140", "name": "삼성중공업", "tier": "major"},
    "hanjin":  {"stock_code": "097230", "name": "HJ중공업", "tier": "major",
                "segment": {"name": "조선", "revenue_ratio": 0.65, "note": "097230=사업회사(舊한진중공업). 건설 겸업. 2024 사업보고서 기준 조선 ~65%, 건설 ~35%"}},
    "daehan":  {"stock_code": "439260", "name": "대한조선", "tier": "major",
                "segment": {"name": "조선", "revenue_ratio": 1.0, "note": "조선 전문. 방산 없음"}},  # 2025.08 KOSPI 상장
    # ksoe(HD한국조선해양, 009540) 제거 — 지주회사로 HHI+Mipo와 연결실적 중복
    # 케이조선 (067250): 2014 상장폐지, 비상장 사기업 → DART 데이터 접근 불가 → 제외
}

SHIP_TYPE_KEYWORDS: dict[str, str] = {
    "LNG": "LNG운반선", "VLCC": "VLCC", "석유화학": "석유화학제품운반선",
    "컨테이너": "컨테이너선", "벌크": "벌크선", "탱커": "탱커",
    "FPSO": "FPSO", "해양": "해양플랜트", "잠수함": "잠수함",
    "호위함": "호위함", "구축함": "구축함", "상륙함": "상륙함",
    "PC선": "PC선", "암모니아": "암모니아운반선", "메탄올": "메탄올운반선",
    # v6.0 확장 (미분류 39% → ~10% 해소)
    "원유운반선": "VLCC", "crude": "VLCC", "crude oil": "VLCC",
    "석유제품": "PC선", "product carrier": "PC선", "product tanker": "PC선",
    "가스운반선": "LNG운반선",
    "Suezmax": "탱커", "수에즈맥스": "탱커", "suezmax": "탱커",
    "Aframax": "탱커", "아프라막스": "탱커", "aframax": "탱커",
    "MR탱커": "탱커", "MR Tanker": "탱커", "셔틀탱커": "탱커", "shuttle tanker": "탱커",
    "LPG": "LPG운반선",
}

# ── 다단계 선종 분류 보조 딕셔너리 ─────────────────────────────────
CLIENT_VESSEL_MAP: dict[str, str] = {
    "Qatar Energy": "LNG운반선", "QatarEnergy": "LNG운반선",
    "Frontline": "탱커", "International Seaways": "탱커",
    "Nordic American": "탱커", "NAT": "탱커",
    "Scorpio": "탱커", "Scorpio Tankers": "탱커",
    "Shell": "LNG운반선", "TotalEnergies": "LNG운반선",
    "Evergreen": "컨테이너선", "CMA CGM": "컨테이너선",
    "Maersk": "컨테이너선", "MSC": "컨테이너선",
    "Maran Gas": "LNG운반선", "Knutsen": "셔틀탱커",
    "Petrobras": "FPSO", "PIL": "컨테이너선",
    "Stena Bulk": "탱커",
}

COMPANY_DEFAULT_VESSEL: dict[str, str] = {
    "daehan": "탱커", "samsung": "LNG운반선",
    "hanwha": "LNG운반선", "hhi": "LNG운반선",
    "mipo": "PC선", "hanjin": "컨테이너선",
}


def _classify_vessel_type(text: str, order: dict) -> str:
    """4-pass 선종 분류: 키워드 → 발주처 → 금액 → 회사 전문분야."""
    # Pass 1: 키워드 매칭 (확장된 SHIP_TYPE_KEYWORDS)
    for keyword, ship_type in SHIP_TYPE_KEYWORDS.items():
        if keyword in text:
            return ship_type

    # Pass 2: 발주처(client) 기반 — 텍스트 또는 order dict의 client 필드
    order_client = (order.get("client") or "").lower()
    for client_pattern, ship_type in CLIENT_VESSEL_MAP.items():
        cp_lower = client_pattern.lower()
        if cp_lower in text.lower() or cp_lower in order_client:
            return ship_type

    # Pass 3: 금액 기반 추정
    usd = order.get("contract_amount_usd", 0)
    if usd > 0:
        if usd >= 200_000_000:  # $200M+ → LNG 또는 VLCC
            company_key = order.get("key", "")
            default = COMPANY_DEFAULT_VESSEL.get(company_key, "")
            if default in ("LNG운반선", "VLCC"):
                return default
            return "LNG운반선"  # 고가는 대부분 LNG
        if 100_000_000 <= usd < 200_000_000:  # $100-200M → 탱커/컨
            return "탱커"
        if usd < 50_000_000:  # <$50M → MR/벌크
            return "벌크선"

    # Pass 4: 회사 주력 선종 fallback
    company_key = order.get("key", "")
    return COMPANY_DEFAULT_VESSEL.get(company_key, "미분류")

# ── v2 Scoring (5축) ──────────────────────────────────────────────
CYCLE_SCORE_WEIGHTS: dict[str, int] = {
    "demand":     15,  # BDI, 유가, 천연가스, 후판, 환율 (기존 Market Pulse)
    "financial":  25,  # 영업이익률 추이, 매출 성장, ROE
    "order":      22,  # DART 공시 건수, 평균선가, 계약자산 QoQ
    "valuation":  13,  # P/E vs 역사적, EV/잔고
    "structural": 25,  # IMO 규제, 중국 캐파, 노후선, 운임 (수동)
}

# ── Tier 3: 수동 입력 (1~10) ─────────────────────────────────────
MANUAL_INDICATORS = {
    "regulation":     {"name": "IMO 규제 강도",   "weight": 25, "desc": "1=규제완화 10=최강규제",   "inverted": False},
    "china_capacity": {"name": "중국 캐파 위협",  "weight": 20, "desc": "1=증설없음 10=대규모증설", "inverted": True},
    "vessel_age":     {"name": "노후선 교체압력", "weight": 15, "desc": "1=선대젊음 10=교체시급",   "inverted": False},
    "container_rate": {"name": "컨테이너 운임",   "weight": 15, "desc": "1=역대저점 10=역대고점",   "inverted": False},
    "tanker_rate":    {"name": "탱커 운임",       "weight": 15, "desc": "1=역대저점 10=역대고점",   "inverted": False},
}

# ── DART 재무제표 ─────────────────────────────────────────────────
DART_REPRT_CODES = {"11013": "Q1", "11012": "Q2", "11014": "Q3", "11011": "Q4"}

DART_ACCOUNT_PATTERNS: dict[str, list[str]] = {
    "revenue":              ["매출액", "수익(매출액)"],
    "operating_profit":     ["영업이익", "영업이익(손실)"],
    "net_income":           ["당기순이익", "당기순이익(손실)", "분기순이익"],
    "contract_assets":      ["계약자산"],
    "contract_liabilities": ["계약부채"],
    "total_assets":         ["자산총계"],
    "total_equity":         ["자본총계"],
    "operating_cf":         ["영업활동현금흐름", "영업활동으로인한현금흐름"],
}

HISTORICAL_PE_RANGES: dict[str, dict[str, Any]] = {
    # 20Y 기준 (2005~2025). 조선업 특성상 적자 전환 빈번→유효 PE 기간만 사용
    # 피크(2007-08): PE 25~60x, 저점(2015-17): 적자 또는 200x+
    "hhi":     {"avg": 18.0, "min": 7.0, "max": 55.0, "peak_range": "25~55 (2007-08)", "trough": "적자 (2015-16)"},
    "mipo":    {"avg": 15.0, "min": 5.0, "max": 40.0, "peak_range": "20~40 (2007-08)", "trough": "적자 (2014-16)",
                "note": "PE는 HD현대(지주) 267250 기준. 미포(010620)는 비상장 — 참고용"},
    "hanwha":  {"avg": 17.0, "min": 6.0, "max": 50.0, "peak_range": "25~50 (2007-08)", "trough": "적자 (2015-19)"},
    "samsung": {"avg": 14.0, "min": 5.0, "max": 45.0, "peak_range": "20~45 (2007-08)", "trough": "적자 (2015-19)"},
    "hanjin":  {"avg": 10.0, "min": 4.0, "max": 30.0, "peak_range": "12~30 (추정, 지주→사업회사 전환)", "trough": "적자 (2016-19)"},  # 097230 사업회사 기준
    "daehan":  {"avg": 12.0, "min": 5.0, "max": 30.0, "peak_range": "N/A (IPO 2025.08)", "trough": "N/A (신규 상장)",
                "note": "IPO 후 6개월. 현재 PE ~11.6x. 중소형 조선 평균 기반"},
}

PEAKOUT_THRESHOLDS: dict[str, dict[str, Any]] = {
    "margin_qoq":          {"warning": -1.0, "desc": "영업이익률 QoQ (%p)"},
    "contract_asset_qoq":  {"warning": -5.0, "desc": "계약자산 QoQ (%)"},
    "order_count_90d":     {"warning": 10, "desc": "90일 수주건수", "below": True},
    "avg_price_qoq":       {"warning": -10.0, "desc": "평균선가 QoQ (%)"},
    "lead_time_years":     {"warning": 4.0, "desc": "인도 리드타임 (년)", "above": True},
    "pe_vs_avg":           {"warning": 100.0, "desc": "P/E vs 20Y평균 (%)", "above": True},
}

# ── 사이클 Phase ─────────────────────────────────────────────────
CYCLE_PHASES = [
    (0,  25, "TROUGH",         "불황 — 수주 감소, 선가 하락"),
    (26, 45, "EARLY_RECOVERY", "초기 회복 — 노후선 교체 시작"),
    (46, 65, "EXPANSION",      "확장 — 수주 증가, 선가 상승"),
    (66, 85, "PEAK",           "피크 — 캐파 풀, 리드타임 최장"),
    (86, 100, "OVERHEATING",   "과열 — 피크아웃 징후 감시 필요"),
]

SUPERCYCLE_LABELS = {
    "PRE":       "Pre-Supercycle (1기: LNG·컨테이너 중심)",
    "REAL":      "Real Supercycle (2기: 탱커·벌커 CO₂규제 교체)",
    "COMMODITY": "Commodity Supercycle (3기: 원자재+선박 동반)",
}

# ── 선종별 드라이버 데이터 ──────────────────────────────────────
VESSEL_DRIVERS: dict[str, dict[str, Any]] = {
    "LNG운반선": {
        "drivers": ["AI→데이터센터→전력수요→LNG", "탄소중립 전환 연료", "카타르 NFE 확장",
                     "북미 LNG 프로젝트 FID 가속 (최광식: 2026년 ~100척 발주 전망)",
                     "엑슨모빌 모잠비크/Golden Pass/PNG 20-30척 발주 예정(Q3 2026 협의, 승도리 #2693)"],
        "pipeline": {
            "qatar_nfe": {"ships": "60+척", "period": "2025-2028", "note": "카타르 NFE 확장분"},
            "exxon_multi": {"ships": "20-30척", "period": "Q3 2026 협의 시작", "note": "모잠비크 Rovuma + Golden Pass + PNG"},
            "us_lng_misc": {"ships": "~40척", "period": "2026-2027 FID", "note": "Calcasieu Pass, Driftwood 등"},
            "total": "~130척 (확정 미발주 파이프라인)",
            "source": "승도리 #2693, 최광식(다올), 업계 추정",
        },
        "indicators": ["natgas"],
        "cycle_stage": "1기 (Pre-Supercycle)",
        "source": "t.me/deferred_gratification/1540, #2693",
    },
    "탱커": {
        "drivers": ["EEXI/CII 규제→노후 탱커 교체", "선령 15년↑ 51%", "톤마일 증가(우회항로)",
                     "구조적 국면 진입 (최광식: 운임 상승은 사이클이 아닌 구조적 변화)",
                     "섀도우 플릿 1,100+척(20%) 제재→실질 선복 감소",
                     "중고선=신조선 가격→발주 경제성 극대화 (승도리 #2777)"],
        "indicators": ["wti", "brent", "tanker_proxy", "tanker_proxy2"],
        "cycle_stage": "2기 전환 신호 (Real Supercycle)",
        "source": "t.me/deferred_gratification/959, #2754, #2777",
    },
    "컨테이너선": {
        "drivers": ["친환경 엔진 교체", "홍해 우회→선복 부족", "얼라이언스 재편"],
        "indicators": ["container_proxy"],
        "cycle_stage": "1기 (Pre-Supercycle)",
        "source": "t.me/deferred_gratification/639",
    },
    "벌크선": {
        "drivers": ["CII 규제→감속운항→실질 공급 감소", "선령 20년↑ 22%", "원자재 수요"],
        "indicators": ["bdi"],
        "cycle_stage": "2기 대기 (규제 본격화 시)",
        "source": "t.me/deferred_gratification/1106",
    },
    "해양플랜트": {
        "drivers": ["유가 $70↑ 손익분기 돌파", "셔틀탱커 수요", "심해 개발 재개"],
        "indicators": ["wti", "brent"],
        "cycle_stage": "유가 연동",
        "source": "t.me/deferred_gratification/1540",
    },
    "방산(해군)": {
        "drivers": ["미-중 해양패권 경쟁", "민주진영 건조=한국+일본만",
                     "K-방산 수출", "MASGA (Make American Shipbuilding Great Again) — 한미 조선 협력",
                     "미국 Bridge Strategy→한국 야드 초기 건조 위탁 가능 (승도리 #2692)",
                     "미국 관세 면제 전략재: 조선업=전략적 필수재·대체 불가 (승도리 #2779)"],
        "indicators": [],
        "cycle_stage": "구조적 (지정학)",
        "source": "t.me/deferred_gratification/1540, #2692, #2779",
    },
}

# ── 수요 그룹별 내러티브 (z-score 방향에 따라 선택) ──────────────
DEMAND_GROUP_NARRATIVES: dict[str, dict[str, str]] = {
    "Freight.pos": (
        "건화물(BDI) 강세: 철광석·곡물 해상운송 수요 확대. "
        "중국 인프라 투자 기대 + 계절적 수요 증가. 벌크선 발주 자극 요인."
    ),
    "Freight.neg": (
        "건화물(BDI) 약세: 중국 부동산 둔화→철광석 수요 감소, 곡물 비수기. "
        "선복 과잉 우려 시 벌크선 발주 이연 가능."
    ),
    "Energy.pos": (
        "에너지 강세: OPEC+ 감산·중동 지정학 리스크→유가 지지. "
        "AI→데이터센터→전력수요→LNG 구조적 확대. 에너지선(탱커·LNG) 발주 촉진."
    ),
    "Energy.neg": (
        "에너지 약세: 글로벌 경기 둔화 우려, OPEC+ 증산 가능성, 재고 확대. "
        "유가 하락 장기화 시 해양플랜트·탱커 발주 지연 가능."
    ),
    "Cost.steel.pos": (
        "후판가 상승: 중국 조강 감산→공급 감소, 인프라 투자 기대, 원재료비↑. "
        "**조선사 원가 압박** — 마진 축소 요인이나 선가 전가 가능 시 중립."
    ),
    "Cost.steel.neg": (
        "후판가 하락: 부동산 침체→철강 수요↓, 조강 과잉, 재고↑. "
        "**마진 개선 요인** — 원재료비 절감이 조선사 수익성에 긍정적."
    ),
    "Cost.krw.pos": (
        "원화 약세: 연준 긴축·금리차 확대→자본 유출. "
        "**수출 경쟁력↑** — 달러 수주 조선사의 원화 환산 매출·이익 증가."
    ),
    "Cost.krw.neg": (
        "원화 강세: 연준 인하 기대·외국인 투자 유입. "
        "**마진 축소 요인** — 달러 수주 → 원화 환산 시 매출 감소."
    ),
}

# ── 경쟁국 분석 데이터 ─────────────────────────────────────────
COMPETITOR_DATA: dict[str, dict[str, Any]] = {
    "china": {
        "name": "중국",
        "major_yards": ["CSSC (중국선박집단)", "COSCO Shipping Heavy", "Yangzijiang"],
        "global_share": "~47% (건조량 기준, 2025)",
        "focus_vessels": "벌크선(글로벌 70%↑), 컨테이너선(60%↑), 소형 탱커",
        "trend": "2025년 수주잔고 사상 최대. 벌크·컨테이너 물량 독점 지속. "
                 "LNG선 진출 시도 중이나 막 기술(NO96) 미보유로 한국 대비 2~3년 격차",
        "strengths": ["벌크·컨테이너 물량 독점", "정부 보조금", "낮은 인건비"],
        "weaknesses": ["LNG/VLCC 고부가 경쟁력 열위", "서방 해군함정 수주 불가"],
        "capacity_threat": 4,
        "key_risk": "캐파 급속 증설 시 선가 하방 압력 — 현재 위협도 낮음(4/10)",
        "korea_impact": (
            "벌크·컨테이너 물량 독점이나 고부가(LNG·VLCC) 진입까지 2-3년 기술격차. "
            "NO96 멤브레인 기술 미보유 → 한국 LNG선 수주 독점 지속. "
            "해군함정은 민주주의 진영 제한으로 진입 불가."
        ),
        "watch_signal": "캐파 급속 증설 시 선가 하방 압력 — 현재 4/10",
        "source": "t.me/deferred_gratification/959",
        "yards_detail": [
            {
                "name": "CSSC (중국선박집단)",
                "focus": "LNG운반선 진출(GTT 라이선스, Mark III만), 대형컨테이너, VLCC",
                "scale": "글로벌 LNG선 수주 38% 점유(2025)",
                "strategy": "NO96 멤브레인 미보유→GTT Mark III로 LNG 진입. 가격 10-15% 할인으로 물량 확보",
            },
            {
                "name": "COSCO Shipping Heavy",
                "focus": "벌크선, 컨테이너선, 소형탱커",
                "scale": "COSCO 그룹향 캡티브 물량 다수. $7B 87척 수주(2025 YTD)",
                "strategy": "모회사 COSCO Shipping 물량 보장으로 안정적 가동",
            },
            {
                "name": "Yangzijiang (양쯔장)",
                "focus": "컨테이너선, 벌크선, LPG선",
                "scale": "민영 1위. 2024 매출 $5.5B, GPM 35%",
                "strategy": "고마진 전략(GPM 35% — 중국 평균 15-20% 대비 이례적). 자체 설계 경쟁력",
            },
        ],
        "capacity_trend": "2027년까지 80% 캐파 증설 계획. 연 건조 ~1,800만 CGT(글로벌 47%)",
        "margin_strategy": (
            "대다수 국영 야드: 정부보조금+저가 수주로 물량 확보, 마진 10-15%. "
            "Yangzijiang(민영)은 예외적 고마진(GPM 35%). "
            "국영 야드의 '저마진+대물량' 전략은 선가 하방 압력으로 작용."
        ),
    },
    "japan": {
        "name": "일본",
        "major_yards": ["Imabari Shipbuilding", "JMU (Japan Marine United)", "Oshima"],
        "global_share": "~17% (건조량 기준, 2025)",
        "focus_vessels": "탱커(MR/Aframax), LNG선, 벌크선",
        "trend": "탱커·벌크 중심 수주 유지. Imabari가 탱커 시장에서 한국과 경합. "
                 "인력 고령화로 연간 건조량 감소 추세 — 슬롯 부족으로 한국에 오버플로우 수혜",
        "strengths": ["LNG선 기술력", "민주진영 해군함 건조 가능", "엔저 수혜"],
        "weaknesses": ["인력 고령화·부족", "납기 지연 빈발", "캐파 확장 제한"],
        "capacity_threat": 2,
        "key_risk": "인력 부족으로 오히려 한국 수혜 확대 — 위협보다 기회",
        "korea_impact": (
            "인력 고령화 → 슬롯 부족 → 한국에 오버플로우 수혜. 위협보다 기회. "
            "엔화 약세로 가격경쟁력은 있으나 생산능력 한계가 더 큰 제약."
        ),
        "watch_signal": "인력 부족 심화 → 한국 수혜 지속 — 위협도 2/10",
        "source": "t.me/deferred_gratification/1540",
        "yards_detail": [
            {
                "name": "Imabari Shipbuilding (이마바리)",
                "focus": "벌크선, 컨테이너선, 탱커(Aframax/MR)",
                "scale": "일본 1위 (JMU 60% 인수). 연 ~200척 건조",
                "strategy": "JMU 인수로 해군 함정 + 상선 겸업. 엔저 활용 가격경쟁력",
            },
            {
                "name": "JMU (Japan Marine United)",
                "focus": "해군함정, LNG선, 컨테이너선",
                "scale": "Imabari 60% + IHI 지분. 정부 수주 다수",
                "strategy": "해상자위대 함정 중심. 정부 $6.4B 조선업 지원 기금 수혜",
            },
        ],
        "capacity_trend": "2030년 점유 20% 목표(현 17%). 인력 고령화가 최대 제약",
        "margin_strategy": "엔저 수혜로 가격경쟁력 있으나 슬롯 부족이 더 큰 제약. 한국 오버플로우 수혜 지속.",
    },
    "singapore": {
        "name": "싱가포르",
        "major_yards": ["Seatrium (Sembcorp Marine + Keppel O&M 합병)"],
        "global_share": "~2% (건조량 기준, 해양플랜트 특화)",
        "focus_vessels": "FPSO, 드릴쉽, 셔틀탱커, 잭업리그",
        "trend": "Seatrium 합병 후 해양플랜트 수주 회복 중. 유가 70$↑ 시 심해 FPSO 발주 가속. "
                 "한화오션과 FPSO/셔틀탱커 시장에서 직접 경합",
        "strengths": ["FPSO/해양플랜트 전문", "동남아 허브 위치", "금융 인프라"],
        "weaknesses": ["상선 건조 능력 제한", "높은 인건비", "합병 후 구조조정"],
        "capacity_threat": 1,
        "key_risk": "해양플랜트 특화 — 상선 시장 영향 미미",
        "korea_impact": "해양플랜트 특화. 상선 시장 영향 미미. Seatrium 합병 후 구조조정 중.",
        "watch_signal": "해양플랜트 수주 회복 시 한국 해양부문과 경합 가능 — 위협도 1/10",
        "source": "t.me/deferred_gratification/1540",
        "yards_detail": [
            {
                "name": "Seatrium (Sembcorp Marine + Keppel O&M)",
                "focus": "FPSO, 드릴쉽, 셔틀탱커, 잭업리그",
                "scale": "오더북 $12.8B (2025). FPSO 글로벌 1-2위",
                "strategy": "해양플랜트 특화. 유가 $70↑ 시 심해 프로젝트 가속",
            },
        ],
        "capacity_trend": "합병 시너지 구현 중. 상선 확장 계획 없음",
        "margin_strategy": "해양플랜트는 커스텀 프로젝트→고마진(20%+). 상선 대비 수주 변동성 높음.",
    },
}

# ── 참고 자료 & 출처 ────────────────────────────────────────────
REPORT_SOURCES: dict[str, dict[str, str]] = {
    "승도리_959": {
        "title": "피크아웃 3축 분석",
        "url": "https://t.me/deferred_gratification/959",
    },
    "승도리_1106": {
        "title": "김봉수 교수 슈퍼사이클 3단계",
        "url": "https://t.me/deferred_gratification/1106",
    },
    "승도리_1540": {
        "title": "탑다운 뷰 — 조선업 구조적 투자",
        "url": "https://t.me/deferred_gratification/1540",
    },
    "승도리_639": {
        "title": "'문제는 공급이야' — 조선 공급 분석",
        "url": "https://t.me/deferred_gratification/639",
    },
    "최광식_telegram": {
        "title": "DAOL 조선/기계/방산 최광식 텔레그램",
        "url": "https://t.me/s/HI_GS",
    },
    # IR 자료 (수동 참고)
    "hhi_ir": {
        "title": "HD현대중공업 IR",
        "url": "https://www.hhi.co.kr/IR/ir05_2",
    },
    "hanwha_ir": {
        "title": "한화오션 IR",
        "url": "https://www.hanwhaocean.com/investors/ea/",
    },
    "samsung_ir": {
        "title": "삼성중공업 IR",
        "url": "https://www.irgo.co.kr/IR-COMP/010140",
    },
    "ystreet_outlook": {
        "title": "Ystreet 2025 연간전망",
        "url": "https://www.ystreet.co.kr/community/181/",
    },
}

# 최광식 애널리스트 방법론 참고사항 (목표가 미사용, 방법론만 활용)
ANALYST_METHODOLOGIES: dict[str, dict[str, Any]] = {
    "최광식": {
        "firm": "다올투자증권",
        "channel": "https://t.me/s/HI_GS",
        "methodologies": [
            "수주잔고 기반 이익 사이클 위치 판별 — 수주잔고 변화율로 사이클 전환점 조기 포착",
            "신조선가 궤적 분석 — 선가 상승률(+11%/+20% YoY)이 2~3년 후 P&L에 반영되는 시차 효과",
            "탱커 시장 구조적 국면 판별 — 운임 상승을 사이클이 아닌 구조적 변화로 분석(CII 규제·톤마일·선령)",
            "이중 촉매 프레임워크 — 상선(LNG 메가오더) + 해군(MASGA/K-방산)의 동시 수혜 분석",
            "선가→실적 시차 반영 모델 — 고가 수주의 P&L 반영 시점(2026~) 기반 이익 예측",
            "슈퍼사이클 2막론 — 2026~2033 LNG+MASGA 겹침 구간을 2차 상승기로 전망",
            "톤마일 수요 분석 — 항로 우회(수에즈→희망봉)로 톤마일 증가 효과 정량화",
            "선령 구조 분석 — 노후선 교체 수요와 환경규제(EEXI/CII)의 스크랩 촉진 효과",
            "MASGA/K-방산 촉매 — 미 해군 조함 프로그램과 한국 방산 수출의 조선 실적 기여",
        ],
        "note": "방법론만 참고. 목표가·투자의견은 미반영. 텔레그램 채널(t.me/s/HI_GS)에서 일일 리서치 참조.",
    },
}

# ── 조선업 소개 텍스트 ────────────────────────────────────────────
INDUSTRY_INTRO: dict[str, Any] = {
    "what": (
        "조선업은 선박을 설계·건조·인도하는 중후장대 산업이다. "
        "수주부터 인도까지 2~4년이 소요되며, 수주→건조→인도의 긴 사이클이 실적과 주가를 결정한다. "
        "글로벌 상선 시장은 한국·중국·일본이 90% 이상을 점유하며, "
        "고부가 선종(LNG운반선, VLCC, 해군함정)은 한국이 기술적 우위를 보유한다."
    ),
    "why_now": (
        "김봉수 교수(KAIST): \"이 슈퍼사이클의 핵심 driving force는 이산화탄소 규제인데, "
        "아직 제대로 시작하지 않았다.\" "
        "운항 중 저탄소 엔진 선박은 전체의 7%에 불과하고, 제작 중 포함해도 약 15%. "
        "탱커/벌커 선령 15년 이상이 51%, 20년 이상이 22%로 교체 압력이 누적되어 있다. "
        "\"전세계 조선 캐파는 필요한 수요에 비해 1/3도 되지 않는다.\""
    ),
    "demand_chain": (
        "AI → 에너지(원전, LNG) → 전력 인프라 → 해상 운송(조선) → 방산(해양)\n"
        "미-중 해양 패권 = 제2차 Naval Race\n"
        "민주주의 진영 건조 = 한국 + 일본만 가능\n"
        "\"미국이 꼭 필요한데, 미국이 못하고, 우리가 잘하며, 중국을 배제해야 한다\""
    ),
    "supercycle_table": [
        {"stage": "1기 Pre-Supercycle", "period": "2021~2026", "driver": "LNG·컨테이너선 교체 수요"},
        {"stage": "2기 Real Supercycle", "period": "2027~", "driver": "탱커·벌커 CO₂규제(EEXI/CII/ETS) 강제 교체"},
        {"stage": "3기 Commodity Supercycle", "period": "2기+원자재", "driver": "원자재 수요 폭발 + 선박 교체"},
    ],
    "historical_ref": "2003-2007 슈퍼사이클: 현대미포 4년간 50배 수익",
    "historical_pattern": {
        "title": "2003-07 슈퍼사이클 vs 현재: 선종 전환 패턴",
        "then": (
            "2003-07: 초기 LNG·컨테이너 선도 → 중기 탱커·벌커 주인공 전환. "
            "중국 WTO 가입(2001)→ 원자재 해상운송 폭증 → 탱커·벌커가 사이클의 정점을 만듦. "
            "현대미포(탱커/벌커 특화) 4년간 주가 50배."
        ),
        "now": (
            "2021-현재: 1기 LNG·컨테이너 선도(친환경 교체) → 2기 탱커·벌커 전환 시작. "
            "탱커 선령 15년↑ 51%, 오더북/함대비 15.7%(역사적 저점). "
            "EEXI/CII 2027 본격 시행 시 강제 교체 → 탱커가 2기 주인공. "
            "대한조선(수에즈맥스 1위)+HD현대미포(MR탱커)가 주요 수혜."
        ),
        "implication": (
            "핵심: LNG→탱커 순서는 두 사이클 모두 동일. "
            "1기에서 2기로 넘어가는 전환점(탱커/벌커 비중 역전)이 진정한 슈퍼사이클의 시작. "
            "현재 1기 후반~2기 초입으로, 탱커 비중 증가 모니터링이 사이클 판단의 핵심."
        ),
    },
    "supply_shortage_signals": {
        "secondhand_parity": (
            "5년차 중고 탱커 가격 = 신조 가격 (승도리 #2777). "
            "중고선 프리미엄은 극심한 공급 부족의 가장 직접적 신호. "
            "발주 안 하면 비합리적인 가격 구간 진입."
        ),
        "orderbook_to_fleet": (
            "탱커 오더북/함대비 15.7% — 역사적 저점 (과거 평균 30~40%). "
            "컨테이너 22.5%는 높으나 환경규제 교체분 고려 시 적정."
        ),
        "yard_capacity_vs_demand": (
            "\"전세계 조선 캐파는 필요한 수요의 1/3도 되지 않는다\" (김봉수 교수). "
            "글로벌 캐파 ~45M CGT 대비 연간 교체 필요량 ~80M CGT. "
            "수주잔고/캐파 비율 2.5~3년분 = 풀 가동 상태."
        ),
        "source": "승도리 #2777, #2787, 김봉수 교수(KAIST)",
    },
    "source": "김봉수 교수(KAIST) + 승도리(@deferred_gratification)",
}

# ── 피크아웃 3대 축 프레임워크 ──────────────────────────────────
PEAKOUT_FRAMEWORK: dict[str, dict[str, str]] = {
    "실적": {
        "title": "실적 피크아웃",
        "description": "수주잔고 기반 향후 3년 실적 확정",
        "key_variable": "후판가 급등 없는 한 피크아웃 가능성 낮음",
        "positive": "외국인 인력 숙련도 + 협동로봇 → 생산성 향상",
        "source": "승도리 #959",
    },
    "수주": {
        "title": "수주 피크아웃",
        "description": "수주잔고 유지 여부가 핵심 (절대 수주량이 아닌 잔고)",
        "key_variable": "EEXI/CII/ETS 규제 존속 확인",
        "risk": "최대 리스크: 중국 캐파 급속 증설",
        "leading_indicator": (
            "부품사 백로그: 한국카본(LNG 화물창 단열재) 등 핵심 부품사 백로그 1년 연장 "
            "= 조선소 수주 호황 연장 신호. 부품사 백로그는 조선소 수주의 6~12개월 선행지표"
        ),
        "source": "승도리 #959, #2772",
    },
    "선가": {
        "title": "선가 피크아웃",
        "description": "공급곡선 수직 구간 → 수요 소폭 변동에도 선가 급변",
        "key_variable": "KRW/USD: 원화 강세 시 선가 추가 상승 필요",
        "positive": "중국 캐파 대폭 증설 없으면 선가 피크아웃 어려움",
        "source": "승도리 #959",
    },
}

# ── 대형사 프로필 (정적) ───────────────────────────────────────────
MAJOR_PROFILES: dict[str, dict[str, Any]] = {
    "hhi": {
        "name": "HD현대중공업",
        "focus_vessels": ["LNG운반선(174K cbm)", "VLCC(318K DWT)", "컨테이너선(13K~24K TEU)", "해양플랜트(FPSO/FSU)"],
        "key_clients": "Qatar Energy, CMA CGM, Petrobras, 대한민국 해군",
        "competitive_edge": "LNG 멤브레인 양대 기술(NO96+Mark III) 모두 보유. 글로벌 LNG선 1위(수주점유 ~30%)",
    },
    "mipo": {
        "name": "HD현대미포",
        "focus_vessels": ["PC선(50K DWT)", "MR탱커(50K DWT)", "컨테이너선(1,800~3,600 TEU)", "LPG선"],
        "key_clients": "Stena Bulk, Scorpio Tankers, 지중해 선주",
        "competitive_edge": "중형선 글로벌 1위(연 ~40척). MR탱커+PC선 특화 — 대형사 중 유일한 틈새 포지션",
    },
    "hanwha": {
        "name": "한화오션",
        "focus_vessels": ["LNG운반선(174K cbm)", "잠수함(KSS-III)", "구축함(KDDX)", "FPSO"],
        "key_clients": "Shell, TotalEnergies, 대한민국 해군(잠수함·구축함)",
        "competitive_edge": "방산 비중 ~30%(잠수함 독점). LNG선 2위. 방산+상선 포트폴리오 — 방산이 하방 지지",
    },
    "samsung": {
        "name": "삼성중공업",
        "focus_vessels": ["LNG운반선(174K cbm)", "셔틀탱커", "FPSO", "컨테이너선"],
        "key_clients": "Qatar Energy, Maran Gas, Knutsen NYK",
        "competitive_edge": "LNG선 기술력(멤브레인+카고탱크 최고 품질 평가). 셔틀탱커 독보적 기술(DP시스템+극지). 카타르 LNG 수혜",
    },
    "hanjin": {
        "name": "HJ중공업",
        "focus_vessels": ["컨테이너선(7,700~10,100 TEU)", "벌크선(82K DWT)", "탱커(MR)"],
        "key_clients": "PIL, Evergreen, 미 해군",
        "competitive_edge": "영도(부산)+수빅(필리핀) 2개 야드. 미 해군 MSRA 5년 MRO 계약(2025.12) — K-방산 수혜. 건설 겸업(HJ중공업 = 舊 한진중공업) — 조선 부문만 분리 분석 필요",
    },
    "daehan": {
        "name": "대한조선",
        "focus_vessels": ["수에즈맥스(158K DWT)", "Aframax", "PC선", "셔틀탱커"],
        "key_clients": "Frontline, International Seaways, Nordic American Tankers (NAT), 대형 그리스 선주",
        "competitive_edge": "수에즈맥스 글로벌 1위(2025.1월 11척 중 6척 수주, 62% 점유). "
                            "탱커 전문 — OPM 24%, 2025.08 KOSPI 상장, 시총 ~3.6조. "
                            "해남(전남) 야드. 방산 없이 순수 상선 조선소.",
    },
}

# ── 중소형사 프로필 (정적) — 향후 추가 시 사용 ─────────────────────
MIDSIZE_PROFILES: dict[str, dict[str, Any]] = {}  # daehan → MAJOR 승격 (v6.0)

# ── 탱커 시황 스냅샷 (외부 파일 우선, fallback 내장) ────────────────
DEFAULT_TANKER_SNAPSHOT: dict[str, Any] = {
    "vlcc_dayrate_usd": "120,000~167,000 (2025.Q1 spot)",
    "suezmax_dayrate_usd": "~65,000 (2025.Q1)",
    "fleet_age": {
        "16_20y_pct": 28,
        "20y_plus_pct": 22,
        "25y_hitting_2026": "580+척",
    },
    "orderbook_to_fleet": "15.7% (tanker, 2025)",
    "newbuild_vlcc_usd_m": "~130M (2025)",
    "newbuild_suezmax_usd_m": "~85M (2025)",
    "shadow_fleet": {
        "sanctioned_vessels": "1,100+척",
        "pct_of_global_tanker": 20,
        "trend": "제재 강화→가용 선복 추가 감소. 카메룬 등 편의치적 퇴출 가속",
        "source": "승도리 #2754, Windward",
    },
    "secondhand_parity": (
        "5년 중고 탱커 가격 ≈ 신조선 가격 — 극심한 공급 부족 신호. "
        "발주 후 5년 운항→동일 가격 매각 가능 = 발주 안 하면 비합리적 (승도리 #2777)"
    ),
    "key_drivers": [
        "EEXI/CII 규제→노후 탱커 강제 퇴출(2025.1 CII 등급 재평가)",
        "선령 15년↑ 51% — 2기 슈퍼사이클 핵심 교체 수요",
        "톤마일 증가(수에즈→희망봉 우회)",
        "미국 LNG/원유 수출 증가→톤마일 추가 확대",
        "섀도우 플릿 제재 강화→실질 가용 선복 축소 (1,100+척, 글로벌 탱커 20%)",
        "중고선=신조선 가격 패리티→신조 발주 경제성 극대화",
    ],
    "structural_view": (
        "탱커는 사이클이 아닌 구조적 국면. "
        "운임 상승은 CII 규제·톤마일·선령의 동시 작용. "
        "VLCC 오더북/함대비 15.7%는 역사적 저점 수준 — 공급 부족 장기화. "
        "섀도우 플릿 1,100+척(20%) 제재 강화로 실질 가용 선복 추가 감소. "
        "5년 중고선=신조선 가격 — 발주 경제성 역대 최고 (승도리 #2777)."
    ),
    "source": "승도리 #959/#2754/#2777, Clarkson Research, 최광식(다올투자증권)",
}


def _load_tanker_snapshot() -> dict[str, Any]:
    """tanker_data.json 로드 (90일 staleness). 미존재/stale → DEFAULT_TANKER_SNAPSHOT."""
    if TANKER_DATA_FILE.exists():
        try:
            data = json.loads(TANKER_DATA_FILE.read_text())
            updated = data.get("updated_at", "")
            if updated:
                days_old = (datetime.now() - datetime.fromisoformat(updated)).days
                if days_old <= 90:
                    return data
                log(f"WARN: tanker_data.json {days_old}일 미갱신 — DEFAULT 사용")
        except (json.JSONDecodeError, ValueError):
            pass
    return dict(DEFAULT_TANKER_SNAPSHOT)


TANKER_MARKET_SNAPSHOT: dict[str, Any] = _load_tanker_snapshot()

# ── 컨테이너 시황 스냅샷 (외부 파일 우선, fallback 내장) ────────────
DEFAULT_CONTAINER_SNAPSHOT: dict[str, Any] = {
    "scfi_index": "~1,050 (2025.Q1)",
    "scfi_yoy_change": "+15% YoY",
    "ccfi_index": "~1,080 (2025.Q1)",
    "fleet_age": {"15y_plus_pct": 18, "20y_plus_pct": 8},
    "orderbook_to_fleet": "22.5% (container, 2025)",
    "newbuild_14k_teu_usd_m": "~175M",
    "newbuild_8k_teu_usd_m": "~110M",
    "key_drivers": [
        "홍해 위기→수에즈 우회→실질 선복 10-15% 감소",
        "얼라이언스 재편(Gemini 2025.02 출범)→선복 재배치",
        "친환경 규제(EEXI/CII)→듀얼퓨얼 신조 주문 가속",
        "글로벌 무역량 회복(+3.5% YoY 전망)",
    ],
    "structural_view": (
        "컨테이너 운임은 홍해 우회로 구조적 상승. "
        "SCFI 1,000↑ 유지 시 선주 발주 의향 증가. "
        "오더북/함대비 22.5%는 높으나 환경규제 교체분 고려 시 적정."
    ),
    "source": "Alphaliner, Drewry, Clarksons Research",
}
CONTAINER_DATA_FILE = OUTPUT_DIR / "container_data.json"


def _load_container_snapshot() -> dict[str, Any]:
    """container_data.json 로드 (90일 staleness). 미존재/stale → DEFAULT_CONTAINER_SNAPSHOT."""
    if CONTAINER_DATA_FILE.exists():
        try:
            data = json.loads(CONTAINER_DATA_FILE.read_text())
            updated = data.get("updated_at", "")
            if updated:
                days_old = (datetime.now() - datetime.fromisoformat(updated)).days
                if days_old <= 90:
                    return data
                log(f"WARN: container_data.json {days_old}일 미갱신 — DEFAULT 사용")
        except (json.JSONDecodeError, ValueError):
            pass
    return dict(DEFAULT_CONTAINER_SNAPSHOT)


CONTAINER_MARKET_SNAPSHOT: dict[str, Any] = _load_container_snapshot()


# ══════════════════════════════════════════════════════════════════
#  DART 수주공시 수집
# ══════════════════════════════════════════════════════════════════

def _get_dart_api_key() -> str | None:
    key = os.environ.get("DART_API_KEY")
    if key:
        return key.strip()
    if DART_API_KEY_FILE.exists():
        return DART_API_KEY_FILE.read_text().strip()
    return None


_dart_reader_cache: Any = None


def _get_dart_reader() -> Any:
    """OpenDartReader 인스턴스 (싱글톤). 미설치/키 없으면 None."""
    global _dart_reader_cache
    if _dart_reader_cache is not None:
        return _dart_reader_cache
    if not HAS_OPENDART:
        return None
    api_key = _get_dart_api_key()
    if not api_key:
        return None
    try:
        _dart_reader_cache = _OpenDartReader(api_key)
        return _dart_reader_cache
    except Exception as e:
        log(f"OpenDartReader init error: {e}")
        return None


def _resolve_corp_codes(api_key: str) -> dict[str, str]:
    """stock_code → corp_code 매핑. OpenDartReader 우선, raw urllib fallback."""
    # 1차: OpenDartReader (내부적으로 corpCode.xml 캐시)
    dart = _get_dart_reader()
    if dart is not None:
        target_stocks = {v["stock_code"] for v in SHIPBUILDER_STOCKS.values() if v["stock_code"]}
        mapping: dict[str, str] = {}
        for stock_code in target_stocks:
            try:
                corp_code = dart.find_corp_code(stock_code)
                if corp_code:
                    mapping[stock_code] = corp_code
            except Exception:
                pass
        if mapping:
            log(f"DART corp codes (ODR): {len(mapping)}/{len(target_stocks)}")
            return mapping

    # 2차: raw urllib fallback (기존 로직)
    import urllib.request
    import xml.etree.ElementTree as ET

    if DART_CORP_CACHE.exists():
        try:
            cache = json.loads(DART_CORP_CACHE.read_text())
            cached_at = datetime.fromisoformat(cache.get("cached_at", "2000-01-01"))
            if (datetime.now() - cached_at).days < 90:
                return cache.get("mapping", {})
        except (json.JSONDecodeError, ValueError):
            pass

    log("Downloading DART corpCode.xml (fallback)...")
    url = f"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={api_key}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=60) as resp:
        zip_data = resp.read()

    target_stocks = {v["stock_code"] for v in SHIPBUILDER_STOCKS.values() if v["stock_code"]}
    mapping = {}

    with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
        xml_names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not xml_names:
            raise ValueError("corpCode.xml not found in ZIP")
        root = ET.fromstring(zf.read(xml_names[0]))

    for item in root.findall("list"):
        stock_code = (item.findtext("stock_code") or "").strip()
        corp_code = (item.findtext("corp_code") or "").strip()
        if stock_code in target_stocks:
            mapping[stock_code] = corp_code

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DART_CORP_CACHE.write_text(json.dumps({"cached_at": datetime.now().isoformat(), "mapping": mapping}))
    log(f"DART corp codes resolved: {len(mapping)}/{len(target_stocks)}")
    return mapping


def collect_dart_orders(days: int = 90, dry_run: bool = False) -> dict[str, Any]:
    """DART 수주공시 수집: OpenDartReader 우선 + raw urllib fallback."""
    api_key = _get_dart_api_key()
    if not api_key:
        log("DART API key not configured. Set DART_API_KEY env or ~/.openclaw/dart_api_key")
        return {"status": "skipped", "reason": "no_api_key"}

    end_de = datetime.now().strftime("%Y%m%d")
    bgn_de = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")
    all_orders: list[dict] = []

    dart = _get_dart_reader()

    for key, meta in SHIPBUILDER_STOCKS.items():
        if not meta.get("stock_code"):
            continue
        try:
            items: list[dict] = []
            if dart is not None:
                # OpenDartReader: stock_code로 직접 공시 목록 조회
                try:
                    df = dart.list(meta["stock_code"], start=bgn_de, end=end_de, kind='B')
                    if df is not None and not df.empty:
                        items = df.to_dict("records")
                except Exception as e:
                    log(f"  ODR list {meta['name']}: {e}")

            # fallback: raw urllib
            if not items:
                items = _dart_list_raw(api_key, meta["stock_code"], bgn_de, end_de)

            for item in items:
                report_nm = item.get("report_nm", "")
                if not any(kw in report_nm for kw in ["판매", "공급계약", "수주", "계약체결"]):
                    continue
                if "기재정정" in report_nm:
                    continue
                order: dict[str, Any] = {
                    "company": meta["name"], "key": key,
                    "rcept_no": item.get("rcept_no"),
                    "report_nm": report_nm,
                    "rcept_dt": item.get("rcept_dt"),
                }
                detail = _parse_order_document(api_key, item.get("rcept_no", ""))
                if detail:
                    order.update(detail)
                time.sleep(0.5)
                all_orders.append(order)

            count = sum(1 for o in all_orders if o.get("key") == key)
            log(f"  {meta['name']}: {count} orders")
        except Exception as e:
            log(f"  ERROR {meta['name']}: {e}")
        time.sleep(1)

    result: dict[str, Any] = {
        "status": "ok", "collected_at": datetime.now().isoformat(),
        "period": f"{bgn_de}~{end_de}", "orders": all_orders,
        "order_count": len(all_orders),
    }
    if all_orders:
        result["estimates"] = _estimate_from_orders(all_orders)

    if not dry_run:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        DART_ORDERS_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        log(f"DART orders saved ({len(all_orders)} orders)")
        _append_price_history(result)
    return result


def _dart_list_raw(api_key: str, stock_code: str, bgn_de: str, end_de: str) -> list[dict]:
    """raw urllib DART 공시 목록 조회 (ODR fallback)."""
    import urllib.request
    import urllib.parse
    try:
        corp_codes = _resolve_corp_codes(api_key)
    except Exception:
        return []
    corp_code = corp_codes.get(stock_code)
    if not corp_code:
        return []
    try:
        params = urllib.parse.urlencode({
            "crtfc_key": api_key, "corp_code": corp_code,
            "bgn_de": bgn_de, "end_de": end_de, "page_count": 100,
        })
        url = f"https://opendart.fss.or.kr/api/list.json?{params}"
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as resp:
            data = json.loads(resp.read())
        if data.get("status") not in ("000",):
            return []
        return data.get("list", [])
    except Exception:
        return []


def _parse_order_document(api_key: str, rcept_no: str) -> dict | None:
    """DART 공시 원문에서 계약 정보 추출. ODR 우선 + raw urllib fallback."""
    if not rcept_no:
        return None

    # 1차: OpenDartReader .sub_docs()
    dart = _get_dart_reader()
    if dart is not None:
        try:
            doc = dart.sub_docs(rcept_no)
            if doc is not None and not (hasattr(doc, 'empty') and doc.empty):
                # sub_docs는 DataFrame → 본문 URL 목록. document()로 직접 가져오기
                text = dart.document(rcept_no)
                if text:
                    return _extract_contract_info(text)
        except Exception:
            pass

    # 2차: raw urllib fallback
    import urllib.request
    url = f"https://opendart.fss.or.kr/api/document.xml?crtfc_key={api_key}&rcept_no={rcept_no}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=20) as resp:
            raw = resp.read()
    except Exception:
        return None

    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            content = ""
            for name in zf.namelist():
                if any(name.endswith(ext) for ext in (".xml", ".htm", ".html")):
                    content += zf.read(name).decode("utf-8", errors="replace")
    except zipfile.BadZipFile:
        content = raw.decode("utf-8", errors="replace")

    return _extract_contract_info(content) if content else None


def _extract_contract_info(content: str) -> dict[str, Any]:
    """HTML/XML 본문에서 계약금액·선종·척수·인도일 추출."""
    result: dict[str, Any] = {}
    # Strip HTML for text-based extraction
    text = re.sub(r"<[^>]+>", " ", content)
    text = re.sub(r"\s+", " ", text)

    # KRW — DART format: "계약금액(원)  481,600,000,000"
    m = re.search(r"계약금액\s*\(원\)\s*([0-9,]+)", text)
    if m:
        result["contract_amount_krw"] = int(m.group(1).replace(",", ""))
    else:
        # Fallback: "계약금액 123억원" / "계약금액 123백만원"
        m = re.search(r"계약금액[^0-9]{0,20}?([0-9,.]+)\s*(백만원|억원|원|천원)", text)
        if m:
            amt = float(m.group(1).replace(",", ""))
            mult = {"원": 1, "천원": 1_000, "백만원": 1_000_000, "억원": 100_000_000}
            result["contract_amount_krw"] = int(amt * mult.get(m.group(2), 1))

    # USD — "USD 310,000,000" or "USD 250 million" (exclude "USD 1 = ..." exchange rate)
    for um in re.finditer(r"(?:USD|US\$)\s*([0-9,]+(?:\.[0-9]+)?)\s*(백만|million|천만|billion)?", text, re.IGNORECASE):
        after = text[um.end():um.end() + 5]
        val = float(um.group(1).replace(",", ""))
        if "=" in after or val < 100:  # skip "USD 1 = ..." exchange rate
            continue
        unit = (um.group(2) or "").lower()
        if unit in ("백만", "million"):
            val *= 1_000_000
        elif unit == "천만":
            val *= 10_000_000
        elif unit == "billion":
            val *= 1_000_000_000
        result["contract_amount_usd"] = val
        break

    # KRW → USD estimate via exchange rate in document
    if "contract_amount_krw" in result and "contract_amount_usd" not in result:
        rate_m = re.search(r"USD\s*1\s*=\s*([0-9,.]+)", text)
        rate = float(rate_m.group(1).replace(",", "")) if rate_m else 1450.0
        result["contract_amount_usd"] = result["contract_amount_krw"] / rate

    # 척수
    m = re.search(r"(\d+)\s*척", text)
    if m:
        result["ship_count"] = int(m.group(1))

    # 인도일 — DART "종료일 2029-06-30"
    m = re.search(r"종료일\s*(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})", text)
    if not m:
        m = re.search(
            r"(?:인도[^0-9]{0,10}|납기[^0-9]{0,10})\s*(\d{4})[.\-/]?\s*(\d{1,2})[.\-/]?\s*(\d{1,2})",
            text,
        )
    if m:
        result["delivery_date"] = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

    # 선종 — 4-pass 분류 (v6.0: 키워드 → 발주처 → 금액 → 회사 전문분야)
    ship_type = _classify_vessel_type(text, result)
    # 키워드로 실제 선종이 잡힌 경우 항상 포함, "미분류"는 다른 정보가 있을 때만
    if ship_type != "미분류" or result:
        result["ship_type"] = ship_type

    return result


def _estimate_from_orders(orders: list[dict]) -> dict[str, Any]:
    """수주 데이터에서 신조선가 + 수주잔고 추정."""
    _valid = set(SHIPBUILDER_STOCKS.keys())
    total_usd = 0.0
    total_krw = 0
    ship_count = 0
    by_type: dict[str, dict] = {}
    by_company: dict[str, int] = {}

    for o in orders:
        if o.get("key") and o["key"] not in _valid:
            continue
        usd = o.get("contract_amount_usd", 0)
        krw = o.get("contract_amount_krw", 0)
        cnt = o.get("ship_count", 1)
        stype = o.get("ship_type", "미분류")

        total_usd += usd
        total_krw += krw
        ship_count += cnt
        by_company[o.get("company", "?")] = by_company.get(o.get("company", "?"), 0) + cnt
        by_type.setdefault(stype, {"count": 0, "amount_usd": 0})
        by_type[stype]["count"] += cnt
        by_type[stype]["amount_usd"] += usd
        # 미분류 항목에 원본 공시명 보존
        if stype == "미분류":
            by_type[stype].setdefault("report_names", [])
            rn = o.get("report_nm", "?")
            by_type[stype]["report_names"].append(rn[:40])

    avg_price = total_usd / ship_count if ship_count > 0 and total_usd > 0 else 0
    return {
        "total_orders": len(orders), "total_ships": ship_count,
        "total_amount_usd": round(total_usd), "total_amount_krw": total_krw,
        "avg_price_per_ship_usd": round(avg_price),
        "by_type": by_type, "by_company": by_company,
    }




# ══════════════════════════════════════════════════════════════════
#  Tier 1 수집 (pykrx + FDR + yfinance fallback)
# ══════════════════════════════════════════════════════════════════

def _compute_zscore_entry(series, meta: dict) -> dict[str, Any] | None:
    """Close 시계열 → z-score 엔트리. 5개 미만이면 None."""
    import pandas as pd
    if isinstance(series, pd.DataFrame):
        series = series.squeeze()
    series = series.dropna()
    if len(series) < 5:
        return None
    close = float(series.iloc[-1])
    prev = float(series.iloc[-2]) if len(series) >= 2 else close
    change_pct = ((close - prev) / prev * 100) if prev else 0.0
    window = min(20, len(series))
    ma = float(series.tail(window).mean())
    std = float(series.tail(window).std())
    zscore = (close - ma) / std if std > 0 else 0.0
    return {
        "ticker": meta["ticker"], "name": meta["name"], "category": meta["category"],
        "close": round(close, 2), "prev": round(prev, 2),
        "change_pct": round(change_pct, 2), "ma20": round(ma, 2),
        "std20": round(std, 4), "zscore": round(zscore, 2),
        "data_points": len(series), "data_date": str(series.index[-1].date()),
    }


def _fetch_kr_ohlcv(ticker_6: str, days: int = 520) -> "pd.DataFrame | None":
    """pykrx로 KR 종목 OHLCV 수집. 실패 시 None."""
    if not HAS_PYKRX:
        return None
    try:
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")
        df = krx_stock.get_market_ohlcv_by_date(start, end, ticker_6)
        if df is not None and not df.empty:
            # 표준 컬럼명으로 변환 (pykrx: 시가/고가/저가/종가)
            df = df.rename(columns={"종가": "Close", "시가": "Open", "고가": "High",
                                     "저가": "Low", "거래량": "Volume"})
            return df
    except Exception as e:
        log(f"  pykrx error {ticker_6}: {e}")
    return None


def _fetch_global_ohlcv(ticker: str, days: int = 520) -> "pd.DataFrame | None":
    """FDR로 글로벌 종목 OHLCV 수집. 실패 시 None."""
    if not HAS_FDR:
        return None
    try:
        start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        end = datetime.now().strftime("%Y-%m-%d")
        df = fdr.DataReader(ticker, start, end)
        if df is not None and not df.empty:
            return df
    except Exception as e:
        log(f"  FDR error {ticker}: {e}")
    return None


def collect_tier1(dry_run: bool = False) -> dict[str, Any]:
    """Tier 1 수집: pykrx(KR) + FDR(글로벌) + yfinance(fallback) + zscore 계산."""
    today = datetime.now().strftime("%Y-%m-%d")
    result: dict[str, Any] = {"date": today, "collected_at": datetime.now().isoformat(), "indicators": {}}

    # 1단계: pykrx (KR) + FDR (글로벌) — 개별 수집
    fetched_keys: set[str] = set()
    for key, meta in TIER1_INDICATORS.items():
        ticker = meta["ticker"]
        df = None
        if key in _KR_TICKERS:
            # KR: pykrx (6자리 코드) → FDR fallback
            ticker_6 = ticker.replace(".KS", "")
            df = _fetch_kr_ohlcv(ticker_6)
            if df is None:
                df = _fetch_global_ohlcv(ticker_6)
        else:
            # 글로벌: FDR
            df = _fetch_global_ohlcv(ticker)
        if df is not None and "Close" in df.columns:
            entry = _compute_zscore_entry(df["Close"], meta)
            if entry:
                result["indicators"][key] = entry
                fetched_keys.add(key)
                log(f"  {key}: {entry['close']:.2f} (z={entry['zscore']:.2f})")

    # 2단계: yfinance fallback (미수집 종목)
    missing = set(TIER1_INDICATORS.keys()) - fetched_keys
    if missing:
        log(f"Fallback yfinance for {len(missing)} tickers: {missing}")
        try:
            import yfinance as yf
            tickers_yf = [TIER1_INDICATORS[k]["ticker"] for k in missing]
            data = yf.download(tickers_yf, period="2y", progress=False, threads=True)
            close_data = data.get("Close", data) if hasattr(data, "get") else data
            for key in missing:
                meta = TIER1_INDICATORS[key]
                try:
                    series = close_data[meta["ticker"]].dropna() if meta["ticker"] in close_data.columns else None
                    if series is not None:
                        entry = _compute_zscore_entry(series, meta)
                        if entry:
                            result["indicators"][key] = entry
                            log(f"  {key} (yf): {entry['close']:.2f} (z={entry['zscore']:.2f})")
                except Exception as e:
                    log(f"  ERROR {key}: {e}")
        except ImportError:
            log("WARN: yfinance not installed, some tickers skipped")

    if not dry_run:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUTPUT_DIR / f"{today}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    log(f"Collected {len(result['indicators'])}/{len(TIER1_INDICATORS)}")
    return result


def collect_longterm_proxies(dry_run: bool = False) -> dict[str, Any]:
    """장기 시계열 수집 (월말 리샘플). 30일 캐시. FDR 우선 + yfinance fallback."""
    if LONGTERM_FILE.exists():
        try:
            cache = json.loads(LONGTERM_FILE.read_text())
            cached_at = datetime.fromisoformat(cache.get("collected_at", "2000-01-01"))
            if (datetime.now() - cached_at).days < 30:
                log("Longterm proxies: using cache")
                return cache
        except (json.JSONDecodeError, ValueError):
            pass

    result: dict[str, Any] = {"collected_at": datetime.now().isoformat(), "proxies": {}}

    for key, meta in LONGTERM_TICKERS.items():
        df = None
        # 1차: FDR (최대 기간 — 시작일을 충분히 과거로)
        if HAS_FDR:
            try:
                df = fdr.DataReader(meta["ticker"], "2000-01-01")
                if df is not None and not df.empty and "Close" in df.columns:
                    log(f"  Longterm {key}: FDR OK ({len(df)} rows)")
            except Exception as e:
                log(f"  FDR longterm {key}: {e}")
                df = None

        # 2차: yfinance fallback
        if df is None or df.empty:
            try:
                import yfinance as yf
                t = yf.Ticker(meta["ticker"])
                df = t.history(period=meta["period"])
                if df is not None and not df.empty:
                    log(f"  Longterm {key}: yfinance OK ({len(df)} rows)")
            except Exception as e:
                log(f"  ERROR longterm {key}: {e}")
                continue

        if df is None or df.empty or "Close" not in df.columns:
            continue

        # 월말 리샘플
        monthly = df["Close"].resample("ME").last().dropna()
        data_points = []
        for dt, val in monthly.items():
            data_points.append({"date": dt.strftime("%Y-%m"), "close": round(float(val), 2)})
        result["proxies"][key] = {
            "ticker": meta["ticker"], "name": meta["name"],
            "months": len(data_points),
            "start": data_points[0]["date"] if data_points else None,
            "end": data_points[-1]["date"] if data_points else None,
            "data": data_points,
        }
        log(f"  Longterm {key}: {len(data_points)} months")
        time.sleep(0.5)

    if not dry_run and result["proxies"]:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        LONGTERM_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        log(f"Longterm proxies saved ({len(result['proxies'])} tickers)")
    return result


def collect_valuation(dry_run: bool = False) -> dict[str, Any]:
    """yfinance .info → 밸류에이션 (시가총액, EV, PE, PB, ROE 등)."""
    try:
        import yfinance as yf
    except ImportError:
        log("ERROR: yfinance not installed")
        return {"error": "yfinance not installed"}

    result: dict[str, Any] = {"collected_at": datetime.now().isoformat(), "stocks": {}}
    for key, meta in SHIPBUILDER_STOCKS.items():
        ticker_str = TIER1_INDICATORS.get(key, {}).get("ticker")
        if not ticker_str:
            continue
        try:
            t = yf.Ticker(ticker_str)
            info = t.info or {}
            result["stocks"][key] = {
                "ticker": ticker_str, "name": meta["name"],
                "market_cap": info.get("marketCap"),
                "enterprise_value": info.get("enterpriseValue"),
                "forward_pe": info.get("forwardPE"),
                "trailing_pe": info.get("trailingPE"),
                "price_to_book": info.get("priceToBook"),
                "ev_ebitda": info.get("enterpriseToEbitda"),
                "profit_margins": info.get("profitMargins"),
                "roe": info.get("returnOnEquity"),
                "operating_margins": info.get("operatingMargins"),
                "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
            }
            log(f"  {key}: mktCap={info.get('marketCap')}, fwdPE={info.get('forwardPE')}")
        except Exception as e:
            log(f"  ERROR {key}: {e}")
        time.sleep(1)

    if not dry_run and result["stocks"]:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        VALUATION_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        log(f"Valuation saved ({len(result['stocks'])} stocks)")
    return result


# ══════════════════════════════════════════════════════════════════
#  DART 재무제표 수집
# ══════════════════════════════════════════════════════════════════

def _parse_dart_amount(val: str | None) -> int | None:
    """DART 금액 문자열 → int (원). 빈값/비숫자 → None."""
    if not val:
        return None
    cleaned = val.strip().replace(",", "")
    if not cleaned or cleaned == "-":
        return None
    try:
        return int(cleaned)
    except ValueError:
        return None


def collect_dart_financials(dry_run: bool = False) -> dict[str, Any]:
    """DART 재무제표: OpenDartReader 우선 + raw urllib fallback. 최근 12분기."""
    api_key = _get_dart_api_key()
    if not api_key:
        return {"status": "skipped", "reason": "no_api_key"}

    now = datetime.now()
    quarters: list[tuple[int, str, str]] = []
    for year in [now.year, now.year - 1, now.year - 2, now.year - 3]:
        for code, label in DART_REPRT_CODES.items():
            quarters.append((year, code, label))
    quarters.sort(key=lambda x: (x[0], x[1]), reverse=True)
    quarters = quarters[:12]

    result: dict[str, Any] = {"collected_at": now.isoformat(), "companies": {}}
    dart = _get_dart_reader()

    for key, meta in SHIPBUILDER_STOCKS.items():
        if not meta.get("stock_code"):
            continue
        company_data: dict[str, Any] = {"name": meta["name"], "quarters": {}}

        for year, reprt_code, q_label in quarters:
            q_key = f"{year}-{q_label}"
            accounts: dict[str, int | None] = {}

            # 1차: OpenDartReader
            if dart is not None:
                try:
                    df = dart.finstate_all(meta["stock_code"], year, reprt_code, fs_div='CFS')
                    if df is not None and not df.empty:
                        for _, row in df.iterrows():
                            acct_nm = (row.get("account_nm") or "").strip()
                            for acct_key, patterns in DART_ACCOUNT_PATTERNS.items():
                                if acct_nm in patterns and acct_key not in accounts:
                                    accounts[acct_key] = _parse_dart_amount(str(row.get("thstrm_amount", "")))
                except Exception:
                    pass

            # 2차: raw urllib fallback
            if not accounts:
                accounts = _dart_finstate_raw(api_key, meta["stock_code"], year, reprt_code)

            if accounts:
                company_data["quarters"][q_key] = {"year": year, "quarter": q_label, **accounts}
            time.sleep(0.3)

        if company_data["quarters"]:
            result["companies"][key] = company_data
            log(f"  {meta['name']}: {len(company_data['quarters'])} quarters")

    if not dry_run and result["companies"]:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        DART_FINANCIALS_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        log(f"DART financials saved ({len(result['companies'])} companies)")
    return result


def _dart_finstate_raw(api_key: str, stock_code: str, year: int, reprt_code: str) -> dict[str, int | None]:
    """raw urllib DART 재무제표 조회 (ODR fallback)."""
    import urllib.request
    import urllib.parse
    try:
        corp_codes = _resolve_corp_codes(api_key)
    except Exception:
        return {}
    corp_code = corp_codes.get(stock_code)
    if not corp_code:
        return {}
    try:
        params = urllib.parse.urlencode({
            "crtfc_key": api_key, "corp_code": corp_code,
            "bsns_year": str(year), "reprt_code": reprt_code, "fs_div": "CFS",
        })
        url = f"https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?{params}"
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as resp:
            data = json.loads(resp.read())
        if data.get("status") != "000":
            return {}
        accounts: dict[str, int | None] = {}
        for item in data.get("list", []):
            acct_nm = (item.get("account_nm") or "").strip()
            for acct_key, patterns in DART_ACCOUNT_PATTERNS.items():
                if acct_nm in patterns and acct_key not in accounts:
                    accounts[acct_key] = _parse_dart_amount(item.get("thstrm_amount"))
        return accounts
    except Exception:
        return {}


def collect_dart_supplementary(dry_run: bool = False) -> dict[str, Any]:
    """DART 직원수 + 배당 (연 1회, 90일 캐시). ODR 우선 + raw urllib fallback."""
    if DART_SUPPLEMENTARY_FILE.exists():
        try:
            cache = json.loads(DART_SUPPLEMENTARY_FILE.read_text())
            cached_at = datetime.fromisoformat(cache.get("collected_at", "2000-01-01"))
            if (datetime.now() - cached_at).days < 90:
                log("DART supplementary: using cache")
                return cache
        except (json.JSONDecodeError, ValueError):
            pass

    api_key = _get_dart_api_key()
    if not api_key:
        return {"status": "skipped", "reason": "no_api_key"}

    dart = _get_dart_reader()
    result: dict[str, Any] = {"collected_at": datetime.now().isoformat(), "status": "ok", "companies": {}}
    year = str(datetime.now().year - 1)

    for key, meta in SHIPBUILDER_STOCKS.items():
        if not meta.get("stock_code"):
            continue
        comp: dict[str, Any] = {"name": meta["name"]}

        # 직원수 — ODR report() 우선
        if dart is not None:
            try:
                df = dart.report(meta["stock_code"], "직원현황", year, "11011")
                if df is not None and not df.empty and "rgllbr_co" in df.columns:
                    total = sum(int(str(v).replace(",", "") or "0") for v in df["rgllbr_co"])
                    comp["employees"] = total
            except Exception:
                pass
        if "employees" not in comp:
            _dart_supplementary_raw_emp(api_key, meta["stock_code"], year, comp)

        # 배당 — ODR report() 우선
        if dart is not None:
            try:
                df = dart.report(meta["stock_code"], "배당", year, "11011")
                if df is not None and not df.empty:
                    for _, row in df.iterrows():
                        if "주당" in str(row.get("se", "")):
                            comp["dividend_per_share"] = str(row.get("thstrm", "0")).replace(",", "")
                            break
            except Exception:
                pass
        if "dividend_per_share" not in comp:
            _dart_supplementary_raw_div(api_key, meta["stock_code"], year, comp)

        if len(comp) > 1:
            result["companies"][key] = comp
        time.sleep(0.5)

    if not dry_run and result["companies"]:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        DART_SUPPLEMENTARY_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        log(f"DART supplementary saved ({len(result['companies'])} companies)")
    return result


def _dart_supplementary_raw_emp(api_key: str, stock_code: str, year: str, comp: dict) -> None:
    """raw urllib DART 직원수 조회 (ODR fallback)."""
    import urllib.request
    import urllib.parse
    try:
        corp_codes = _resolve_corp_codes(api_key)
        corp_code = corp_codes.get(stock_code)
        if not corp_code:
            return
        params = urllib.parse.urlencode({"crtfc_key": api_key, "corp_code": corp_code, "bsns_year": year, "reprt_code": "11011"})
        url = f"https://opendart.fss.or.kr/api/empSttus.json?{params}"
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as resp:
            data = json.loads(resp.read())
        if data.get("status") == "000":
            total = sum(int((it.get("rgllbr_co") or "0").replace(",", "")) for it in data.get("list", []))
            comp["employees"] = total
    except Exception as e:
        log(f"  ERROR emp {stock_code}: {e}")


def _dart_supplementary_raw_div(api_key: str, stock_code: str, year: str, comp: dict) -> None:
    """raw urllib DART 배당 조회 (ODR fallback)."""
    import urllib.request
    import urllib.parse
    try:
        corp_codes = _resolve_corp_codes(api_key)
        corp_code = corp_codes.get(stock_code)
        if not corp_code:
            return
        params = urllib.parse.urlencode({"crtfc_key": api_key, "corp_code": corp_code, "bsns_year": year, "reprt_code": "11011"})
        url = f"https://opendart.fss.or.kr/api/alotMatter.json?{params}"
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as resp:
            data = json.loads(resp.read())
        if data.get("status") == "000":
            for it in data.get("list", []):
                if "주당" in (it.get("se") or ""):
                    comp["dividend_per_share"] = it.get("thstrm", "0").replace(",", "")
                    break
    except Exception as e:
        log(f"  ERROR div {stock_code}: {e}")


# ══════════════════════════════════════════════════════════════════
#  Scoring
# ══════════════════════════════════════════════════════════════════

def _zscore_to_ratio(zscore: float) -> float:
    """z-score → 0.0~1.0. >=1.5→1.0 / >=0.5→0.75 / >=-0.5→0.5 / >=-1.5→0.25 / else→0"""
    if zscore >= 1.5:
        return 1.0
    if zscore >= 0.5:
        return 0.75
    if zscore >= -0.5:
        return 0.5
    if zscore >= -1.5:
        return 0.25
    return 0.0


def _zscore_to_1_10(zscore: float) -> float:
    """z-score → 1~10 선형 매핑. z=-2→1, z=0→5.5, z=+2→10."""
    return round(max(1.0, min(10.0, 5.5 + zscore * 2.25)), 1)


# ── 운임 프록시 자동 매핑 ──────────────────────────────────────────
# 복수 프록시는 z-score 평균으로 합산 (승도리: 탱커운임은 다원적 참조)
FREIGHT_PROXY_MAP: dict[str, list[str]] = {
    "container_rate": ["container_proxy"],                                      # ZIM
    "tanker_rate":    ["tanker_proxy", "tanker_proxy2", "tanker_proxy3", "tanker_proxy4"],  # BWET+FRO+STNG+TNK 평균
}


def auto_structural_scores(indicators: dict[str, Any]) -> dict[str, float]:
    """운임 프록시 z-score → 수동 지표 자동 값 (1~10). 복수 프록시 평균."""
    auto: dict[str, float] = {}
    for manual_key, tier1_keys in FREIGHT_PROXY_MAP.items():
        zscores: list[float] = []
        for t1k in tier1_keys:
            ind = indicators.get(t1k)
            if ind and "zscore" in ind:
                zscores.append(ind["zscore"])
        if zscores:
            avg_z = sum(zscores) / len(zscores)
            auto[manual_key] = _zscore_to_1_10(avg_z)
    return auto


def calculate_market_pulse(indicators: dict[str, Any]) -> dict[str, Any]:
    """Tier 1 → Market Pulse (0~100)."""
    total_w = 0
    weighted = 0.0
    details: dict[str, Any] = {}
    for key, weight in MARKET_PULSE_WEIGHTS.items():
        ind = indicators.get(key)
        if not ind or "zscore" not in ind:
            continue
        ratio = _zscore_to_ratio(ind["zscore"])
        contrib = ratio * weight
        weighted += contrib
        total_w += weight
        details[key] = {"zscore": ind["zscore"], "ratio": ratio, "contribution": round(contrib, 1), "weight": weight}
    score = (weighted / total_w * 100) if total_w > 0 else 0.0
    return {"score": round(score, 1), "indicators_used": len(details),
            "indicators_total": len(MARKET_PULSE_WEIGHTS), "details": details}


def calculate_cycle_score(fin_trends: dict, val_ctx: dict, dart_data: dict | None,
                          manual: dict, indicators: dict | None = None) -> dict[str, Any] | None:
    """4축 Cycle Score (Financial + Order + Valuation + Structural) → 0~100."""
    axis_scores: dict[str, float | None] = {}
    details: dict[str, Any] = {}

    # ── Financial (0~100) ───
    fin_parts: list[float] = []
    for key, ft in fin_trends.items():
        margin = ft.get("op_margin")
        if margin is not None:
            fin_parts.append(min(10, max(0, margin)) * 10)  # 10% margin → 100
        roe = ft.get("roe")
        if roe is not None:
            fin_parts.append(min(10, max(0, roe / 3)) * 10)  # 30% ROE → 100
    axis_scores["financial"] = round(sum(fin_parts) / len(fin_parts), 1) if fin_parts else None
    details["financial"] = {"score": axis_scores["financial"], "parts": len(fin_parts)}

    # ── Order (0~100) ───
    order_parts: list[float] = []
    if dart_data and dart_data.get("estimates"):
        est = dart_data["estimates"]
        n_orders = est.get("total_orders", 0)
        order_parts.append(min(100, n_orders * 5))  # 20건 → 100
        avg_price = est.get("avg_price_per_ship_usd", 0)
        if avg_price > 0:
            order_parts.append(min(100, avg_price / 3_000_000))  # $300M → 100
    # 계약자산 QoQ 평균
    ca_qoqs = [ft["contract_assets_qoq"] for ft in fin_trends.values() if ft.get("contract_assets_qoq") is not None]
    if ca_qoqs:
        avg_ca = sum(ca_qoqs) / len(ca_qoqs)
        order_parts.append(min(100, max(0, 50 + avg_ca * 2.5)))  # +20% → 100, -20% → 0
    axis_scores["order"] = round(sum(order_parts) / len(order_parts), 1) if order_parts else None
    details["order"] = {"score": axis_scores["order"], "parts": len(order_parts)}

    # ── Valuation (0~100, inverted: 고평가=cycle late) ───
    val_parts: list[float] = []
    for key, vc in val_ctx.items():
        pe_vs = vc.get("pe_vs_avg_pct")
        if pe_vs is not None:
            # -50% → 100 (저평가=초기), +100% → 0 (고평가=후기)
            val_parts.append(max(0, min(100, 100 - (pe_vs + 50) * 0.67)))
    axis_scores["valuation"] = round(sum(val_parts) / len(val_parts), 1) if val_parts else None
    details["valuation"] = {"score": axis_scores["valuation"], "parts": len(val_parts)}

    # ── Structural (수동 + 운임 자동, 0~100) ───
    scores = dict(manual.get("scores", {}))
    # 자동 운임 프록시 머지 (수동 오버라이드 우선)
    if indicators:
        auto = auto_structural_scores(indicators)
        for k, v in auto.items():
            if k not in scores:
                scores[k] = v
    total_w = 0
    weighted = 0.0
    auto_keys: list[str] = []
    for key, meta in MANUAL_INDICATORS.items():
        val = scores.get(key)
        if val is None:
            continue
        ratio = (val - 1) / 9.0
        if meta.get("inverted"):
            ratio = 1.0 - ratio
        contrib = ratio * meta["weight"]
        weighted += contrib
        total_w += meta["weight"]
        if key in FREIGHT_PROXY_MAP and key not in (manual.get("scores", {}) or {}):
            auto_keys.append(key)
    if total_w > 0:
        axis_scores["structural"] = round(weighted / total_w * 100, 1)
    else:
        axis_scores["structural"] = None
    details["structural"] = {"score": axis_scores["structural"], "auto": auto_keys}

    # ── 가중 합산 ───
    total_weight = 0
    total_score = 0.0
    for axis, weight in CYCLE_SCORE_WEIGHTS.items():
        if axis == "demand":
            continue  # demand는 market_pulse로 별도
        s = axis_scores.get(axis)
        if s is not None:
            total_score += s * weight
            total_weight += weight
    if total_weight == 0:
        return None
    score = round(total_score / total_weight, 1)
    return {"score": score, "axis_scores": axis_scores, "details": details,
            "axes_used": sum(1 for v in axis_scores.values() if v is not None),
            "axes_total": len(axis_scores)}


def calculate_combined_score(pulse: dict, cycle: dict | None) -> dict[str, Any]:
    """Demand(Market Pulse) 15% + Cycle Score 85% = Combined."""
    ps = pulse["score"]
    if cycle is None:
        return {"combined": None, "market_pulse": ps, "cycle_score": None,
                "method": "market_pulse_only", "note": "Cycle Score 데이터 부족"}
    cs = cycle["score"]
    return {"combined": round(ps * 0.15 + cs * 0.85, 1), "market_pulse": ps, "cycle_score": cs,
            "method": "combined", "note": f"Demand 15%({ps:.0f}) + Cycle 85%({cs:.0f})"}


def determine_cycle_phase(score: float) -> tuple[str, str]:
    for lo, hi, code, desc in CYCLE_PHASES:
        if lo <= score <= hi:
            return code, desc
    return "UNKNOWN", "판정 불가"


# ══════════════════════════════════════════════════════════════════
#  Analysis (v2)
# ══════════════════════════════════════════════════════════════════

def _load_financials() -> dict | None:
    if not DART_FINANCIALS_FILE.exists():
        return None
    try:
        return json.loads(DART_FINANCIALS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _load_valuation() -> dict | None:
    if not VALUATION_FILE.exists():
        return None
    try:
        return json.loads(VALUATION_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _sorted_quarters(quarters: dict) -> list[tuple[str, dict]]:
    """분기 키를 시간순 정렬 (오래된 것 먼저)."""
    return sorted(quarters.items(), key=lambda x: x[0])


def _qoq_change(current: int | None, previous: int | None) -> float | None:
    """QoQ 변동률 (%). None이면 계산 불가."""
    if current is None or previous is None or previous == 0:
        return None
    return (current - previous) / abs(previous) * 100


def analyze_financial_trends(financials: dict | None) -> dict[str, Any]:
    """QoQ/YoY 매출·마진·순이익 추이 분석 (v5: 3년 추세 추가)."""
    if not financials or not financials.get("companies"):
        return {}
    _valid = set(SHIPBUILDER_STOCKS.keys())
    result: dict[str, Any] = {}
    for key, comp in financials["companies"].items():
        if key not in _valid:
            continue
        qs = _sorted_quarters(comp.get("quarters", {}))
        if len(qs) < 2:
            continue
        latest_key, latest = qs[-1]
        prev_key, prev = qs[-2]
        entry: dict[str, Any] = {"name": comp["name"], "latest_quarter": latest_key}
        # 매출 QoQ
        entry["revenue"] = latest.get("revenue")
        entry["revenue_qoq"] = _qoq_change(latest.get("revenue"), prev.get("revenue"))
        # 영업이익
        entry["operating_profit"] = latest.get("operating_profit")
        entry["op_margin"] = None
        if latest.get("revenue") and latest.get("operating_profit"):
            entry["op_margin"] = round(latest["operating_profit"] / latest["revenue"] * 100, 2)
        prev_margin = None
        if prev.get("revenue") and prev.get("operating_profit"):
            prev_margin = round(prev["operating_profit"] / prev["revenue"] * 100, 2)
        entry["op_margin_qoq"] = round(entry["op_margin"] - prev_margin, 2) if entry["op_margin"] is not None and prev_margin is not None else None
        # YoY — 같은 분기 전년도
        yoy_key = None
        for qk, qd in qs:
            if qk != latest_key and qd.get("quarter") == latest.get("quarter") and qd.get("year") == latest.get("year", 0) - 1:
                yoy_key = qk
                break
        if yoy_key:
            yoy_q = comp["quarters"][yoy_key]
            entry["revenue_yoy"] = _qoq_change(latest.get("revenue"), yoy_q.get("revenue"))
        # 계약자산
        entry["contract_assets"] = latest.get("contract_assets")
        entry["contract_assets_qoq"] = _qoq_change(latest.get("contract_assets"), prev.get("contract_assets"))
        entry["contract_liabilities"] = latest.get("contract_liabilities")

        # v5: 계약자산 YoY + 3년 평균 + 추세
        ca_yoy = None
        if yoy_key:
            yoy_q = comp["quarters"][yoy_key]
            ca_yoy = _qoq_change(latest.get("contract_assets"), yoy_q.get("contract_assets"))
        entry["ca_yoy"] = ca_yoy

        # 3년 평균 대비 레벨
        ca_values = [qd.get("contract_assets") for _, qd in qs if qd.get("contract_assets")]
        ca_3y_avg = None
        if len(ca_values) >= 3:
            avg_val = sum(ca_values) / len(ca_values)
            if avg_val > 0:
                ca_3y_avg = round((latest.get("contract_assets", 0) / avg_val - 1) * 100, 1)
        entry["ca_3y_avg"] = ca_3y_avg

        # 선형 추세 (3+ 분기)
        entry["ca_trend"] = _compute_trend(ca_values) if len(ca_values) >= 3 else None

        # 판단 레이블
        entry["ca_judgment"] = _judgment_label(
            entry.get("contract_assets_qoq"), ca_yoy, entry.get("ca_trend"))

        # ROE proxy
        if latest.get("net_income") and latest.get("total_equity") and latest["total_equity"] > 0:
            entry["roe"] = round(latest["net_income"] / latest["total_equity"] * 100, 2)

        # Segment adjustment (건설 겸업 등 — 조선 부문만 분리 근사)
        seg_cfg = SHIPBUILDER_STOCKS.get(key, {}).get("segment")
        if seg_cfg:
            ratio = seg_cfg["revenue_ratio"]
            if entry.get("revenue") is not None:
                entry["revenue"] = round(entry["revenue"] * ratio)
            if entry.get("operating_profit") is not None:
                entry["operating_profit"] = round(entry["operating_profit"] * ratio)
            entry["segment_adjusted"] = True
            entry["segment_name"] = seg_cfg["name"]
            entry["segment_ratio"] = ratio

        result[key] = entry
    return result


def _compute_trend(values: list[float | int | None]) -> str:
    """값 시계열 → '상승'/'하락'/'보합'. 단순 선형 기울기 기반."""
    clean = [v for v in values if v is not None]
    if len(clean) < 3:
        return "보합"
    n = len(clean)
    x_mean = (n - 1) / 2
    y_mean = sum(clean) / n
    num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(clean))
    den = sum((i - x_mean) ** 2 for i in range(n))
    slope = num / den if den > 0 else 0
    # 기울기를 평균값 대비 비율로 정규화
    if y_mean != 0:
        norm_slope = slope / abs(y_mean) * 100  # % per quarter
    else:
        norm_slope = 0
    if norm_slope > 2:
        return "상승"
    elif norm_slope < -2:
        return "하락"
    return "보합"


def _judgment_label(qoq: float | None, yoy: float | None, trend: str | None) -> str:
    """QoQ/YoY/추세 조합 → 컨텍스트 기반 판단 표현.
    '급감' 표현은 QoQ+YoY+추세 3가지가 모두 감소일 때만 사용.
    """
    if qoq is None:
        return ""
    # QoQ 증가면 긍정적
    if qoq >= 0:
        if yoy is not None and yoy > 5:
            return "성장 지속"
        return "양호"

    # QoQ 감소
    if yoy is not None and trend is not None:
        if yoy < -5 and trend == "하락":
            return "추세적 감소"
        if yoy > 0 and trend in ("상승", "보합"):
            return "분기 변동"
        if yoy > 0:
            return "높은 레벨에서 조정"
        if trend == "보합":
            return "횡보 내 변동"
    elif yoy is None:
        return "QoQ 감소 (추세 판단 보류)"

    return "QoQ 감소"


def analyze_valuation_context(valuation: dict | None, financials: dict | None) -> dict[str, Any]:
    """P/E·P/B·EV/EBITDA + 역사적 밴드 대비 위치."""
    if not valuation or not valuation.get("stocks"):
        return {}
    _valid = set(SHIPBUILDER_STOCKS.keys())
    result: dict[str, Any] = {}
    for key, stock in valuation["stocks"].items():
        if key not in _valid:
            continue
        entry: dict[str, Any] = {"name": stock.get("name", key)}
        mcap = stock.get("market_cap")
        entry["market_cap"] = mcap
        entry["ev"] = stock.get("enterprise_value")
        entry["ev_ebitda"] = stock.get("ev_ebitda")
        entry["roe"] = stock.get("roe")
        entry["operating_margins"] = stock.get("operating_margins")
        # P/E 우선순위: ① DART TTM → ② yfinance forward → ③ yfinance trailing (<200x)
        pe = None
        pe_source = None
        # ① DART TTM (한국주식 가장 정확)
        if financials and mcap:
            comp = financials.get("companies", {}).get(key, {})
            qs = _sorted_quarters(comp.get("quarters", {}))
            ni_quarters = [(k, q.get("net_income")) for k, q in qs if q.get("net_income")]
            if ni_quarters:
                total_ni = sum(ni for _, ni in ni_quarters)
                annualized = total_ni * (4 / len(ni_quarters))  # 연환산
                if annualized > 0:
                    pe = round(mcap / annualized, 1)
                    pe_source = f"DART({len(ni_quarters)}Q)"
        # ② yfinance forward PE (컨센서스 기반)
        if pe is None:
            fwd = stock.get("forward_pe")
            if fwd and 0 < fwd < 500:
                pe = round(fwd, 1)
                pe_source = "fwd"
        # ③ yfinance trailing (한국주식 200x↑ 비정상 → 필터)
        if pe is None:
            trail = stock.get("trailing_pe")
            if trail and 0 < trail < 200:
                pe = round(trail, 1)
                pe_source = "trailing"
        entry["pe_ttm"] = pe
        entry["pe_source"] = pe_source
        # P/B: yfinance → DART fallback
        pb = stock.get("price_to_book")
        if pb is None and financials and mcap:
            comp = financials.get("companies", {}).get(key, {})
            qs = _sorted_quarters(comp.get("quarters", {}))
            if qs:
                eq = qs[-1][1].get("total_equity")
                if eq and eq > 0:
                    pb = round(mcap / eq, 2)
        entry["pb"] = pb
        # ROE fallback: yfinance ROE null → DART 재무(net_income / total_equity) 계산
        if entry.get("roe") is None and financials:
            comp = financials.get("companies", {}).get(key, {})
            qs = _sorted_quarters(comp.get("quarters", {}))
            if qs:
                latest_q = qs[-1][1]
                ni = latest_q.get("net_income")
                eq = latest_q.get("total_equity")
                if ni is not None and eq and eq > 0:
                    entry["roe"] = round(ni / eq * 100, 1)
                    entry["roe_source"] = "DART"
        # mipo PE note (지주 HD현대 기준)
        if key == "mipo":
            entry["pe_note"] = "지주(HD현대) PE"
        # 역사적 P/E 비교
        hist = HISTORICAL_PE_RANGES.get(key)
        if pe and hist:
            entry["pe_vs_avg_pct"] = round((pe / hist["avg"] - 1) * 100, 1)
            entry["pe_band_position"] = "상단" if pe > hist["avg"] * 1.3 else "중단" if pe > hist["avg"] * 0.7 else "하단"
            # 내재 성장 연수 (승도리 #1138): 시장이 피크 실적 몇 년 지속을 가격에 반영?
            # PE/역대최고PE 비율 → 연수 추정 (8-12x 피크배수=주가 천장)
            if pe > hist["avg"]:
                # 현재 PE가 평균 대비 초과분 → 시장이 추가 성장 몇 년 기대
                entry["implied_peak_years"] = round((pe - hist["avg"]) / max(1, (hist["max"] - hist["avg"])) * 3, 1)
            else:
                entry["implied_peak_years"] = 0
        result[key] = entry
    return result


def analyze_backlog_timeline(dart_data: dict | None, financials: dict | None) -> dict[str, Any]:
    """인도 타임라인 분석 (수주잔고 연도별 분포, 평균 리드타임)."""
    result: dict[str, Any] = {"delivery_schedule": {}, "lead_time_avg_years": None}
    if not dart_data or dart_data.get("status") != "ok":
        return result
    orders = dart_data.get("orders", [])
    delivery_years: dict[int, int] = {}
    lead_times: list[float] = []
    now = datetime.now()
    for o in orders:
        dd = o.get("delivery_date")
        cnt = o.get("ship_count", 1)
        if dd:
            try:
                dt = datetime.strptime(dd, "%Y-%m-%d")
                delivery_years[dt.year] = delivery_years.get(dt.year, 0) + cnt
                lead_times.append((dt - now).days / 365.25)
            except ValueError:
                pass
    result["delivery_schedule"] = dict(sorted(delivery_years.items()))
    if lead_times:
        result["lead_time_avg_years"] = round(sum(lead_times) / len(lead_times), 1)
    # 계약자산 커버리지 (잔고 / 분기매출)
    if financials:
        coverages: list[float] = []
        for key, comp in financials.get("companies", {}).items():
            qs = _sorted_quarters(comp.get("quarters", {}))
            if qs:
                latest = qs[-1][1]
                ca = latest.get("contract_assets")
                rev = latest.get("revenue")
                if ca and rev and rev > 0:
                    coverages.append(ca / rev)
        if coverages:
            result["avg_backlog_coverage_quarters"] = round(sum(coverages) / len(coverages), 1)
    return result


def analyze_vessel_type_mix(dart_data: dict | None) -> dict[str, Any]:
    """선종 믹스 분석 — 승도리 사이클 전환 감지 (#13: LNG 먼저, 탱커 나중).

    LNG/컨테이너 비중↓ + 탱커/벌커 비중↑ = PRE→REAL 슈퍼사이클 전환 시그널.
    """
    result: dict[str, Any] = {"phase_signal": None, "by_category": {}, "total_ships": 0}
    if not dart_data or dart_data.get("status") != "ok":
        return result
    orders = dart_data.get("orders", [])
    if not orders:
        return result

    # 선종을 카테고리로 분류
    PHASE1_TYPES = {"LNG운반선", "컨테이너선", "암모니아운반선", "메탄올운반선"}
    PHASE2_TYPES = {"VLCC", "탱커", "벌크선", "PC선"}
    DEFENSE_TYPES = {"잠수함", "호위함", "구축함", "상륙함"}

    phase1_count = 0
    phase2_count = 0
    defense_count = 0
    other_count = 0
    total = 0

    for o in orders:
        cnt = o.get("ship_count", 1)
        stype = o.get("ship_type", "미분류")
        total += cnt
        if stype in PHASE1_TYPES:
            phase1_count += cnt
        elif stype in PHASE2_TYPES:
            phase2_count += cnt
        elif stype in DEFENSE_TYPES:
            defense_count += cnt
        else:
            other_count += cnt

    result["total_ships"] = total
    result["by_category"] = {
        "phase1_lng_container": phase1_count,
        "phase2_tanker_bulk": phase2_count,
        "defense": defense_count,
        "other": other_count,
    }

    if total > 0:
        p1_ratio = phase1_count / total
        p2_ratio = phase2_count / total
        result["phase1_ratio"] = round(p1_ratio, 2)
        result["phase2_ratio"] = round(p2_ratio, 2)
        # 전환 시그널: 탱커/벌커 비중이 LNG/컨테이너를 추월하면 REAL 전환
        if p2_ratio > p1_ratio and p2_ratio >= 0.3:
            result["phase_signal"] = "REAL_TRANSITION"
        elif p2_ratio >= 0.2:
            result["phase_signal"] = "TRANSITION_EMERGING"
    return result


def detect_cycle_signals(financials: dict | None, valuation: dict | None,
                         dart_data: dict | None) -> list[dict]:
    """사이클 구조 시그널 감지 (v2 — 구 detect_anomalies 대체)."""
    signals: list[dict] = []
    fin_trends = analyze_financial_trends(financials)
    val_ctx = analyze_valuation_context(valuation, financials)

    # 마진 확대/축소
    for key, ft in fin_trends.items():
        m_qoq = ft.get("op_margin_qoq")
        if m_qoq is not None:
            if m_qoq >= 1.0:
                signals.append({"key": key, "type": "margin_expansion", "severity": "positive",
                                "detail": f"{ft['name']} 영업이익률 QoQ +{m_qoq:.1f}%p"})
            elif m_qoq <= -1.0:
                signals.append({"key": key, "type": "margin_contraction", "severity": "warning",
                                "detail": f"{ft['name']} 영업이익률 QoQ {m_qoq:.1f}%p"})
        # 잔고 가감속
        ca_qoq = ft.get("contract_assets_qoq")
        if ca_qoq is not None:
            if ca_qoq <= -5.0:
                signals.append({"key": key, "type": "backlog_deceleration", "severity": "warning",
                                "detail": f"{ft['name']} 계약자산 QoQ {ca_qoq:.1f}%"})
    # 밸류 스트레치
    for key, vc in val_ctx.items():
        pe_vs = vc.get("pe_vs_avg_pct")
        if pe_vs is not None and pe_vs > 80:
            signals.append({"key": key, "type": "valuation_stretch", "severity": "warning",
                            "detail": f"{vc['name']} P/E {vc['pe_ttm']:.0f}x (20Y avg 대비 +{pe_vs:.0f}%)"})
    # 수주 둔화
    if dart_data and dart_data.get("status") == "ok":
        est = dart_data.get("estimates", {})
        if est.get("total_orders", 0) < 5:
            signals.append({"key": "orders", "type": "order_slowdown", "severity": "warning",
                            "detail": f"90일 수주 {est.get('total_orders', 0)}건 (둔화)"})
    # 선종 믹스 전환 (승도리 #13: LNG→탱커 = PRE→REAL)
    mix = analyze_vessel_type_mix(dart_data)
    if mix.get("phase_signal") == "REAL_TRANSITION":
        signals.append({"key": "vessel_mix", "type": "cycle_phase_transition", "severity": "positive",
                        "detail": f"탱커·벌커 비중({mix['phase2_ratio']:.0%}) > LNG·컨테이너({mix['phase1_ratio']:.0%}) — Real Supercycle 전환 시그널"})
    elif mix.get("phase_signal") == "TRANSITION_EMERGING":
        signals.append({"key": "vessel_mix", "type": "cycle_transition_emerging", "severity": "info",
                        "detail": f"탱커·벌커 비중 {mix['phase2_ratio']:.0%} — 전환 조기 징후"})
    return signals


def compute_peakout_indicators(fin_trends: dict, val_ctx: dict, dart_data: dict | None,
                               backlog: dict) -> list[dict]:
    """피크아웃 6개 지표 실제 데이터 판정."""
    indicators: list[dict] = []

    # 1. 영업이익률 QoQ (전사 평균)
    margins = [ft["op_margin_qoq"] for ft in fin_trends.values() if ft.get("op_margin_qoq") is not None]
    avg_margin_qoq = sum(margins) / len(margins) if margins else None
    indicators.append(_peakout_item("margin_qoq", avg_margin_qoq, "실적"))

    # 2. 계약자산 QoQ (전사 평균)
    ca_qoqs = [ft["contract_assets_qoq"] for ft in fin_trends.values() if ft.get("contract_assets_qoq") is not None]
    avg_ca_qoq = sum(ca_qoqs) / len(ca_qoqs) if ca_qoqs else None
    indicators.append(_peakout_item("contract_asset_qoq", avg_ca_qoq, "실적"))

    # 3. 90일 수주건수
    order_count = None
    if dart_data and dart_data.get("estimates"):
        order_count = dart_data["estimates"].get("total_orders")
    indicators.append(_peakout_item("order_count_90d", order_count, "수주"))

    # 4. 평균선가 QoQ (TODO: 이전 분기 대비 — 현재는 절대값만)
    indicators.append(_peakout_item("avg_price_qoq", None, "수주"))

    # 5. 인도 리드타임
    lead_time = backlog.get("lead_time_avg_years")
    indicators.append(_peakout_item("lead_time_years", lead_time, "선가"))

    # 6. P/E vs 20Y 평균
    pe_pcts = [vc["pe_vs_avg_pct"] for vc in val_ctx.values() if vc.get("pe_vs_avg_pct") is not None]
    avg_pe_pct = sum(pe_pcts) / len(pe_pcts) if pe_pcts else None
    indicators.append(_peakout_item("pe_vs_avg", avg_pe_pct, "밸류"))

    return indicators


def _peakout_item(key: str, value: float | None, axis: str) -> dict:
    """피크아웃 단일 지표 판정."""
    thresh_info = PEAKOUT_THRESHOLDS.get(key, {})
    threshold = thresh_info.get("warning")
    desc = thresh_info.get("desc", key)
    if value is None:
        return {"key": key, "axis": axis, "desc": desc, "value": None, "threshold": threshold, "status": "no_data"}
    # 방향에 따라 판정
    if thresh_info.get("above"):
        triggered = value >= threshold if threshold is not None else False
    elif thresh_info.get("below"):
        triggered = value < threshold if threshold is not None else False
    else:
        triggered = value <= threshold if threshold is not None else False
    return {"key": key, "axis": axis, "desc": desc, "value": round(value, 1),
            "threshold": threshold, "status": "warning" if triggered else "normal"}


# ══════════════════════════════════════════════════════════════════
#  Analysis — 투자 판단 / 선행·후행 프레임워크 / 시나리오
# ══════════════════════════════════════════════════════════════════

INDICATOR_TEMPORAL_TAGS: dict[str, str] = {
    "demand": "lead",        # 수주·운임 → 선행
    "order": "lead",         # 수주 건수·선가 → 선행
    "structural": "lead",    # IMO규제·노후선 → 선행 (구조적)
    "financial": "coincident",  # 실적 → 동행
    "valuation": "lag",      # P/E·P/B → 후행
}

_TEMPORAL_LABELS: dict[str, str] = {
    "lead": "선행지표",
    "coincident": "동행지표",
    "lag": "후행지표",
}

SCENARIO_TEMPLATES: dict[str, dict[str, Any]] = {
    "bull": {
        "label": "Bull (낙관)",
        "drivers": [
            "탱커·벌커 교체 수요 2기 조기 본격화",
            "한미 $350B 투자 협약 → 미국향 LNG/방산 수주 확대 (한화2026전망)",
            "중국 조선소 캐파 제약 심화 + 고부가(NO96 멤브레인) 미진입 → 한국 수혜",
        ],
        "score_delta": +10,
        "probability": "25%",
    },
    "base": {
        "label": "Base (기본)",
        "drivers": [
            "LNG·컨테이너 수주 지속, 선가 점진 상승 (2026 영업이익 ~25% YoY — 한화전망)",
            "탱커 교체 수요 점진 유입, 2기 전환 2027~28년",
            "마진 개선 지속, OPM 10%+ 안착",
        ],
        "score_delta": 0,
        "probability": "50%",
    },
    "bear": {
        "label": "Bear (비관)",
        "drivers": [
            "글로벌 경기침체 → 물동량 감소 → 발주 연기",
            "UBS Capital Goods 글로벌 z-score 최하 (-0.77) — 섹터 수급 역풍",
            "원자재·인건비 급등 + 중국 저가 수주 확대 → 마진·선가 압박",
        ],
        "score_delta": -15,
        "probability": "25%",
    },
}


def _build_investment_judgment_section(
    combined: dict, fin_trends: dict, val_ctx: dict,
    peakout: list, phase_code: str, phase_score: float,
    pulse: dict, cycle: dict | None = None,
) -> list[str]:
    """투자 판단 요약: 3문장 시황 + 기업별 1줄 판정 + 금주 관전포인트."""
    L: list[str] = []
    L.append("## 투자 판단 요약\n")

    # 1) 3문장 시황
    # 사이클 위치
    if phase_score >= 66:
        cycle_sentence = f"사이클 위치: {phase_code}({phase_score:.0f}/100), 피크 구간에서 추가 상승 여력 제한적."
    elif phase_score >= 46:
        cycle_sentence = f"사이클 위치: {phase_code}({phase_score:.0f}/100), 확장 구간으로 수주·실적 동반 개선 중."
    elif phase_score >= 26:
        cycle_sentence = f"사이클 위치: {phase_code}({phase_score:.0f}/100), 초기 회복 단계로 선행지표 개선 징후."
    else:
        cycle_sentence = f"사이클 위치: {phase_code}({phase_score:.0f}/100), 불황 구간."
    L.append(cycle_sentence)

    # 핵심 동인
    drivers: list[str] = []
    demand_score = combined.get("market_pulse")
    if demand_score is not None and demand_score > 55:
        drivers.append("수요 환경 우호적(운임·유가 z-score 양호)")
    elif demand_score is not None and demand_score < 40:
        drivers.append("수요 환경 약세(운임·유가 하방 압력)")
    opm_vals = [ft.get("op_margin") for ft in fin_trends.values() if ft.get("op_margin") is not None]
    if opm_vals:
        avg_opm = sum(opm_vals) / len(opm_vals)
        if avg_opm > 7:
            drivers.append(f"실적 레버리지 작동(평균 OPM {avg_opm:.1f}%)")
        elif avg_opm < 3:
            drivers.append(f"실적 부진(평균 OPM {avg_opm:.1f}%)")
    if drivers:
        L.append(f"핵심 동인: {', '.join(drivers)}.")

    # 주요 리스크
    risks: list[str] = []
    peakout_warns = [p["desc"] for p in peakout if p.get("status") == "warning"]
    if peakout_warns:
        risks.append(f"피크아웃 경고({len(peakout_warns)}건: {', '.join(peakout_warns[:2])})")
    pe_vals = [vc.get("pe_ttm") for vc in val_ctx.values() if vc.get("pe_ttm") is not None]
    if pe_vals:
        avg_pe = sum(pe_vals) / len(pe_vals)
        if avg_pe > 20:
            risks.append(f"밸류에이션 부담(평균 P/E {avg_pe:.0f}x)")
    if risks:
        L.append(f"주요 리스크: {', '.join(risks)}.\n")
    else:
        L.append("주요 리스크: 현재 특이사항 없음.\n")

    # 2) 기업별 1줄 판정
    _major_keys = sorted(k for k, v in SHIPBUILDER_STOCKS.items() if v.get("tier") == "major")
    for key in _major_keys:
        vc = val_ctx.get(key, {})
        ft = fin_trends.get(key, {})
        name = vc.get("name") or ft.get("name") or SHIPBUILDER_STOCKS.get(key, {}).get("name", key)
        pe = vc.get("pe_ttm")
        opm = ft.get("op_margin")
        # 판정
        if opm is not None and opm > 7 and pe is not None and pe < 15:
            verdict = "매력적"
        elif opm is not None and opm > 5:
            verdict = "보유"
        elif opm is not None and opm < 3:
            verdict = "관망"
        else:
            verdict = "중립"
        parts: list[str] = [f"- **{name}**:"]
        if opm is not None:
            parts.append(f"OPM {opm:.1f}%")
        if pe is not None:
            parts.append(f"P/E {pe:.0f}x")
        parts.append(f"— {verdict}")
        L.append(" ".join(parts))
    L.append("")

    # 3) 금주 관전 포인트
    L.append("**금주 관전 포인트**:")
    watchpoints: list[str] = []
    if peakout_warns:
        watchpoints.append("피크아웃 경고 지표 추이")
    order_axis = cycle["axis_scores"].get("order") if cycle and cycle.get("axis_scores") else None
    if order_axis is not None and order_axis > 60:
        watchpoints.append("신규 수주 모멘텀 지속 여부")
    demand_score_v = combined.get("market_pulse")
    if demand_score_v is not None:
        if demand_score_v > 55:
            watchpoints.append("운임·유가 z-score 추이")
        elif demand_score_v < 40:
            watchpoints.append("수요 환경 반등 가능성")
    if not watchpoints:
        watchpoints = ["DART 수주공시", "글로벌 운임 동향", "실적 발표 시즌 대비"]
    for wp in watchpoints[:3]:
        L.append(f"- {wp}")
    L.append("")
    return L


def _build_temporal_interpretation(
    axis_scores: dict[str, float | None], pulse: dict,
) -> list[str]:
    """선행(수주·운임) → 동행(실적) → 후행(밸류) 시간축 해석."""
    L: list[str] = []
    L.append("\n### 선행-동행-후행 프레임워크\n")
    L.append("지표를 시간축으로 재배열하면 사이클 방향을 더 명확히 읽을 수 있다.\n")

    # 축별 점수를 temporal 그룹으로 매핑
    groups: dict[str, list[tuple[str, float]]] = {"lead": [], "coincident": [], "lag": []}
    for axis, tag in INDICATOR_TEMPORAL_TAGS.items():
        if axis == "demand":
            score = pulse.get("score")
        else:
            score = axis_scores.get(axis) if axis_scores else None
        if score is not None:
            groups[tag].append((axis, score))

    for tag in ("lead", "coincident", "lag"):
        items = groups[tag]
        label = _TEMPORAL_LABELS[tag]
        if not items:
            continue
        avg_score = sum(s for _, s in items) / len(items)
        names = ", ".join(f"{a.title()}({s:.0f})" for a, s in items)
        direction = "▲ 상승" if avg_score > 55 else ("▼ 하락" if avg_score < 40 else "→ 보합")
        L.append(f"**{label}** ({direction}, 평균 {avg_score:.0f}/100): {names}")

    # 해석
    lead_scores = [s for _, s in groups["lead"]]
    coin_scores = [s for _, s in groups["coincident"]]
    lag_scores = [s for _, s in groups["lag"]]
    lead_avg = sum(lead_scores) / len(lead_scores) if lead_scores else None
    coin_avg = sum(coin_scores) / len(coin_scores) if coin_scores else None
    lag_avg = sum(lag_scores) / len(lag_scores) if lag_scores else None

    L.append("")
    if lead_avg is not None and coin_avg is not None:
        if lead_avg > coin_avg + 10:
            L.append("→ 선행지표 > 동행지표: 업사이클 가속 신호. 실적 개선이 뒤따를 가능성.")
        elif lead_avg < coin_avg - 10:
            L.append("→ 선행지표 < 동행지표: 모멘텀 둔화. 현재 실적은 좋지만 향후 감속 가능.")
        else:
            L.append("→ 선행·동행 균형: 현재 사이클 속도가 유지되고 있다.")
    if lag_avg is not None and coin_avg is not None:
        if lag_avg > coin_avg + 15:
            L.append("→ 후행(밸류) 고평가: 시장이 실적 이상으로 미래를 선반영. 밸류 부담.")
        elif lag_avg < coin_avg - 15:
            L.append("→ 후행(밸류) 저평가: 시장이 실적 개선을 아직 반영하지 못함. 재평가 여지.")
    L.append("")
    return L


def _build_scenario_section(combined: dict, cycle: dict | None) -> list[str]:
    """Bull/Base/Bear 3개 시나리오 × 예상점수/국면/함의."""
    L: list[str] = []
    L.append("### 시나리오 분석\n")
    current_score = combined.get("combined") or 0

    L.extend(["| 시나리오 | 확률 | 예상 점수 | 국면 | 핵심 동인 |",
              "|----------|------|----------|------|-----------|"])
    for key in ("bull", "base", "bear"):
        tmpl = SCENARIO_TEMPLATES[key]
        est_score = max(0, min(100, current_score + tmpl["score_delta"]))
        phase_c, phase_d = determine_cycle_phase(est_score)
        drivers_str = " / ".join(tmpl["drivers"][:2])
        L.append(f"| {tmpl['label']} | {tmpl['probability']} | {est_score:.0f}/100 | {phase_c} | {drivers_str} |")
    L.append("")

    # 시나리오별 함의
    for key in ("bull", "base", "bear"):
        tmpl = SCENARIO_TEMPLATES[key]
        est_score = max(0, min(100, current_score + tmpl["score_delta"]))
        phase_c, _ = determine_cycle_phase(est_score)
        L.append(f"**{tmpl['label']}** ({tmpl['probability']}): ", )
        for d in tmpl["drivers"]:
            L.append(f"  - {d}")
        L.append(f"  → 예상 종합 {est_score:.0f}/100 ({phase_c})\n")
    return L


# ══════════════════════════════════════════════════════════════════
#  Report
# ══════════════════════════════════════════════════════════════════

def _pct_str(val: float) -> str:
    return f"+{val:.1f}" if val > 0 else f"{val:.1f}"


def _delta_str(current: float | None, previous: float | None, suffix: str = "", pct: bool = False) -> str:
    """전월 대비 변동 문자열. 값이 없으면 빈 문자열."""
    if current is None or previous is None:
        return ""
    delta = current - previous
    if pct and previous != 0:
        delta_pct = (current - previous) / abs(previous) * 100
        return f" (전월 {previous:.1f}{suffix}, {delta_pct:+.1f}%)"
    return f" (전월 {previous:.1f}{suffix}, {delta:+.1f}{suffix})"


def _save_report_data(week: int, year: int, pulse: dict, combined: dict,
                      fin_trends: dict, val_ctx: dict, backlog: dict,
                      dart_data: dict | None, peakout: list,
                      vessel_mix: dict, manual: dict,
                      indicators: dict | None = None) -> Path:
    """리포트 수치를 JSON으로 저장 — 다음 리포트에서 전월 비교용."""
    report_data: dict[str, Any] = {
        "week": week, "year": year,
        "saved_at": datetime.now().isoformat(),
        "pulse_score": pulse.get("score"),
        "combined_score": combined.get("combined"),
        "cycle_score": combined.get("cycle_score"),
        "market_pulse": combined.get("market_pulse"),
    }
    # 밸류에이션
    val_summary: dict[str, Any] = {}
    for key, vc in val_ctx.items():
        val_summary[key] = {
            "name": vc.get("name"), "pe_ttm": vc.get("pe_ttm"),
            "pb": vc.get("pb"), "ev_ebitda": vc.get("ev_ebitda"),
            "market_cap": vc.get("market_cap"), "roe": vc.get("roe"),
            "pe_vs_avg_pct": vc.get("pe_vs_avg_pct"),
            "implied_peak_years": vc.get("implied_peak_years"),
        }
    report_data["valuation"] = val_summary

    # 실적
    fin_summary: dict[str, Any] = {}
    for key, ft in fin_trends.items():
        fin_summary[key] = {
            "name": ft.get("name"), "revenue": ft.get("revenue"),
            "operating_profit": ft.get("operating_profit"),
            "op_margin": ft.get("op_margin"), "op_margin_qoq": ft.get("op_margin_qoq"),
            "contract_assets": ft.get("contract_assets"),
            "contract_assets_qoq": ft.get("contract_assets_qoq"),
            "contract_liabilities": ft.get("contract_liabilities"),
            "roe": ft.get("roe"),
        }
    report_data["financials"] = fin_summary

    # 잔고 & 리드타임
    report_data["backlog"] = {
        "delivery_schedule": backlog.get("delivery_schedule", {}),
        "lead_time_avg_years": backlog.get("lead_time_avg_years"),
        "avg_backlog_coverage_quarters": backlog.get("avg_backlog_coverage_quarters"),
    }

    # 수주
    if dart_data and dart_data.get("estimates"):
        est = dart_data["estimates"]
        report_data["orders"] = {
            "total_orders": est.get("total_orders"),
            "total_ships": est.get("total_ships"),
            "avg_price_per_ship_usd": est.get("avg_price_per_ship_usd"),
            "total_amount_usd": est.get("total_amount_usd"),
            "by_type": est.get("by_type", {}),
        }

    # 선종 믹스
    report_data["vessel_mix"] = {
        "phase1_ratio": vessel_mix.get("phase1_ratio"),
        "phase2_ratio": vessel_mix.get("phase2_ratio"),
        "phase_signal": vessel_mix.get("phase_signal"),
    }

    # 피크아웃
    report_data["peakout"] = [
        {"key": p["key"], "value": p.get("value"), "status": p.get("status")}
        for p in peakout
    ]

    # 수동 지표
    report_data["manual_scores"] = manual.get("scores", {})

    # 수요 지표 (z-score)
    if indicators:
        demand_summary: dict[str, Any] = {}
        for k in MARKET_PULSE_WEIGHTS:
            ind = indicators.get(k)
            if ind:
                demand_summary[k] = {
                    "close": ind.get("close"), "zscore": ind.get("zscore"),
                    "change_pct": ind.get("change_pct"),
                }
        report_data["demand_indicators"] = demand_summary

    REPORT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = REPORT_DATA_DIR / f"report_data_{year}-W{week:02d}.json"
    out_path.write_text(json.dumps(report_data, ensure_ascii=False, indent=2))
    log(f"Report data saved: {out_path.name}")

    # ── Score History 누적 (최대 260주 = 5년) ──
    _append_score_history(week, year, combined, pulse, None)

    # ── Peakout History 누적 (최대 52주 = 1년) ──
    _append_peakout_history(peakout)

    # ── Vessel Mix History 누적 (최대 104주 = 2년) ──
    if vessel_mix:
        _append_vessel_mix_history(vessel_mix, week, year)

    # ── Order History 누적 (최대 104주 = 2년) ──
    _append_order_history(dart_data, week, year)

    return out_path


def _append_score_history(week: int, year: int, combined: dict,
                          pulse: dict, cycle: dict | None) -> None:
    """스코어 히스토리에 주간 엔트리 append (최대 260건)."""
    history: list[dict[str, Any]] = []
    if SCORE_HISTORY_FILE.exists():
        try:
            history = json.loads(SCORE_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    week_tag = f"{year}-W{week:02d}"
    entry: dict[str, Any] = {
        "date": datetime.now(KST).strftime("%Y-%m-%d"),
        "week_tag": week_tag,
        "year": year, "week": week,
        "combined": combined.get("combined"),
        "market_pulse": pulse.get("score"),
        "cycle_score": combined.get("cycle_score"),
        "pulse_details": pulse.get("details", {}),  # v6.1: WoW 비교용
    }
    # week_tag 기반 upsert (동일 주차 → 덮어쓰기)
    history = [h for h in history if not (h.get("year") == year and h.get("week") == week)]
    history.append(entry)
    # 최대 260건 유지
    if len(history) > 260:
        history = history[-260:]

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    SCORE_HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2))


def _load_score_history() -> list[dict[str, Any]]:
    """스코어 히스토리 로드."""
    if SCORE_HISTORY_FILE.exists():
        try:
            return json.loads(SCORE_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return []


def _load_longterm_proxies() -> dict[str, Any]:
    """장기 시계열 데이터 로드."""
    if LONGTERM_FILE.exists():
        try:
            return json.loads(LONGTERM_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _append_peakout_history(peakout: list) -> None:
    """피크아웃 히스토리에 주간 스냅샷 append (최대 52건)."""
    existing: list[dict[str, Any]] = _load_peakout_history()
    date_str = datetime.now(KST).strftime("%Y-%m-%d")
    snapshot: dict[str, Any] = {"date": date_str}
    for p in peakout:
        key = p.get("key", p.get("desc", "")[:10])
        snapshot[key] = p.get("value")
    # 같은 날짜 기존 엔트리 교체
    existing = [h for h in existing if h.get("date") != date_str]
    existing.append(snapshot)
    if len(existing) > 52:
        existing = existing[-52:]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    PEAKOUT_HISTORY_FILE.write_text(json.dumps(existing, ensure_ascii=False, indent=2))


def _load_peakout_history() -> list[dict[str, Any]]:
    """피크아웃 히스토리 로드."""
    if PEAKOUT_HISTORY_FILE.exists():
        try:
            return json.loads(PEAKOUT_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return []


def _append_vessel_mix_history(vessel_mix: dict, week: int, year: int) -> None:
    """선종 믹스 히스토리에 주간 엔트리 append (최대 104건 = 2년)."""
    history = _load_vessel_mix_history()
    week_tag = f"{year}-W{week:02d}"
    # 중복 주차 skip (멱등)
    if any(h.get("week_tag") == week_tag for h in history):
        return
    entry: dict[str, Any] = {
        "week_tag": week_tag,
        "date": datetime.now(KST).strftime("%Y-%m-%d"),
        "phase1_ratio": vessel_mix.get("phase1_ratio"),
        "phase2_ratio": vessel_mix.get("phase2_ratio"),
        "by_category": vessel_mix.get("by_category", {}),
        "total_ships": vessel_mix.get("total_ships", 0),
    }
    history.append(entry)
    if len(history) > 104:
        history = history[-104:]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    VESSEL_MIX_HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2))


def _load_vessel_mix_history() -> list[dict[str, Any]]:
    """선종 믹스 히스토리 로드."""
    if VESSEL_MIX_HISTORY_FILE.exists():
        try:
            return json.loads(VESSEL_MIX_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return []


def _append_order_history(dart_data: dict | None, week: int, year: int) -> None:
    """수주 히스토리에 주간 엔트리 append (최대 104건 = 2년)."""
    if not dart_data or not dart_data.get("estimates"):
        return
    est = dart_data["estimates"]
    history: list[dict[str, Any]] = []
    if ORDER_HISTORY_FILE.exists():
        try:
            history = json.loads(ORDER_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    week_tag = f"{year}-W{week:02d}"
    if any(h.get("week_tag") == week_tag for h in history):
        return
    # by_type에서 report_names 제거 (히스토리용 요약)
    by_type_clean: dict[str, dict[str, Any]] = {}
    for stype, info in est.get("by_type", {}).items():
        by_type_clean[stype] = {"count": info["count"], "amount_usd": info.get("amount_usd", 0)}
    entry: dict[str, Any] = {
        "week_tag": week_tag,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "total_orders": est.get("total_orders", 0),
        "total_ships": est.get("total_ships", 0),
        "avg_price_usd": est.get("avg_price_per_ship_usd", 0),
        "total_amount_usd": est.get("total_amount_usd", 0),
        "by_type": by_type_clean,
    }
    history.append(entry)
    if len(history) > 104:
        history = history[-104:]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ORDER_HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2))


def _load_order_history() -> list[dict[str, Any]]:
    """수주 히스토리 로드."""
    if ORDER_HISTORY_FILE.exists():
        try:
            return json.loads(ORDER_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return []


def _append_price_history(dart_data: dict | None) -> None:
    """선가 히스토리에 수집 시점 엔트리 append (최대 520건 = ~10년 평일)."""
    if not dart_data or not dart_data.get("estimates"):
        return
    est = dart_data["estimates"]
    if est.get("avg_price_per_ship_usd", 0) <= 0:
        return
    history: list[dict[str, Any]] = []
    if PRICE_HISTORY_FILE.exists():
        try:
            history = json.loads(PRICE_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    today = datetime.now().strftime("%Y-%m-%d")
    if any(h.get("date") == today for h in history):
        return
    by_type_prices: dict[str, float] = {}
    for stype, info in est.get("by_type", {}).items():
        cnt = info.get("count", 0)
        amt = info.get("amount_usd", 0)
        if cnt > 0 and amt > 0:
            by_type_prices[stype] = round(amt / cnt)
    entry: dict[str, Any] = {
        "date": today,
        "period": dart_data.get("period", ""),
        "avg_price_usd": est.get("avg_price_per_ship_usd", 0),
        "total_orders": est.get("total_orders", 0),
        "total_ships": est.get("total_ships", 0),
        "by_type": by_type_prices,
    }
    history.append(entry)
    if len(history) > 520:
        history = history[-520:]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    PRICE_HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2))


def _load_price_history() -> list[dict[str, Any]]:
    """선가 히스토리 로드."""
    if PRICE_HISTORY_FILE.exists():
        try:
            return json.loads(PRICE_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return []


def _load_previous_report_data(current_week: int | None = None,
                                current_year: int | None = None) -> dict | None:
    """가장 최근 이전 리포트 JSON 로드 (현재 주 제외)."""
    if not REPORT_DATA_DIR.exists():
        return None
    now = datetime.now()
    cw = current_week or now.isocalendar()[1]
    cy = current_year or now.isocalendar()[0]
    current_tag = f"report_data_{cy}-W{cw:02d}.json"

    candidates = sorted(REPORT_DATA_DIR.glob("report_data_*.json"), reverse=True)
    for f in candidates:
        if f.name == current_tag:
            continue
        try:
            return json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
    return None


def _build_company_master_table(fin_trends: dict, val_ctx: dict) -> list[str]:
    """기업 종합 마스터 테이블 (Section 2)."""
    valid_keys = set(SHIPBUILDER_STOCKS.keys())
    L: list[str] = []
    L.extend([
        "| 종목 | 시총 | P/E | P/B | OPM | m QoQ | 계약자산 | CA QoQ | CA YoY | 판단 |",
        "|------|------|-----|-----|-----|-------|---------|--------|--------|------|",
    ])
    # 밸류에이션 키 + 실적 키 + major tier 전부
    _major_keys = {k for k, v in SHIPBUILDER_STOCKS.items() if v.get("tier") == "major"}
    _data_keys = set(val_ctx.keys()) | set(fin_trends.keys())
    all_keys = sorted((_data_keys & valid_keys) | _major_keys)
    for key in all_keys:
        vc = val_ctx.get(key, {})
        ft = fin_trends.get(key, {})
        name = vc.get("name") or ft.get("name") or SHIPBUILDER_STOCKS.get(key, {}).get("name", key)
        # 시총
        mcap = vc.get("market_cap")
        mcap_str = f"{mcap / 1e12:.1f}조" if mcap else "-"
        pe = vc.get("pe_ttm")
        pe_str = f"{pe:.1f}x" if pe else "-"
        pb = vc.get("pb")
        pb_str = f"{pb:.1f}x" if pb else "-"
        opm = ft.get("op_margin")
        opm_str = f"{opm:.1f}%" if opm is not None else "-"
        opm_qoq = ft.get("op_margin_qoq")
        opm_qoq_str = f"{opm_qoq:+.1f}" if opm_qoq is not None else "-"
        ca = ft.get("contract_assets")
        ca_str = f"{ca / 1e12:.1f}조" if ca else "-"
        ca_qoq = ft.get("contract_assets_qoq")
        ca_qoq_str = f"{ca_qoq:+.1f}%" if ca_qoq is not None else "-"
        ca_yoy = ft.get("ca_yoy")
        ca_yoy_str = f"{ca_yoy:+.1f}%" if ca_yoy is not None else "-"
        judgment = ft.get("ca_judgment", "")
        seg_mark = "*" if ft.get("segment_adjusted") else ""
        L.append(f"| {name}{seg_mark} | {mcap_str} | {pe_str} | {pb_str} | {opm_str} | {opm_qoq_str} | {ca_str} | {ca_qoq_str} | {ca_yoy_str} | {judgment} |")
    # segment 분리 주석
    seg_notes = [(ft.get("name", k), ft.get("segment_name", ""), round(ft.get("segment_ratio", 0) * 100))
                 for k, ft in fin_trends.items() if ft.get("segment_adjusted")]
    if seg_notes:
        names = ", ".join(f"{n}({sn} {r}%)" for n, sn, r in seg_notes)
        L.append(f"\n*{names}: 연결 재무에서 부문 비율 근사 적용")
    return L


def _build_demand_table(indicators: dict) -> list[str]:
    """수요 환경 테이블 (Section 4)."""
    DEMAND_VESSEL_MAP = {
        "bdi": "벌크", "wti": "FPSO/탱커", "brent": "탱커", "natgas": "LNG",
        "steel": "전선종", "krw": "전선종",
    }
    L: list[str] = []
    L.extend([
        "| 지표 | 현재 | z-score | 방향 | 연계 선종 |",
        "|------|------|---------|------|----------|",
    ])
    for key in MARKET_PULSE_WEIGHTS:
        ind = indicators.get(key)
        if not ind:
            continue
        close = ind.get("close", 0)
        zscore = ind.get("zscore", 0)
        change = ind.get("change_pct", 0)
        direction = "↑" if change > 0 else ("↓" if change < 0 else "→")
        vessel = DEMAND_VESSEL_MAP.get(key, "")
        L.append(f"| {ind.get('name', key)} | {close:,.2f} | {zscore:+.2f} | {direction} | {vessel} |")
    return L


def _build_peakout_table(peakout: list) -> list[str]:
    """피크아웃 테이블 (Section 5)."""
    L: list[str] = []
    L.extend([
        "| 지표 | 현재 | 임계치 | 상태 | 비고 |",
        "|------|------|--------|------|------|",
    ])
    for p in peakout:
        val = p.get("value")
        val_str = f"{val:.1f}" if val is not None else "데이터 없음"
        threshold = p.get("threshold")
        th_str = f"{threshold:.1f}" if threshold is not None else "-"
        status = p.get("status", "")
        status_str = "⚠️ 경고" if status == "warning" else ("정상" if status == "normal" else "N/A")
        desc = p.get("desc", p.get("key", ""))
        L.append(f"| {desc} | {val_str} | {th_str} | {status_str} | {p.get('axis', '')} |")
    return L


def _scoring_detail_demand(pulse: dict, indicators: dict,
                           score_history: list | None = None) -> list[str]:
    """Demand 축 상세 — z-score + WoW변동 + 해석."""
    L: list[str] = []
    pulse_details = pulse.get("details", {})
    L.append("**수요 (Demand, 15%)**: Market Pulse {:.1f}/100".format(pulse.get("score", 0)))
    L.append("")
    L.append("**[측정방법]** 6개 거시지표의 z-score(52주 평균 대비 표준편차)를 5단계 비율로 변환 후 가중합산.")
    L.append("- **데이터 소스**: yfinance 일별 종가 (52주 이동평균·표준편차)")
    L.append("- **z-score → 비율 변환**: z>=+1.5→1.00 / z>=+0.5→0.75 / z>=-0.5→0.50 / z>=-1.5→0.25 / else→0.00")
    L.append("- **가중치**: BDI 25%, 천연가스 25%, WTI+Brent 각 15%, 후판 10%, 원/달러 10%")
    L.append("")

    # z-score 해석 매핑
    _DEMAND_INTERPRET: dict[str, dict[str, str]] = {
        "bdi":    {"pos": "건화물 수요 강세", "neu": "보합", "neg": "약세"},
        "natgas": {"pos": "LNG선 수요 강세", "neu": "보합", "neg": "약화 우려"},
        "wti":    {"pos": "에너지선 수요 호조", "neu": "중립", "neg": "수요 약화 가능"},
        "brent":  {"pos": "에너지선 수요 호조", "neu": "중립", "neg": "수요 약화 가능"},
        "steel":  {"pos": "후판가 상승→원가 압박", "neu": "보합", "neg": "원가 하락→마진 개선"},
        "krw":    {"pos": "원화 약세→수출 경쟁력 상승", "neu": "중립", "neg": "원화 강세→마진 축소"},
    }

    # 전주 z-score 추출 (score_history[-1] = 직전 저장분, 현재는 아직 미저장)
    prev_zscores: dict[str, float] = {}
    if score_history and len(score_history) >= 1:
        prev_entry = score_history[-1]
        prev_pulse_d = prev_entry.get("pulse_details", {})
        for k, d in prev_pulse_d.items():
            if "zscore" in d:
                prev_zscores[k] = d["zscore"]

    if pulse_details:
        L.extend(["| 지표 | 현재값 | z-score | WoW변동 | 비율 | 기여 | 가중 | 해석 |",
                   "|------|--------|---------|---------|------|------|------|------|"])
        groups: dict[str, list[float]] = {"Freight": [], "Energy": [], "Cost": []}
        for key, det in pulse_details.items():
            ind = indicators.get(key, {})
            close = ind.get("close", 0)
            z = det.get("zscore", 0)
            ratio = det.get("ratio")
            contrib = det.get("contribution")
            weight = det.get("weight", "")
            ratio_str = f"{ratio:.2f}" if ratio is not None else "-"
            contrib_str = f"{contrib:.1f}" if contrib is not None else "-"
            # WoW 변동
            prev_z = prev_zscores.get(key)
            wow_str = f"{z - prev_z:+.2f}" if prev_z is not None else "-"
            # 해석
            interp = _DEMAND_INTERPRET.get(key, {})
            if z >= 0.5:
                interpret = interp.get("pos", "호조")
            elif z <= -0.5:
                interpret = interp.get("neg", "부진")
            else:
                interpret = interp.get("neu", "중립")
            L.append(f"| {ind.get('name', key)} | {close:,.2f} | {z:+.2f} | "
                     f"{wow_str} | {ratio_str} | {contrib_str} | {weight} | {interpret} |")
            # 그룹별 집계
            if key in ("bdi",):
                groups["Freight"].append(z)
            elif key in ("wti", "brent", "natgas"):
                groups["Energy"].append(z)
            elif key in ("steel", "krw"):
                groups["Cost"].append(z)

        # 그룹별 요약 + 내러티브
        L.append("")
        group_names = {"Freight": "운임(건화물)", "Energy": "에너지(유가·가스)", "Cost": "원가(후판·환율)"}
        for gk, vals in groups.items():
            if vals:
                avg = sum(vals) / len(vals)
                label = "호조" if avg > 0.5 else ("부진" if avg < -0.5 else "보합")
                L.append(f"- **{group_names[gk]}**: z평균 {avg:+.2f} ({label})")
                # 그룹별 내러티브
                direction = "pos" if avg > 0.5 else ("neg" if avg < -0.5 else None)
                if direction and gk in ("Freight", "Energy"):
                    narrative = DEMAND_GROUP_NARRATIVES.get(f"{gk}.{direction}", "")
                    if narrative:
                        L.append(f"  {narrative}")
                elif gk == "Cost":
                    # Cost 그룹은 steel과 krw를 분리 해석
                    steel_z = pulse_details.get("steel", {}).get("zscore")
                    krw_z = pulse_details.get("krw", {}).get("zscore")
                    if steel_z is not None:
                        sd = "pos" if steel_z > 0.5 else ("neg" if steel_z < -0.5 else None)
                        if sd:
                            sn = DEMAND_GROUP_NARRATIVES.get(f"Cost.steel.{sd}", "")
                            if sn:
                                L.append(f"  {sn}")
                    if krw_z is not None:
                        kd = "pos" if krw_z > 0.5 else ("neg" if krw_z < -0.5 else None)
                        if kd:
                            kn = DEMAND_GROUP_NARRATIVES.get(f"Cost.krw.{kd}", "")
                            if kn:
                                L.append(f"  {kn}")

        # 운임 프록시 컨텍스트 (컨테이너 + 탱커)
        L.append("")
        # 컨테이너 프록시
        zim_ind = indicators.get("container_proxy", {})
        zim_z = zim_ind.get("zscore")
        if zim_z is not None:
            c_snap = CONTAINER_MARKET_SNAPSHOT
            c_label = "강세" if zim_z > 0.5 else ("약세" if zim_z < -0.5 else "보합")
            c_driver = c_snap.get("key_drivers", [""])[0] if c_snap.get("key_drivers") else ""
            L.append(f"**[컨테이너]** ZIM z={zim_z:+.2f} ({c_label}) | "
                     f"SCFI {c_snap.get('scfi_index', '-')} ({c_snap.get('scfi_yoy_change', '')}). "
                     f"{c_driver}")
        # 탱커 프록시
        tanker_keys = FREIGHT_PROXY_MAP.get("tanker_rate", [])
        tanker_zs: list[tuple[str, float]] = []
        for tk in tanker_keys:
            t_ind = indicators.get(tk, {})
            tz = t_ind.get("zscore")
            if tz is not None:
                ticker = TIER1_INDICATORS.get(tk, {}).get("ticker", tk)
                tanker_zs.append((ticker, tz))
        if tanker_zs:
            avg_tz = sum(z for _, z in tanker_zs) / len(tanker_zs)
            t_label = "강세" if avg_tz > 0.5 else ("약세" if avg_tz < -0.5 else "보합")
            z_strs = ", ".join(f"{t} z={z:+.2f}" for t, z in tanker_zs)
            t_snap = TANKER_MARKET_SNAPSHOT
            t_driver = t_snap.get("key_drivers", [""])[0] if t_snap.get("key_drivers") else ""
            L.append(f"**[탱커]** 프록시 z평균={avg_tz:+.2f} ({t_label}) | {z_strs}. "
                     f"VLCC ${t_snap.get('vlcc_dayrate_usd', '-')}/일. {t_driver}")

    L.append("")
    return L


def _scoring_detail_financial(cycle: dict | None, fin_trends: dict,
                               financials: dict | None = None) -> list[str]:
    """Financial 축 상세 — 매출/영업이익 절대값 + OPM/ROE + 계약자산."""
    valid_keys = set(SHIPBUILDER_STOCKS.keys())
    L: list[str] = []
    fin_score = (cycle or {}).get("axis_scores", {}).get("financial")
    L.append(f"**실적 (Financial, 25%)**: {fin_score:.0f}/100" if fin_score is not None else "**실적 (Financial, 25%)**: 데이터 부족")
    L.append("")
    L.append("**[측정방법]** 각 조선사의 OPM/ROE를 0~100 점수로 변환 후 전사 평균.")
    L.append("- OPM 점수 = min(100, max(0, OPM%)) x 10 | ROE 점수 = min(100, max(0, ROE%/3)) x 10")
    L.append("")

    if fin_trends:
        # 기업별 실적 테이블 (매출/영업이익 절대값 포함)
        L.extend(["| 기업 | 매출(조) | 영업이익(억) | OPM% | QoQ | ROE% | OPM→점수 | ROE→점수 |",
                   "|------|---------|------------|------|-----|------|----------|----------|"])
        for key, ft in fin_trends.items():
            if key not in valid_keys:
                continue
            name = ft.get("name", key)
            opm = ft.get("op_margin")
            roe = ft.get("roe")
            opm_qoq = ft.get("op_margin_qoq")
            rev = ft.get("revenue")
            op = ft.get("operating_profit")
            rev_str = f"{rev / 1e12:.2f}" if rev else "-"
            op_str = f"{op / 1e8:.0f}" if op else "-"
            opm_str = f"{opm:.1f}" if opm is not None else "-"
            qoq_str = f"{opm_qoq:+.1f}%p" if opm_qoq is not None else "-"
            opm_sc = f"{min(10, max(0, opm)) * 10:.0f}" if opm is not None else "-"
            roe_str = f"{roe:.1f}" if roe is not None else "-"
            roe_sc = f"{min(10, max(0, roe / 3)) * 10:.0f}" if roe is not None else "-"
            seg_mark = " *" if ft.get("segment_adjusted") else ""
            L.append(f"| {name}{seg_mark} | {rev_str} | {op_str} | {opm_str} | {qoq_str} | {roe_str} | {opm_sc} | {roe_sc} |")

        # 세그먼트 주석
        seg_keys = [k for k, ft in fin_trends.items() if k in valid_keys and ft.get("segment_adjusted")]
        if seg_keys:
            for sk in seg_keys:
                ft = fin_trends[sk]
                pct = round(ft.get("segment_ratio", 0) * 100)
                L.append(f"> *{ft.get('name', sk)}: {ft.get('segment_name', '조선')} {pct}% 비중 적용*")

        # 계약자산(잔고) 추이 테이블
        ca_rows: list[tuple[str, ...]] = []
        for key, ft in fin_trends.items():
            if key not in valid_keys:
                continue
            ca = ft.get("contract_assets")
            ca_qoq = ft.get("contract_assets_qoq")
            ca_j = ft.get("ca_judgment", "")
            if ca is not None:
                ca_rows.append((ft.get("name", key), f"{ca / 1e12:.2f}", f"{ca_qoq:+.1f}%" if ca_qoq is not None else "-", ca_j))
        if ca_rows:
            L.append("")
            L.extend(["| 기업 | 계약자산(조) | QoQ | 판단 |",
                       "|------|------------|-----|------|"])
            for name, ca_s, qoq_s, judge in ca_rows:
                L.append(f"| {name} | {ca_s} | {qoq_s} | {judge} |")

        # 기업별 현황 내러티브
        L.append("")
        L.append("**기업별 현황**:")
        for key, ft in fin_trends.items():
            if key not in valid_keys:
                continue
            profile = MAJOR_PROFILES.get(key)
            if not profile:
                continue
            name = profile["name"]
            focus = ", ".join(v.split("(")[0] for v in profile["focus_vessels"][:2])
            opm = ft.get("op_margin")
            opm_qoq = ft.get("op_margin_qoq")
            # OPM+QoQ 조합으로 상황 판단
            if opm is not None and opm > 5:
                if opm_qoq is not None and opm_qoq > 0:
                    status = "실적 호조"
                elif opm_qoq is not None and opm_qoq < -2:
                    status = "마진 둔화"
                else:
                    status = "안정"
            elif opm is not None and opm > 0:
                if opm_qoq is not None and opm_qoq > 0:
                    status = "마진 개선 중"
                else:
                    status = "저마진"
            elif opm is not None:
                status = "실적 악화"
            else:
                status = "데이터 부족"
            edge = profile.get("competitive_edge", "")[:60]
            opm_str = f"OPM {opm:.0f}%" if opm is not None else ""
            L.append(f"- **{name}** ({status}): 주력 {focus}. {opm_str}. {edge}")

    L.append("")
    return L


def _scoring_detail_order(cycle: dict | None, dart_data: dict | None,
                           fin_trends: dict) -> list[str]:
    """Order 축 상세 — 기업별 수주 + 대형 수주 Top 5 + 선종 믹스."""
    L: list[str] = []
    order_score = (cycle or {}).get("axis_scores", {}).get("order")
    L.append(f"**수주 (Order, 22%)**: {order_score:.0f}/100" if order_score is not None else "**수주 (Order, 22%)**: 데이터 부족")
    L.append("")
    L.append("**[측정방법]** 3개 하위지표: 수주건수(x5, cap100) + 평균선가(/300M) + 계약자산 QoQ(50+QoQ%x2.5)")
    L.append("")

    if dart_data and dart_data.get("estimates"):
        est = dart_data["estimates"]
        n_orders = est.get("total_orders", 0)
        order_cnt_sc = min(100, n_orders * 5)
        L.append(f"- 건수: {n_orders}건 x 5 = {n_orders * 5} → cap {order_cnt_sc:.0f}")
        avg_price = est.get("avg_price_per_ship_usd", 0)
        if avg_price > 0:
            price_sc = min(100, avg_price / 3_000_000)
            L.append(f"- 선가: ${avg_price / 1e6:.0f}M / $300M = {price_sc:.1f}")
        ca_qoqs = [ft["contract_assets_qoq"] for ft in fin_trends.values() if ft.get("contract_assets_qoq") is not None]
        if ca_qoqs:
            avg_ca = sum(ca_qoqs) / len(ca_qoqs)
            ca_sc = min(100, max(0, 50 + avg_ca * 2.5))
            L.append(f"- 계약자산 QoQ: {avg_ca:+.1f}% → 50 + ({avg_ca:.1f} x 2.5) = {ca_sc:.1f}")
        L.append("")

        # 기업별 수주 현황 테이블
        orders = dart_data.get("orders", [])
        if orders:
            company_orders: dict[str, dict] = {}
            for o in orders:
                k = o.get("key", "기타")
                if k not in company_orders:
                    company_orders[k] = {"count": 0, "ships": 0, "amount": 0, "types": []}
                company_orders[k]["count"] += 1
                company_orders[k]["ships"] += o.get("ship_count", 1)
                company_orders[k]["amount"] += o.get("contract_amount_usd", 0)
                vt = _classify_vessel_type(o.get("report_name", ""), o)
                if vt and vt != "미분류":
                    company_orders[k]["types"].append(vt)

            L.extend(["| 기업 | 건수 | 척수 | 금액(억$) | 주요선종 |",
                       "|------|------|------|----------|---------|"])
            for k in sorted(company_orders.keys()):
                co = company_orders[k]
                name = SHIPBUILDER_STOCKS.get(k, {}).get("name", k)
                amt = co["amount"] / 1e8 if co["amount"] > 0 else 0
                # 선종 빈도 상위 2개
                from collections import Counter
                type_counts = Counter(co["types"])
                top_types = ", ".join(t for t, _ in type_counts.most_common(2)) or "-"
                L.append(f"| {name} | {co['count']} | {co['ships']} | {amt:.1f} | {top_types} |")
            L.append("")

            # 대형 수주 Top 5 (금액순)
            sorted_orders = sorted(orders, key=lambda o: o.get("contract_amount_usd", 0), reverse=True)
            top5 = sorted_orders[:5]
            if top5 and top5[0].get("contract_amount_usd", 0) > 0:
                L.append("**대형 수주 Top 5**:")
                for i, o in enumerate(top5, 1):
                    name = SHIPBUILDER_STOCKS.get(o.get("key", ""), {}).get("name", o.get("key", "?"))
                    amt_usd = o.get("contract_amount_usd", 0)
                    vt = _classify_vessel_type(o.get("report_name", ""), o)
                    rpt = o.get("report_name", "")[:40]
                    L.append(f"  {i}. {name} ${amt_usd / 1e6:.0f}M ({vt}) — {rpt}")
                L.append("")

            # 선종 믹스: Phase1(LNG/컨) vs Phase2(탱커/벌크) 비율
            all_types = []
            for o in orders:
                vt = _classify_vessel_type(o.get("report_name", ""), o)
                cnt = o.get("ship_count", 1)
                all_types.extend([vt] * cnt)
            if all_types:
                from collections import Counter as _C2
                tc = _C2(all_types)
                total = sum(tc.values())
                phase1 = sum(tc.get(t, 0) for t in ("LNG운반선", "컨테이너선"))
                phase2 = sum(tc.get(t, 0) for t in ("탱커", "VLCC", "벌크선", "PC선", "수에즈맥스"))
                if total > 0:
                    L.append(f"- 선종 비중: Phase1(LNG/컨) {phase1/total*100:.0f}% vs Phase2(탱커/벌크) {phase2/total*100:.0f}%")
                    L.append("")

                # 주요 선종별 시장 환경
                seen_types: set[str] = set()
                vessel_lines: list[str] = []
                for vtype, count in tc.most_common():
                    if vtype == "미분류" or vtype in seen_types:
                        continue
                    seen_types.add(vtype)
                    driver_info = VESSEL_DRIVERS.get(vtype)
                    if not driver_info:
                        continue
                    stage = driver_info.get("cycle_stage", "")
                    drivers_top2 = "; ".join(driver_info.get("drivers", [])[:2])
                    line = f"- **{vtype}** ({count}척, {stage}): {drivers_top2}"
                    # LNG운반선 → 파이프라인 추가
                    if vtype == "LNG운반선":
                        pipeline = driver_info.get("pipeline", {})
                        if pipeline:
                            line += f"\n  → 확정 미발주 파이프라인: {pipeline.get('total', '-')}"
                    # 컨테이너선 → SCFI 추가
                    elif vtype == "컨테이너선":
                        c_snap = CONTAINER_MARKET_SNAPSHOT
                        line += f"\n  → SCFI {c_snap.get('scfi_index', '-')} ({c_snap.get('scfi_yoy_change', '')})"
                    # 탱커 계열 → dayrate + 섀도우 플릿 추가
                    elif vtype in ("탱커", "VLCC"):
                        t_snap = TANKER_MARKET_SNAPSHOT
                        fa = t_snap.get("fleet_age", {})
                        shadow = t_snap.get("shadow_fleet", {})
                        shadow_str = f", 섀도우 플릿 {shadow['sanctioned_vessels']}({shadow['pct_of_global_tanker']}%)" if shadow else ""
                        line += (f"\n  → VLCC ${t_snap.get('vlcc_dayrate_usd', '-')}/일, "
                                 f"오더북/함대 {t_snap.get('orderbook_to_fleet', '-')}, "
                                 f"선령20y+ {fa.get('20y_plus_pct', '-')}%{shadow_str}")
                    vessel_lines.append(line)
                if vessel_lines:
                    L.append("**주요 선종별 시장 환경**:")
                    L.extend(vessel_lines)
                    L.append("")
    L.append("")
    return L


def _scoring_detail_valuation(cycle: dict | None, val_ctx: dict) -> list[str]:
    """Valuation 축 상세 — 시총/PE/EV·EBITDA/20Y위치/해석."""
    valid_keys = set(SHIPBUILDER_STOCKS.keys())
    L: list[str] = []
    val_score = (cycle or {}).get("axis_scores", {}).get("valuation")
    L.append(f"**밸류에이션 (Valuation, 13%)**: {val_score:.0f}/100" if val_score is not None else "**밸류에이션 (Valuation, 13%)**: 데이터 부족")
    L.append("")
    L.append("**[측정방법]** 현재 PE를 20Y 역사적 평균과 비교. 사이클 역지표.")
    L.append("- 점수 = max(0, min(100, 100 - (괴리%+50) x 0.67))")
    L.append("- 높은 점수 = 저평가 = 초기 사이클 / 낮은 점수 = 고평가 = 후기 사이클")
    L.append("")
    if val_ctx:
        L.extend(["| 기업 | 시총(조) | PE TTM | PE소스 | EV/EBITDA | 20Y평균 | 괴리% | 20Y내위치 | →점수 | 해석 |",
                   "|------|---------|--------|--------|----------|---------|-------|----------|-------|------|"])
        for key, vc in val_ctx.items():
            if key not in valid_keys:
                continue
            name = vc.get("name", key)
            pe = vc.get("pe_ttm")
            pe_src = vc.get("pe_source", "-")
            mcap = vc.get("market_cap")
            mcap_str = f"{mcap / 1e12:.1f}" if mcap else "-"
            ev_ebitda = vc.get("ev_ebitda")
            ev_str = f"{ev_ebitda:.1f}" if ev_ebitda else "-"
            hist = HISTORICAL_PE_RANGES.get(key, {})
            pe_note = vc.get("pe_note", "")
            pe_suffix = f" *({pe_note})*" if pe_note else ""

            if pe is not None and hist.get("avg"):
                vs_pct = (pe / hist["avg"] - 1) * 100
                sc = max(0, min(100, 100 - (vs_pct + 50) * 0.67))
                # 20Y 내 위치 (백분위)
                pe_range = hist["max"] - hist["min"]
                position = round((pe - hist["min"]) / pe_range * 100, 0) if pe_range > 0 else 50
                position = max(0, min(100, position))
                # 해석
                if vs_pct > 50:
                    interpret = "고평가(후기)"
                elif vs_pct > -20:
                    interpret = "적정 밴드"
                else:
                    interpret = "저평가(초기)"
                L.append(f"| {name} | {mcap_str} | {pe:.1f}x{pe_suffix} | {pe_src} | "
                         f"{ev_str} | {hist['avg']:.0f}x | {vs_pct:+.0f}% | {position:.0f}% | {sc:.1f} | {interpret} |")
            elif pe is not None:
                L.append(f"| {name} | {mcap_str} | {pe:.1f}x{pe_suffix} | {pe_src} | {ev_str} | - | - | - | - | - |")

        # 주목할 기업 코멘트 (저평가/고평가만)
        notable: list[str] = []
        for key, vc in val_ctx.items():
            if key not in valid_keys:
                continue
            pe = vc.get("pe_ttm")
            hist = HISTORICAL_PE_RANGES.get(key, {})
            profile = MAJOR_PROFILES.get(key)
            if pe is None or not hist.get("avg") or not profile:
                continue
            vs_pct = (pe / hist["avg"] - 1) * 100
            if vs_pct > 50:
                peak = hist.get("peak_range", "")
                edge = profile.get("competitive_edge", "")[:60]
                notable.append(f"> {profile['name']}: PE {pe:.1f}x — 역사적 고평가 구간 접근. 과거 피크 PE {peak}. {edge}")
            elif vs_pct < -20:
                edge = profile.get("competitive_edge", "")[:60]
                trough = hist.get("trough", "")
                notable.append(f"> {profile['name']}: PE {pe:.1f}x — 저평가(초기). {edge}. 과거 저점: {trough}")
        if notable:
            L.append("")
            L.extend(notable)

    L.append("")
    return L


def _scoring_detail_structural(cycle: dict | None, manual: dict,
                                indicators: dict) -> list[str]:
    """Structural 축 상세 — 근거/해석 + staleness 경고."""
    L: list[str] = []
    struct_score = (cycle or {}).get("axis_scores", {}).get("structural")
    L.append(f"**구조 (Structural, 25%)**: {struct_score:.0f}/100" if struct_score is not None else "**구조 (Structural, 25%)**: 데이터 부족")
    L.append("")
    L.append("**[측정방법]** 5개 구조적 지표를 1~10 점수로 평가 후 가중합산. 수동 + 자동 프록시 혼합.")
    L.append("")

    # 구체적 근거 매핑 (수동 지표) — v6.2 확장 컨텍스트
    _MANUAL_RATIONALE: dict[str, str] = {
        "regulation":     ("IMO EEXI(기존선 에너지효율)/CII(탄소집약도)/ETS(배출권거래) 3중 규제. "
                           "2027년 본격 시행으로 교체 수요 가속. 저탄소 엔진 전환율 15% 불과. "
                           "미국 관세에서 조선=전략적 필수재 면제 대상 — 수출 경쟁력 보호"),
        "china_capacity": ("중국 캐파 증설 진행 중이나 고부가(LNG 멤브레인 NO96) 미진입. "
                           "벌크·컨테이너 물량 독점(47%) — 한국은 고부가 특화로 경합 제한적"),
        "vessel_age":     ("전 세계 선대 선령 20y+ 22%, 15y+ 51% — 역사적 고령. "
                           "CII 등급 하락 시 강제 감속·퇴역 압력 가중. 교체 사이클 본격 진입"),
    }

    manual_scores = manual.get("scores", {})
    auto_scores = auto_structural_scores(indicators) if indicators else {}

    L.extend(["| 지표 | 값(1-10) | 가중치 | 유형 | 근거/해석 |",
               "|------|----------|--------|------|----------|"])
    for key, meta in MANUAL_INDICATORS.items():
        val = manual_scores.get(key)
        auto_val = auto_scores.get(key)
        if val is not None:
            rationale = _MANUAL_RATIONALE.get(key, meta['desc'])
            L.append(f"| {meta['name']} | {val:.1f} | {meta['weight']}% | 수동 | {rationale} |")
        elif auto_val is not None:
            # 자동 프록시: 원본 z-score + 스냅샷 내러티브
            proxy_keys = FREIGHT_PROXY_MAP.get(key, [])
            z_parts: list[str] = []
            for pk in proxy_keys:
                ind = indicators.get(pk, {})
                if "zscore" in ind:
                    ticker = TIER1_INDICATORS.get(pk, {}).get("ticker", pk)
                    z_parts.append(f"{ticker} z={ind['zscore']:+.2f}")
            z_info = ", ".join(z_parts) if z_parts else "프록시"
            # 스냅샷 컨텍스트 추가
            snap_ctx = ""
            if key == "container_rate":
                c_snap = CONTAINER_MARKET_SNAPSHOT
                c_driver = c_snap.get("key_drivers", [""])[0] if c_snap.get("key_drivers") else ""
                snap_ctx = f". SCFI {c_snap.get('scfi_index', '-')}. {c_driver}"
            elif key == "tanker_rate":
                t_snap = TANKER_MARKET_SNAPSHOT
                t_driver = t_snap.get("key_drivers", [""])[0] if t_snap.get("key_drivers") else ""
                shadow = t_snap.get("shadow_fleet", {})
                shadow_ctx = f" 섀도우 플릿 {shadow['sanctioned_vessels']}({shadow['pct_of_global_tanker']}%) 제재." if shadow else ""
                snap_ctx = f". VLCC ${t_snap.get('vlcc_dayrate_usd', '-')}/일. {t_driver}.{shadow_ctx}"
            L.append(f"| {meta['name']} | {auto_val:.1f} | {meta['weight']}% | 자동 | {z_info}{snap_ctx} |")
        else:
            L.append(f"| {meta['name']} | - | {meta['weight']}% | **미입력** | `--manual-update {key}=N` 으로 설정 필요 |")

    # 공급 부족 신호 (정적 지식 기반)
    shortage = INDUSTRY_INTRO.get("supply_shortage_signals")
    if shortage:
        L.append("\n**[공급 부족 신호]**")
        if shortage.get("secondhand_parity"):
            L.append(f"- 중고선 패리티: {shortage['secondhand_parity']}")
        if shortage.get("orderbook_to_fleet"):
            L.append(f"- 오더북/함대비: {shortage['orderbook_to_fleet']}")
        if shortage.get("yard_capacity_vs_demand"):
            L.append(f"- 캐파 대비 수요: {shortage['yard_capacity_vs_demand']}")

    # staleness 경고
    updated_at = manual.get("updated_at")
    if updated_at:
        try:
            updated_dt = datetime.fromisoformat(updated_at)
            days_ago = (datetime.now() - updated_dt).days
            if days_ago > 90:
                L.append(f"\n> **수동 지표 {days_ago}일 미갱신** — `--manual-update`로 최신화 필요")
        except (ValueError, TypeError):
            pass
    elif manual_scores:
        pass  # updated_at 없지만 scores 존재 → OK
    else:
        L.append("\n> **수동 지표 미설정** — `--manual-update regulation=8 china_capacity=4 vessel_age=8` 실행 필요")
    L.append("")
    return L


def _build_scoring_detail_section(pulse: dict, cycle: dict | None,
                                   fin_trends: dict, val_ctx: dict,
                                   dart_data: dict | None,
                                   manual: dict, indicators: dict,
                                   financials: dict | None = None,
                                   score_history: list | None = None) -> list[str]:
    """축별 산출 근거 — 5개 서브함수로 위임. v6.2 컨텍스트 내러티브 강화."""
    L: list[str] = ["", "### 축별 산출 근거", ""]
    L.append("> 종합점수 = Market Pulse(수요) x 15% + Cycle Score(실적+수주+밸류+구조) x 85%\n")
    L.extend(_scoring_detail_demand(pulse, indicators, score_history))
    L.extend(_scoring_detail_financial(cycle, fin_trends, financials))
    L.extend(_scoring_detail_order(cycle, dart_data, fin_trends))
    L.extend(_scoring_detail_valuation(cycle, val_ctx))
    L.extend(_scoring_detail_structural(cycle, manual, indicators))
    return L


def build_weekly_report(data: dict, pulse: dict, cycle: dict | None,
                        combined: dict, signals: list, dart_data: dict | None,
                        fin_trends: dict | None = None, val_ctx: dict | None = None,
                        backlog: dict | None = None, peakout: list | None = None,
                        vessel_mix: dict | None = None,
                        prev_data: dict | None = None,
                        financials: dict | None = None) -> str:
    """v6.0 리포트 — 투자판단 요약/시나리오/선행-후행 프레임워크 추가."""
    now = datetime.now()
    week = now.isocalendar()[1]
    phase_score = combined.get("combined") or pulse["score"]
    phase_code, phase_desc = determine_cycle_phase(phase_score)
    indicators = data.get("indicators", {})
    fin_trends = fin_trends or {}
    val_ctx = val_ctx or {}
    backlog = backlog or {}
    peakout = peakout or []
    vessel_mix = vessel_mix or {}
    prev = prev_data or {}

    peakout_any = any(p["status"] == "warning" for p in peakout)
    has_prev = bool(prev)
    prev_label = f"{prev.get('year', '?')}년 {prev.get('week', '?')}주차" if has_prev else ""
    L = [f"# 조선업 사이클 분석 리포트 — {now.year}년 {now.month}월 ({week}주차)\n"]

    if not has_prev:
        L.append("> *첫 리포트 — 다음 기부터 전월 변동 추적 시작*\n")

    # ══════════════════════════════════════════════════════════════
    # 투자 판단 요약 (최상단)
    # ══════════════════════════════════════════════════════════════
    L.extend(_build_investment_judgment_section(
        combined, fin_trends, val_ctx, peakout, phase_code, phase_score,
        pulse, cycle))

    # ══════════════════════════════════════════════════════════════
    # 조선업 개요 (정적 콘텐츠)
    # ══════════════════════════════════════════════════════════════
    L.append("## 조선업 개요\n")
    L.append("### 이 산업은 무엇인가")
    L.append(INDUSTRY_INTRO["what"] + "\n")
    L.append("### 지금 왜 중요한가")
    L.append(INDUSTRY_INTRO["why_now"] + "\n")
    L.append("### 구조적 수요 체인 (Top-Down)")
    L.append(INDUSTRY_INTRO["demand_chain"] + "\n")
    L.append("### 슈퍼사이클 3단계")
    L.extend(["| 단계 | 시기 | 핵심 동인 |", "|------|------|-----------|"])
    for row in INDUSTRY_INTRO["supercycle_table"]:
        L.append(f"| {row['stage']} | {row['period']} | {row['driver']} |")
    L.append(f"\n> 참고: {INDUSTRY_INTRO['historical_ref']}\n")

    # ══════════════════════════════════════════════════════════════
    # 1. 사이클 종합 판정
    # ══════════════════════════════════════════════════════════════
    L.append("## 1. 사이클 종합 판정\n")
    L.append("조선업 사이클은 수주→건조→인도의 3~5년 주기를 가진다. "
             "5개 축으로 현재 위치를 0~100 스코어로 산출한다.\n")
    L.append("| 축 | 가중치 | 측정 대상 | 데이터 소스 |")
    L.append("|---|--------|----------|-----------|")
    L.append("| 수요 | 15% | BDI·유가·천연가스·후판·환율의 z-score 가중합 | yfinance 52주 |")
    L.append("| 실적 | 25% | 영업이익률(OPM)·자기자본이익률(ROE) | DART 분기 재무제표 |")
    L.append("| 수주 | 22% | 수주건수·평균선가·계약자산 QoQ | DART 수주공시+재무 |")
    L.append("| 밸류에이션 | 13% | P/E vs 20년 역사평균 (역지표) | yfinance+수동통계 |")
    L.append("| 구조 | 25% | IMO규제·중국캐파·노후선·운임 | 전문가 수동+운임 프록시 |")
    L.append("")
    L.append("> **종합점수** = 수요(Market Pulse) x 15% + Cycle Score(실적+수주+밸류+구조 가중평균) x 85%")
    L.append(f"**{phase_code} ({phase_score:.1f}/100)** — {phase_desc}\n")

    prev_combined = prev.get("combined_score")
    prev_pulse = prev.get("pulse_score") or prev.get("market_pulse")
    prev_cycle = prev.get("cycle_score")

    L.extend(["| 항목 | 현재 | 전월 | 변동 |",
              "|------|------|------|------|"])
    _add_comparison_row(L, "Combined Score", combined.get("combined"), prev_combined, "/100")
    _add_comparison_row(L, "Demand 환경", combined.get("market_pulse"), prev_pulse, "/100")
    _add_comparison_row(L, "Cycle 구조", combined.get("cycle_score"), prev_cycle, "/100")

    # 축별 기여도
    manual = data.get("manual", {})
    if cycle and cycle.get("axis_scores"):
        L.append("\n**축별 기여도**:\n")
        for axis, weight in CYCLE_SCORE_WEIGHTS.items():
            if axis == "demand":
                sc = pulse.get("score")  # Market Pulse 점수
            else:
                sc = cycle["axis_scores"].get(axis)
            sc_str = f"{sc:.0f}/100" if sc is not None else "데이터 부족"
            L.append(f"- {axis.title()} ({weight}%): {sc_str}")
        # 축별 산출 근거 (v6.2: 컨텍스트 내러티브 강화)
        score_history = _load_score_history() if SCORE_HISTORY_FILE.exists() else []
        L.extend(_build_scoring_detail_section(pulse, cycle, fin_trends, val_ctx,
                                                dart_data, manual, indicators,
                                                financials=financials,
                                                score_history=score_history))

    L.append(f"\n- 사이클 단계: {SUPERCYCLE_LABELS['PRE']}")
    if peakout_any:
        warn_items = [p["desc"] for p in peakout if p["status"] == "warning"]
        L.append(f"- ⚠️ **피크아웃 경고**: {', '.join(warn_items)}")
    else:
        L.append("- 피크아웃: 미감지")

    # 종합 판단 — 정의(사이클 단계 해석) + 고찰(→ 판정문)
    L.append("\n**판단**: ")
    if phase_score >= 86:
        L.append(f"Combined Score {phase_score:.0f}점 — 과열 국면. "
                 "캐파 풀, 선가 역사적 고점대. 피크아웃 징후 감시가 최우선.")
        L.append("\n → 과열 구간 진입. 실적은 정점이나 추가 상승 여력 극히 제한. "
                 "경고 지표 동시 이탈 시 포지션 축소 검토.")
    elif phase_score >= 66:
        L.append(f"Combined Score {phase_score:.0f}점 — 피크 국면. "
                 "캐파 풀, 리드타임 최장. 추가 상승 여력보다 피크아웃 감시가 중요.")
        L.append("\n → 피크 진입. 실적은 좋지만 추가 상승 여력 제한. "
                 "피크아웃 지표 모니터링 최우선.")
    elif phase_score >= 46:
        L.append(f"Combined Score {phase_score:.0f}점 — 확장 국면. "
                 "수주가 늘고 선가가 오르는 단계. 조선소 가동률 상승, 실적 개선 본격화.")
        L.append("\n → 확장 중반. 수주와 실적 동시 개선 — 업사이클에서 가장 매력적인 구간.")
    elif phase_score >= 26:
        L.append(f"Combined Score {phase_score:.0f}점 — 초기 회복 국면. "
                 "노후선 교체 시작, 선행 지표에서 개선 징후.")
        L.append("\n → 초기 회복. 선행지표 개선 시 선취매 구간. 아직 실적 반영 전.")
    else:
        L.append(f"Combined Score {phase_score:.0f}점 — 불황 국면. "
                 "수주 감소, 선가 하락, 실적 악화의 삼중고.")
        L.append("\n → 불황. 신규 투자 자제. 구조적 변화(규제·노후선) 모니터링.")

    # 슈퍼사이클 단계 해설
    L.append("\n**슈퍼사이클 단계**: "
             "현재 1기(Pre-Supercycle) — LNG·컨테이너가 수주의 주력. "
             "2기(Real Supercycle)는 탱커·벌커의 CO₂규제 교체가 시작될 때. "
             "2기 비중이 1기를 역전하면 진정한 슈퍼사이클로 판단한다.")
    L.append("\n> \"전세계 조선 캐파는 필요한 수요에 비해 1/3도 되지 않는다\" "
             "— 공급 제약이 사이클 지속의 핵심 (김봉수 교수, KAIST)")

    # 역사적 슈퍼사이클 패턴 비교
    hp = INDUSTRY_INTRO.get("historical_pattern")
    if hp:
        L.append(f"\n**{hp['title']}**")
        L.append(f"- **2003-07**: {hp['then']}")
        L.append(f"- **현재**: {hp['now']}")
        L.append(f"- **시사점**: {hp['implication']}\n")

    # 차트 해설: 장기 사이클 프록시
    L.append("\n> **장기 사이클 프록시 차트**: 5개 선종 대표주의 장기 정규화 추이. "
             "FRO(탱커), SBLK(벌크), Cheniere(LNG), ZIM(컨테이너), Transocean(해양플랜트). "
             "회색 음영은 2003-2008 슈퍼사이클. 다수 지표가 동시에 "
             "50 이상이면 전 선종 호황 → 조선 수주 호조.")
    L.append("> **스코어 추이 차트**: Combined Score의 주간 추이. "
             "상승 추세면 업사이클 가속, 하락 전환 시 피크아웃 경계.")

    # 선행-동행-후행 프레임워크
    axis_scores = (cycle or {}).get("axis_scores", {})
    L.extend(_build_temporal_interpretation(axis_scores, pulse))

    # 시나리오 분석
    L.extend(_build_scenario_section(combined, cycle))

    # ══════════════════════════════════════════════════════════════
    # 2. 기업 종합
    # ══════════════════════════════════════════════════════════════
    L.append("\n## 2. 기업 종합\n")
    n_companies = len(set(list(val_ctx.keys()) + list(fin_trends.keys())))
    if n_companies == 0:
        n_companies = len([s for s in SHIPBUILDER_STOCKS.values() if s["tier"] == "major"])
    L.append(f"조선 {n_companies}사의 실적과 밸류에이션을 비교한다.\n"
             "- P/E(주가수익비율): 주가가 순이익의 몇 배인지. 낮을수록 저평가\n"
             "- OPM(영업이익률): 매출 대비 영업이익 비중. 조선업 장기 평균 5~7%\n"
             "- 계약자산: 수주잔고의 회계적 표현. 증가하면 향후 매출 파이프라인이 두텁다\n")

    if val_ctx or fin_trends:
        L.extend(_build_company_master_table(fin_trends, val_ctx))

        # 기업별 판정 (P/E 위치 + OPM 추세 + 잔고) — 데이터 있는 기업 + major tier 전부
        _valid = set(SHIPBUILDER_STOCKS.keys())
        _major_keys = {k for k, v in SHIPBUILDER_STOCKS.items() if v.get("tier") == "major"}
        _data_keys = set(val_ctx.keys()) | set(fin_trends.keys())
        for key in sorted((_data_keys & _valid) | _major_keys):
            vc = val_ctx.get(key, {})
            ft = fin_trends.get(key, {})
            name = vc.get("name") or ft.get("name") or SHIPBUILDER_STOCKS.get(key, {}).get("name", key)
            parts: list[str] = [f"**{name}**:"]
            # P/E 위치
            pe = vc.get("pe_ttm")
            hist = HISTORICAL_PE_RANGES.get(key, {})
            if pe is not None and hist.get("avg"):
                prem_pct = (pe / hist["avg"] - 1) * 100
                pe_label = "고평가" if prem_pct > 50 else ("적정" if prem_pct > -20 else "저평가")
                parts.append(f"P/E {pe:.0f}x (20Y평균 {hist['avg']:.0f}x → {pe_label}).")
            elif pe is not None:
                parts.append(f"P/E {pe:.0f}x.")
            # OPM 추세
            opm = ft.get("op_margin")
            opm_qoq = ft.get("op_margin_qoq")
            if opm is not None:
                opm_dir = "↑" if (opm_qoq or 0) > 0 else ("↓" if (opm_qoq or 0) < 0 else "→")
                parts.append(f"OPM {opm:.1f}% QoQ {opm_dir}.")
            # 잔고 추세
            ca = ft.get("contract_assets")
            ca_j = ft.get("ca_judgment")
            if ca and ca_j:
                parts.append(f"잔고 {ca / 1e12:.1f}조 ({ca_j}).")
            elif ca_j:
                parts.append(f"잔고: {ca_j}.")
            L.append(" ".join(parts))
            # 종합 판정문
            judgment_parts: list[str] = []
            if opm is not None and opm > 7 and (opm_qoq or 0) > 0:
                judgment_parts.append("고가 수주 인도 단계, 레버리지 작동 중")
            elif opm is not None and opm > 5 and (opm_qoq or 0) >= 0:
                judgment_parts.append("수익성 안정 구간, 점진적 개선")
            elif opm is not None and (opm_qoq or 0) < -1:
                judgment_parts.append("마진 축소 추세, 경계 필요")
            elif opm is not None:
                judgment_parts.append("실적 턴어라운드 초기")
            if pe is not None and hist.get("avg") and pe > hist["avg"] * 1.5:
                judgment_parts.append("밸류에이션 부담")
            elif pe is not None and hist.get("avg") and pe < hist["avg"]:
                judgment_parts.append("밸류에이션 매력")
            if judgment_parts:
                L.append(f" → {'. '.join(judgment_parts)}")
            # 대형사 프로필
            profile = MAJOR_PROFILES.get(key)
            if profile:
                L.append(f"· 주력: {', '.join(profile['focus_vessels'][:3])} | 발주처: {profile['key_clients']}")
                L.append(f"· 강점: {profile['competitive_edge']}")
            # Segment 분리 주석
            if ft and ft.get("segment_adjusted"):
                seg_pct = round(ft["segment_ratio"] * 100)
                L.append(f"⚠ 매출·영업이익은 {ft['segment_name']} 부문({seg_pct}%) 근사치. 연결 재무제표에서 비율 적용.")
        L.append("")

        # 중소형사 수주현황
        mid_stocks = {k: v for k, v in SHIPBUILDER_STOCKS.items() if v.get("tier") == "mid"}
        if mid_stocks:
            L.append("### 중소형사 수주현황\n")
            for mk, mp in MIDSIZE_PROFILES.items():
                L.append(f"**{mp['name']}** ({mp['yards']})")
                L.append(f"· 주력 선종: {', '.join(mp['focus_vessels'])}")
                L.append(f"· 주요 발주처: {mp['key_clients']}")
                L.append(f"· 현황: {mp['backlog_summary']}")
                L.append(f"· 방산: {mp['defense']}")
                if mp.get("financials_note"):
                    L.append(f"· 참고: {mp['financials_note']}")
                L.append("")
            L.append("· (참고) 케이조선: 2014 상장폐지, 비상장 사기업. 공개 데이터 제한으로 모니터링 대상 외\n")

        # 내재 피크 연수 + 밸류에이션 판정 (SHIPBUILDER_STOCKS만)
        _vk = set(SHIPBUILDER_STOCKS.keys())
        all_keys_set = sorted(set(list(val_ctx.keys()) + list(fin_trends.keys())) & _vk)
        pe_vals = [val_ctx.get(k, {}).get("pe_ttm") for k in all_keys_set]
        pe_valid = [v for v in pe_vals if v is not None]
        peak_years = [vc["implied_peak_years"] for k, vc in val_ctx.items() if k in _vk and vc.get("implied_peak_years") is not None]
        if peak_years:
            avg_py = sum(peak_years) / len(peak_years)
            L.append(f"내재 피크 연수 평균 {avg_py:.1f}년")
            L.append(f" → 시장은 피크 실적 ~{avg_py:.0f}년 지속을 가격에 반영하고 있다.")
        if pe_valid:
            avg_pe = sum(pe_valid) / len(pe_valid)
            avg_hist = sum(HISTORICAL_PE_RANGES.get(k, {}).get("avg", 13) for k in val_ctx) / max(len(val_ctx), 1)
            if avg_pe > avg_hist * 1.5:
                L.append(f" → 고평가 구간(평균의 1.5배↑). 실적 둔화 시 주가 민감도 높음.")
            elif avg_pe < avg_hist:
                L.append(f" → 저평가 구간. 시장이 사이클 회의론을 반영 중.")
            else:
                L.append(f" → 적정 밸류에이션 구간. 실적 개선에 따라 재평가 가능.")
        L.append("")

        # 실적 레버리지 판정
        opm_vals = [fin_trends.get(k, {}).get("op_margin") for k in all_keys_set]
        opm_valid = [v for v in opm_vals if v is not None]
        margin_qoqs = [fin_trends.get(k, {}).get("op_margin_qoq") for k in all_keys_set
                       if fin_trends.get(k, {}).get("op_margin_qoq") is not None]
        if margin_qoqs:
            avg_mqoq = sum(margin_qoqs) / len(margin_qoqs)
            improving = sum(1 for m in margin_qoqs if m > 0)
            L.append(f"**실적 동향**: OPM QoQ {avg_mqoq:+.1f}%p ({improving}/{len(margin_qoqs)}사 개선)")
            if avg_mqoq > 1.0:
                L.append(" → 고가 수주 인도 단계 진입. 영업레버리지(고정비 대비 매출 증가로 이익 확대) 작동 중.")
            elif avg_mqoq < -1.0:
                L.append(" → 마진 축소 추세. 저가 수주 잔고 소진 또는 원가 상승. 피크아웃 경계 필요.")
            else:
                L.append(" → 마진 안정 구간. 수주잔고 소화에 따른 점진적 개선 중.")

        # 계약자산 파이프라인 판정
        ca_qoqs = [fin_trends.get(k, {}).get("contract_assets_qoq") for k in all_keys_set
                   if fin_trends.get(k, {}).get("contract_assets_qoq") is not None]
        if ca_qoqs:
            avg_caq = sum(ca_qoqs) / len(ca_qoqs)
            L.append(f"**수주잔고 동향**: 계약자산 평균 QoQ {avg_caq:+.1f}%")
            if avg_caq < -5:
                L.append(" → 잔고 빠르게 감소. 인도 속도 > 신규 수주 유입. 파이프라인 약화 경계.")
            elif avg_caq > 0:
                L.append(" → 잔고 증가세 유지. 신규 수주 유입이 매출 인식을 상회. 파이프라인 건재.")
            else:
                L.append(" → 잔고 소폭 감소. 수주 유입과 매출 인식이 균형 수준.")
        L.append("")

        # 종합 해설
        if pe_valid or opm_valid:
            parts_sum: list[str] = ["**종합**:"]
            if pe_valid:
                avg_pe_s = sum(pe_valid) / len(pe_valid)
                pe_label = "고평가" if avg_pe_s > 20 else ("적정" if avg_pe_s > 10 else "저평가")
                parts_sum.append(f"{len(pe_valid)}사 평균 P/E {avg_pe_s:.0f}x(역사 평균 대비 {pe_label}).")
            if opm_valid:
                avg_opm = sum(opm_valid) / len(opm_valid)
                opm_label = "개선" if avg_opm > 7 else ("회복 초기" if avg_opm > 3 else "부진")
                parts_sum.append(f"평균 영업이익률 {avg_opm:.1f}%({opm_label} 추세).")
            L.append(" ".join(parts_sum) + "\n")

        # 차트 해설
        L.append("> **기업 종합 대시보드**: 좌상=P/E(현재 vs 20년 평균), "
                 "우상=영업이익률 12분기 추이(회색 밴드=장기 평균 5-7%), "
                 "좌하=계약자산 QoQ 변화율, 우하=5축 레이더(축 균형 확인).")
        L.append("> **밸류에이션 비교**: 파란 바=P/E(좌축), 주황 바=P/B(우축). "
                 "점선이 업종 평균 P/E. 평균 위는 성장 프리미엄 또는 과열.")
        L.append("> **영업이익률 추이**: 12분기 기업별 OPM. 회색 밴드(5-7%)가 "
                 "업종 장기 평균이며, 밴드 위 진입 시 실적 사이클 본격화.")
        L.append("> **계약자산 추이**: 12분기 기업별 수주잔고(조 원). "
                 "우상향이면 수주 유입 > 매출 인식, 향후 실적 가시성 높음. "
                 "감소 전환 시 수주 모멘텀 약화 신호.\n")

    # ══════════════════════════════════════════════════════════════
    # 3. 수주 & 선종
    # ══════════════════════════════════════════════════════════════
    if dart_data and dart_data.get("estimates", {}).get("by_type"):
        est = dart_data["estimates"]
        L.append("## 3. 수주 & 선종\n")
        L.append("DART(전자공시) 기준 최근 90일 수주 계약을 분석한다. "
                 "선종 믹스는 사이클 단계 판단의 핵심 지표다.\n"
                 "- 1기(Pre-Supercycle): LNG·컨테이너가 주도\n"
                 "- 2기(Real Supercycle): 탱커·벌커의 CO₂규제 교체 수요가 본격화\n"
                 "- 2기 비중이 1기를 역전하면 슈퍼사이클 본격 진입으로 판단한다.\n")
        L.append(f"90일 신규 {est.get('total_orders', 0)}건 / {est.get('total_ships', 0)}척")
        if est.get("avg_price_per_ship_usd"):
            L.append(f"평균 선가 ${est['avg_price_per_ship_usd']:,.0f}\n")

        L.extend(["| 선종 | 척수 | 금액 | 평균선가 | 비고 |",
                   "|------|------|------|---------|------|"])
        for stype, info in sorted(est["by_type"].items(), key=lambda x: -x[1]["count"]):
            cnt = info["count"]
            amt = info.get("amount_usd", 0)
            amt_str = f"${amt / 1e9:.1f}B" if amt >= 1e9 else f"${amt / 1e6:.0f}M" if amt >= 1e6 else "-"
            avg_str = f"${amt / cnt / 1e6:.0f}M" if cnt > 0 and amt > 0 else "-"
            # 미분류 항목에 원본 공시명 표시
            note = ""
            if stype == "미분류" and info.get("report_names"):
                unique_names = list(dict.fromkeys(info["report_names"]))[:3]
                note = ", ".join(unique_names)
            L.append(f"| {stype} | {cnt}척 | {amt_str} | {avg_str} | {note} |")

        # 기업별 수주 요약 테이블 (SHIPBUILDER_STOCKS만)
        _vk_names = set(SHIPBUILDER_STOCKS.keys())
        if dart_data.get("orders"):
            L.append("\n**기업별 수주**:\n")
            co_stats: dict[str, dict[str, Any]] = {}
            for order in dart_data["orders"]:
                if order.get("key") and order["key"] not in _vk_names:
                    continue
                comp = order.get("company", "기타")
                if comp not in co_stats:
                    co_stats[comp] = {"count": 0, "ships": 0, "amount": 0, "types": {}}
                co_stats[comp]["count"] += 1
                co_stats[comp]["ships"] += order.get("ship_count", 1)
                co_stats[comp]["amount"] += order.get("amount_usd", 0) or 0
                st = order.get("ship_type", "기타")
                co_stats[comp]["types"][st] = co_stats[comp]["types"].get(st, 0) + 1
            L.extend(["| 기업 | 건수 | 척수 | 금액 | 주력 선종 |",
                       "|------|------|------|------|----------|"])
            for comp, st in sorted(co_stats.items(), key=lambda x: -x[1]["ships"]):
                amt = st["amount"]
                amt_str = f"${amt / 1e9:.1f}B" if amt >= 1e9 else f"${amt / 1e6:.0f}M" if amt >= 1e6 else "-"
                top_type = max(st["types"], key=st["types"].get) if st["types"] else "-"
                top_pct = st["types"].get(top_type, 0) / max(st["ships"], 1) * 100
                L.append(f"| {comp} | {st['count']}건 | {st['ships']}척 | {amt_str} | {top_type} {top_pct:.0f}% |")

        # 이전 기간 비교
        order_hist = _load_order_history()
        if len(order_hist) >= 2:
            prev_oh = order_hist[-2]  # 직전 기록
            cur_orders = est.get("total_orders", 0)
            cur_ships = est.get("total_ships", 0)
            cur_avg = est.get("avg_price_per_ship_usd", 0)
            prev_orders = prev_oh.get("total_orders", 0)
            prev_ships = prev_oh.get("total_ships", 0)
            prev_avg = prev_oh.get("avg_price_usd", 0)
            L.append(f"\n**이전 기간 비교** (vs {prev_oh.get('week_tag', '-')}):\n")
            L.extend(["| 항목 | 최근 | 이전 | 변동 |",
                       "|------|------|------|------|"])
            L.append(f"| 건수 | {cur_orders}건 | {prev_orders}건 | {cur_orders - prev_orders:+d}건 |")
            L.append(f"| 척수 | {cur_ships}척 | {prev_ships}척 | {cur_ships - prev_ships:+d}척 |")
            if cur_avg and prev_avg:
                d_avg = cur_avg - prev_avg
                L.append(f"| 평균선가 | ${cur_avg / 1e6:.0f}M | ${prev_avg / 1e6:.0f}M | ${d_avg / 1e6:+.0f}M |")

        # 선가 추이
        price_hist = _load_price_history()
        if len(price_hist) >= 2:
            L.append("\n### 선가 추이\n")
            L.extend(["| 시점 | 평균선가 | 건수 | 척수 |",
                       "|------|----------|------|------|"])
            for ph in price_hist[-8:]:
                avg_p = ph.get("avg_price_usd", 0)
                L.append(f"| {ph.get('date', '-')} | ${avg_p / 1e6:.0f}M | {ph.get('total_orders', 0)}건 | {ph.get('total_ships', 0)}척 |")
            if len(price_hist) >= 4:
                latest = price_hist[-1].get("avg_price_usd", 0)
                oldest = price_hist[-min(len(price_hist), 8)].get("avg_price_usd", 0)
                if latest and oldest:
                    chg_pct = (latest / oldest - 1) * 100
                    if chg_pct > 5:
                        L.append(f"\n → 선가 상승 추세 ({chg_pct:+.1f}%). 조선소 교섭력 강화.")
                    elif chg_pct < -5:
                        L.append(f"\n → 선가 하락 추세 ({chg_pct:+.1f}%). 수요 둔화 가능성.")
                    else:
                        L.append(f"\n → 선가 보합 ({chg_pct:+.1f}%). 추세 판단 보류.")
        elif len(price_hist) == 1:
            L.append("\n> 선가 시계열: 수집 시마다 누적. 4주+ 데이터 축적 후 추세 판정 시작.")

        # 선종 믹스 판정
        if vessel_mix and vessel_mix.get("total_ships", 0) > 0:
            p1r = vessel_mix.get("phase1_ratio", 0)
            p2r = vessel_mix.get("phase2_ratio", 0)
            signal = vessel_mix.get("phase_signal")
            L.append(f"\n1기(LNG/컨테이너) {p1r:.0%} / 2기(탱커/벌커) {p2r:.0%}.")
            if signal == "REAL_TRANSITION":
                L.append("⚡ 2기 선종이 1기를 추월 — **Real Supercycle 전환 시그널**.")
                L.append(" → 2기 전환! 탱커·벌커 발주가 LNG 초과. "
                         "역사적으로 이 시점에서 선가 2차 상승파가 시작된다.")
            elif signal == "TRANSITION_EMERGING":
                L.append("2기 비중 증가 중. 전환 초기 징후.")
                L.append(" → 전환 초기 징후. 2기 비중 증가 중이나 역전 전. "
                         "1-2분기 추이 관찰 필요.")
            else:
                L.append("Pre-Supercycle 단계 유지.")
                L.append(" → 1기 유지. LNG·컨 중심 지속. "
                         "탱커·벌커 교체 수요는 아직 잠재 상태.")

        # 선종별 수요 동인 — 전체 드라이버 표시 (인명 strip)
        _PERSON_RE = re.compile(r"\s*\([^)]*(?:최광식|승도리|김봉수)[^)]*\)")
        top_types = sorted(est["by_type"].items(), key=lambda x: -x[1]["count"])[:4]
        driver_lines: list[str] = []
        for stype, _ in top_types:
            vd = VESSEL_DRIVERS.get(stype)
            if vd:
                driver_lines.append(f"\n**{stype}** ({vd['cycle_stage']}):")
                for d in vd["drivers"]:
                    driver_lines.append(f"  - {_PERSON_RE.sub('', d)}")
        if driver_lines:
            L.append("\n**선종별 수요 동인**:")
            L.extend(driver_lines)

        # 탱커/VLCC 업종 분석
        L.append("\n### 탱커/VLCC 업종 분석\n")
        L.append("> 탱커는 2기 Real Supercycle의 핵심 선종. "
                 "운임 상승은 사이클이 아닌 구조적 국면.\n")
        fleet_age = TANKER_MARKET_SNAPSHOT["fleet_age"]
        L.extend([
            "| 항목 | 수치 |",
            "|------|------|",
            f"| VLCC 일용대선료 | ${TANKER_MARKET_SNAPSHOT['vlcc_dayrate_usd']}/일 |",
            f"| 수에즈맥스 일용대선료 | ${TANKER_MARKET_SNAPSHOT['suezmax_dayrate_usd']}/일 |",
            f"| VLCC 신조선가 | {TANKER_MARKET_SNAPSHOT['newbuild_vlcc_usd_m']} |",
            f"| 오더북/함대비 | {TANKER_MARKET_SNAPSHOT['orderbook_to_fleet']} |",
            f"| 선령 16-20년 | {fleet_age['16_20y_pct']}% |",
            f"| 선령 20년+ | {fleet_age['20y_plus_pct']}% |",
            f"| 2026년 25년 도래 | {fleet_age['25y_hitting_2026']} |",
        ])
        L.append(f"\n{TANKER_MARKET_SNAPSHOT['structural_view']}")
        L.append("\n → 탱커 교체 수요는 구조적. 오더북 저점 + 고선령 → 신조 압력 지속.\n")

        # 선종 믹스 변화 추이 (4주+ 데이터 시)
        mix_history = _load_vessel_mix_history()
        if len(mix_history) >= 4:
            L.append("### 선종 믹스 변화 추이\n")
            L.extend(["| 주차 | 1기(LNG/컨) | 2기(탱커/벌커) | 총 척수 |",
                       "|------|-------------|---------------|---------|"])
            for mh in mix_history[-8:]:
                p1 = mh.get("phase1_ratio")
                p2 = mh.get("phase2_ratio")
                p1_str = f"{p1:.0%}" if p1 is not None else "-"
                p2_str = f"{p2:.0%}" if p2 is not None else "-"
                L.append(f"| {mh.get('week_tag', '-')} | {p1_str} | {p2_str} | {mh.get('total_ships', '-')} |")
            if len(mix_history) >= 2:
                latest_p2 = mix_history[-1].get("phase2_ratio", 0) or 0
                oldest_p2 = mix_history[-min(len(mix_history), 8)].get("phase2_ratio", 0) or 0
                if latest_p2 > oldest_p2 + 0.05:
                    L.append("\n → 2기 비중 상승 추세. Real Supercycle 전환 가속.")
                elif latest_p2 < oldest_p2 - 0.05:
                    L.append("\n → 2기 비중 하락. 1기(LNG/컨) 주도 유지.")
                else:
                    L.append("\n → 선종 믹스 안정. 추세 전환 미감지.")
            L.append("")

        # 차트 해설
        L.append("\n> **선종 믹스 차트**: 기업별 가로 스택바. 1기 선종(LNG/컨테이너) 비중이 "
                 "높으면 Pre-Supercycle, 2기(탱커/벌커) 비중이 역전하면 Real Supercycle 진입.")
        L.append("> **인도 스케줄**: 기업별 연도별 인도 예정 척수. 리드타임이 길수록 "
                 "조선소 부담 증가. 특정 연도 집중 시 슬롯 공백 리스크.\n")

    # ══════════════════════════════════════════════════════════════
    # 4. 수요 환경
    # ══════════════════════════════════════════════════════════════
    demand_keys = [k for k in MARKET_PULSE_WEIGHTS if k in indicators]
    if demand_keys:
        L.append("\n## 4. 수요 환경\n")
        L.append("조선 수요는 해운 운임·유가·원자재에 의해 결정된다. "
                 "운임이 높으면 선주가 이익을 내어 새 배를 주문한다.\n"
                 "z-score: 현재값이 과거 평균 대비 몇 표준편차 떨어져 있는지. "
                 "+1.5 이상 = 강한 강세, -1.5 이하 = 강한 약세. "
                 "각 지표는 특정 선종과 연결된다.\n")
        L.extend(_build_demand_table(indicators))

        # 운임 프록시 지표
        freight_keys = [k for k in ["container_proxy", "tanker_proxy", "tanker_proxy2"] if k in indicators]
        if freight_keys:
            L.append("\n**운임 프록시**:")
            for fk in freight_keys:
                ind = indicators[fk]
                z = ind.get("zscore", 0)
                L.append(f"- {ind['name']}: {ind['close']:,.2f} (z {z:+.2f})")

        # z-score 해석
        DEMAND_VESSEL_MAP_LOCAL = {
            "bdi": "벌크", "wti": "FPSO/탱커", "brent": "탱커", "natgas": "LNG",
            "steel": "전선종", "krw": "전선종",
        }
        interpretations: list[str] = []
        z_values: list[float] = []
        for key in MARKET_PULSE_WEIGHTS:
            ind = indicators.get(key)
            if not ind:
                continue
            z = ind.get("zscore", 0)
            z_values.append(z)
            name = ind.get("name", key)
            vessel = DEMAND_VESSEL_MAP_LOCAL.get(key, "")
            if abs(z) >= 1.5:
                direction = "강세" if z > 0 else "약세"
                impact = "긍정적" if z > 0 else "부정적"
                interpretations.append(f"- **{name}** z={z:+.1f}: {direction} 신호. "
                                       f"{vessel} 신조 수요에 {impact}.")
            elif abs(z) >= 1.0:
                direction = "상승" if z > 0 else "하락"
                interpretations.append(f"- {name} z={z:+.1f}: 평년 대비 {direction}세.")
        if interpretations:
            L.append("\n**해석**:")
            L.extend(interpretations)
        if z_values:
            avg_z = sum(z_values) / len(z_values)
            if avg_z > 0.5:
                env_label = "전반적 강세 — 신조 수요 호조"
                env_insight = " → 전반적 강세. 다수 선종에서 신조 수요 호조."
            elif avg_z < -0.5:
                env_label = "전반적 약세 — 신조 수요 둔화 우려"
                env_insight = " → 전반적 약세. 발주 이연 가능. 신규 수주 둔화 리스크."
            else:
                env_label = "혼조세 — 선종별 차별화 예상"
                env_insight = " → 선종별 차별화. 강세 선종 중심 조선소 수혜."
            L.append(f"\n수요 환경 종합: 평균 z-score {avg_z:+.1f}. {env_label}")
            L.append(env_insight)

        # 수동 평가 지표 요약
        manual_d = load_manual_indicators()
        ms_d = manual_d.get("scores", {})
        manual_parts: list[str] = []
        for k, m in MANUAL_INDICATORS.items():
            v = ms_d.get(k)
            if v is not None:
                manual_parts.append(f"{m['name']} {v:.0f}/10")
        if manual_parts:
            L.append(f"\n**수동 지표**: {' / '.join(manual_parts)}")
            # stale 경고
            _updated = manual_d.get("updated_at")
            if _updated:
                try:
                    _last = datetime.fromisoformat(_updated)
                    if _last.tzinfo is None:
                        _last = _last.replace(tzinfo=KST)
                    _days = (datetime.now(KST) - _last).days
                    if _days >= 90:
                        L.append(f"⚠️ 수동 지표 {_days}일 미갱신 — `--manual-update`로 업데이트 필요")
                except (ValueError, TypeError):
                    pass
            # 수동 지표 해설
            MANUAL_EXPLANATIONS = {
                "regulation": ("IMO 규제(EEXI 기존선 에너지효율/CII 탄소집약도/ETS 배출권거래). "
                               "3중 규제가 노후선 퇴출을 가속. 저탄소 엔진 전환율 전체 15%"),
                "china_capacity": ("중국 캐파 급속 증설 시 선가 하방 압력. "
                                    "현재 LNG/VLCC 기술(NO96 멤브레인) 미비로 고부가 위협 제한적"),
                "vessel_age": ("탱커/벌커 선령 15년↑ 51%, 20년↑ 22%. "
                                "노후선 교체 압력이 누적되어 슈퍼사이클 2기의 핵심 동인"),
                "container_rate": "컨테이너 운임 상승 → 선주 이익 → 친환경 신조 주문 의향 증가",
                "tanker_rate": "탱커 운임 상승 → 구조적 국면(CII 규제·톤마일·선령) → 탱커 신조 가속",
            }
            manual_desc_lines: list[str] = []
            for k, m in MANUAL_INDICATORS.items():
                v = ms_d.get(k)
                if v is not None:
                    expl = MANUAL_EXPLANATIONS.get(k, "")
                    if expl:
                        manual_desc_lines.append(f"- {m['name']} {v:.0f}/10: {expl}")
            if manual_desc_lines:
                L.extend(manual_desc_lines)

        # 차트 해설
        L.append("\n> **Z-Score 차트**: 수요 지표별 z-score 가로 막대. "
                 "초록=양(강세), 빨강=음(약세). |z|≥1.5이면 강한 신호, "
                 "|z|≥1.0이면 주의 수준. 전체 방향이 일치하면 신조 수요 전반적 확대/위축.\n")
        L.append("")

    # ══════════════════════════════════════════════════════════════
    # 5. 피크아웃
    # ══════════════════════════════════════════════════════════════
    PEAKOUT_DESCRIPTIONS: dict[str, str] = {
        "margin_qoq": "OPM QoQ < -1%p: 영업이익률 분기 하락 시작. 고가 수주 잔고 소진의 신호",
        "contract_asset_qoq": "계약자산 QoQ < -5%: 인도 속도 > 신규 수주 유입. 파이프라인 축소",
        "order_count_90d": "90일 수주 < 10건: 발주 동결 수준. 선주 관망세",
        "avg_price_qoq": "평균선가 QoQ < -10%: 선가 사이클 하강 전환 (선가는 수주잔고의 후행지표)",
        "lead_time_years": "리드타임 > 4년: 공급 병목. 역설적으로 선가 하방 경직성 제공",
        "pe_vs_avg": "P/E > 20Y평균 100% 초과: 밸류에이션 부담. 실적 기대 과도 반영",
    }
    if peakout:
        L.append("## 5. 피크아웃 모니터링\n")
        L.append("피크아웃은 업사이클 정점 이후 하강 전환을 사전 감지하는 체계다. "
                 "6개 지표를 3축으로 감시한다:\n"
                 "- 실적 축(OPM·계약자산): 현재 수익성 변화. 분기 재무제표 기반\n"
                 "- 수주 축(건수·선가): 미래 파이프라인 변화. DART 공시 기반\n"
                 "- 구조 축(리드타임·밸류에이션): 시장 구조적 과열. 시장가격 기반\n"
                 "단일 지표 이탈은 노이즈일 수 있으나, 3개 이상 동시 경고 시 사이클 전환을 경계해야 한다.\n")
        L.append("**[측정방법]** 각 지표에 임계치(threshold)를 설정, 이탈 시 경고(warning) 발동.\n")
        L.append("| 지표 | 측정 데이터 | 임계치 | 방향 | 의미 |")
        L.append("|------|-----------|--------|------|------|")
        L.append("| OPM QoQ | DART 분기 재무제표 영업이익률 전분기 대비 | < -1.0%p | 하락 시 경고 | 수익성 꺾임 시작 |")
        L.append("| 계약자산 QoQ | DART 재무상태표 계약자산 전분기 대비 | < -5.0% | 하락 시 경고 | 잔고 소진 > 신규유입 |")
        L.append("| 수주건수 90일 | DART 수주공시 최근 90일 집계 | < 10건 | 미달 시 경고 | 발주 동결 수준 |")
        L.append("| 평균선가 QoQ | DART 공시 평균 선가 전분기 대비 | < -10.0% | 하락 시 경고 | 선가 하강 전환 |")
        L.append("| 리드타임 | 수주잔고 / 연간 건조능력 | > 4.0년 | 초과 시 경고 | 캐파 병목 극대화 |")
        L.append("| P/E vs 20Y | yfinance TTM PE / 20년 평균 PE - 1 | > +100% | 초과 시 경고 | 밸류에이션 과열 |")
        L.append("")
        L.extend(_build_peakout_table(peakout))
        warning_count = sum(1 for p in peakout if p["status"] == "warning")
        if warning_count >= 3:
            L.append(f"\n경고 {warning_count}개.")
            L.append(" → 사이클 하강 전환 가능성 높음. 포지션 축소 또는 헤지 검토.")
        elif warning_count >= 2:
            L.append(f"\n경고 {warning_count}개.")
            L.append(" → 피크아웃 주의. 1-2분기 추적. 축이 다른 경고는 독립 이벤트일 수 있음.")
        elif warning_count == 1:
            L.append("\n경고 1개.")
            L.append(" → 단일 지표 이탈. 구조적 전환 판단은 이름. 근본 원인 파악 우선.")
        else:
            L.append("\n전 지표 정상.")
            L.append(" → 전 지표 정상. 업사이클 지속 중. 수주 축 선행지표 변화에 주의.")

        # 경고 지표 해설
        warning_descs: list[str] = []
        for p in peakout:
            if p["status"] == "warning":
                key = p.get("key", "")
                desc = PEAKOUT_DESCRIPTIONS.get(key, "")
                if desc:
                    warning_descs.append(f"- **{p['desc']}**: {desc}")
        if warning_descs:
            L.append("")
            L.extend(warning_descs)

        # 차트 해설
        L.append("\n> **피크아웃 차트**: 히스토리 2주 이상 시 시계열 라인(임계치 점선 포함), "
                 "이전에는 수평 게이지로 표시. 초록=정상, 빨강=경고(임계치 이탈). "
                 "복수 지표가 동시에 빨간 구간 진입 시 하강 전환 가능성 높음.")

    # ══════════════════════════════════════════════════════════════
    # 피크아웃 3대 축 상세 (승도리 #959)
    # ══════════════════════════════════════════════════════════════
    if peakout:
        L.append("\n### 피크아웃 3대 축 (상세)\n")
        for axis_key, fw in PEAKOUT_FRAMEWORK.items():
            L.append(f"**{fw['title']}**: {fw['description']}")
            L.append(f"· 핵심 변수: {fw['key_variable']}")
            if fw.get("positive"):
                L.append(f"· 긍정 요인: {fw['positive']}")
            if fw.get("risk"):
                L.append(f"· 최대 리스크: {fw['risk']}")
            if fw.get("leading_indicator"):
                L.append(f"· 선행지표: {fw['leading_indicator']}")
            L.append("")
        L.append(f"> 출처: 승도리 #959 (t.me/deferred_gratification/959)")

    # ── 참고: 조선주 ──
    stock_keys = [k for k, v in TIER1_INDICATORS.items() if v["category"] == "stock" and k in indicators]
    if stock_keys:
        stocks_line = " / ".join(f"{indicators[k]['name']} {indicators[k]['close']:,.0f}({_pct_str(indicators[k]['change_pct'])}%)"
                                 for k in stock_keys)
        L.append(f"\n---\n참고: {stocks_line}")

    # ══════════════════════════════════════════════════════════════
    # 6. 경쟁국 분석 (독립 섹션)
    # ══════════════════════════════════════════════════════════════
    L.append("\n## 6. 경쟁국 분석\n")
    L.append("> 글로벌 조선은 한국·중국·일본이 90%↑ 점유. "
             "경쟁국 동향은 한국 수주 환경과 선가에 직접 영향한다.\n")
    for ckey, cdata in COMPETITOR_DATA.items():
        L.append(f"### {cdata['name']} (글로벌 점유 {cdata['global_share']})")
        L.append(f"**주요 야드**: {', '.join(cdata['major_yards'])}")
        L.append(f"**주력 선종**: {cdata['focus_vessels']}\n")
        L.extend([
            "| 구분 | 내용 |",
            "|------|------|",
        ])
        strengths = cdata.get("strengths", [])
        weaknesses = cdata.get("weaknesses", [])
        if strengths:
            L.append(f"| 강점 | {', '.join(strengths)} |")
        if weaknesses:
            L.append(f"| 약점 | {', '.join(weaknesses)} |")
        ki = cdata.get("korea_impact", "")
        if ki:
            L.append(f"| 한국 영향 | {ki} |")
        ws = cdata.get("watch_signal", "")
        if ws:
            L.append(f"| 감시 신호 | {ws} |")
        L.append("")
        L.append(f"→ **판정**: {cdata['key_risk']}\n")

        # 야드별 상세 프로필
        yards = cdata.get("yards_detail", [])
        if yards:
            L.append(f"**주요 야드 프로필**:")
            for yd in yards:
                L.append(f"· **{yd['name']}**: {yd['focus']}. {yd['strategy']}")
            cap = cdata.get("capacity_trend", "")
            if cap:
                L.append(f"\n**캐파 전략**: {cap}")
            margin = cdata.get("margin_strategy", "")
            if margin:
                L.append(f"**마진 전략**: {margin}")
            L.append("")

    # ══════════════════════════════════════════════════════════════
    # 7. 출처
    # ══════════════════════════════════════════════════════════════
    L.extend([
        "\n## 7. 출처\n",
        "### 참고 방법론",
        "- 3단계 슈퍼사이클 프레임워크 (김봉수 교수, KAIST)",
        "- 피크아웃 3축 분석 (승도리)",
        "- 수주잔고 기반 이익 사이클 판별, 이중 촉매 프레임워크\n",
    ])

    # 최광식 9개 방법론
    for analyst, info in ANALYST_METHODOLOGIES.items():
        methods = info.get("methodologies", [])
        if methods:
            L.append(f"### 주요 분석 방법론 ({analyst}, {info['firm']})")
            L.extend(["| # | 방법론 | 핵심 |", "|---|--------|------|"])
            for i, m in enumerate(methods, 1):
                parts = m.split(" — ", 1)
                mname = parts[0]
                mdesc = parts[1] if len(parts) > 1 else ""
                L.append(f"| {i} | {mname} | {mdesc} |")
            L.append(f"\n> {info.get('note', '')}\n")

    L.extend([
        "### 데이터",
        "- DART OpenAPI: 수주공시, 재무제표 (dart.fss.or.kr)",
        "- yfinance: 시장지표 17종",
        "- 수동 평가: IMO 규제, 중국 캐파, 노후선, 운임\n",
        "### 참고 자료",
    ])
    for key, src in REPORT_SOURCES.items():
        L.append(f"- [{src['title']}]({src['url']})")

    L.append(f"\n*Generated by shipbuilding_cycle_tracker.py v6.2*")
    return "\n".join(L)


def _add_comparison_row(lines: list[str], label: str,
                        current: float | None, previous: float | None,
                        suffix: str = "") -> None:
    """전월 비교 테이블 행 추가 헬퍼."""
    cur_str = f"{current:.1f}{suffix}" if current is not None else "-"
    prev_str = f"{previous:.1f}{suffix}" if previous is not None else "-"
    if current is not None and previous is not None:
        delta = current - previous
        delta_str = f"{delta:+.1f}{suffix}"
    else:
        delta_str = "-"
    lines.append(f"| {label} | {cur_str} | {prev_str} | {delta_str} |")


def format_telegram_dm(pulse: dict, combined: dict, signals: list,
                       indicators: dict, dart_data: dict | None,
                       fin_trends: dict | None = None, val_ctx: dict | None = None,
                       backlog: dict | None = None, peakout: list | None = None,
                       vessel_mix: dict | None = None,
                       prev_data: dict | None = None,
                       cycle: dict | None = None) -> str:
    """v4 Telegram — 5축 점수 + 전월 비교 ↑↓ 포함 사이클 분석."""
    now = datetime.now()
    week = now.isocalendar()[1]
    phase_score = combined.get("combined") or pulse["score"]
    phase_code, phase_desc = determine_cycle_phase(phase_score)
    fin_trends = fin_trends or {}
    val_ctx = val_ctx or {}
    peakout = peakout or []
    backlog = backlog or {}
    vessel_mix = vessel_mix or {}
    prev = prev_data or {}
    has_prev = bool(prev)

    score_str = f"{combined['combined']:.1f}" if combined.get("combined") is not None else f"{pulse['score']:.1f}"

    # 전월 비교 화살표 (임계치 2.0 — 100점 스케일에서 의미 있는 변동만)
    def _arrow(cur: float | None, prv: float | None) -> str:
        if cur is None or prv is None:
            return ""
        delta = cur - prv
        if delta > 2.0:
            return f" ↑{delta:+.1f}"
        elif delta < -2.0:
            return f" ↓{delta:+.1f}"
        return " →"

    prev_score = prev.get("combined_score")
    score_arrow = _arrow(combined.get("combined"), prev_score)

    L = [f"<b>🚢 조선 사이클 W{week} | {phase_code} {score_str}/100{score_arrow}</b>"]
    L.append(f"━━━━━━━━━━━━━━━━")
    L.append(f"({phase_desc})")
    L.append(f"Demand {combined.get('market_pulse') or 0:.0f} + Cycle {combined.get('cycle_score') or 0:.0f} (15:85 가중)")
    # 5축 점수 1줄
    axis_parts: list[str] = []
    axis_scores = (cycle or {}).get("axis_scores", {})
    for axis_key, axis_label in [("demand", "수요"), ("financial", "실적"),
                                   ("order", "수주"), ("valuation", "밸류"),
                                   ("structural", "구조")]:
        if axis_key == "demand":
            sc = pulse.get("score")
        else:
            sc = axis_scores.get(axis_key)
        axis_parts.append(f"{axis_label} {sc:.0f}" if sc is not None else f"{axis_label} -")
    L.append(" | ".join(axis_parts))
    L.append("")

    # 밸류에이션 + 해석
    L.append("─ ─ ─ ─ ─ ─ ─ ─")
    if val_ctx:
        pe_vals = [vc["pe_ttm"] for vc in val_ctx.values() if vc.get("pe_ttm")]
        if pe_vals:
            avg_pe = sum(pe_vals) / len(pe_vals)
            avg_hist = sum(HISTORICAL_PE_RANGES.get(k, {}).get("avg", 13) for k in val_ctx) / len(val_ctx)
            pe_arrow = ""
            if has_prev and prev.get("valuation"):
                prev_pes = [pv["pe_ttm"] for pv in prev["valuation"].values() if pv.get("pe_ttm")]
                if prev_pes:
                    pe_arrow = _arrow(avg_pe, sum(prev_pes) / len(prev_pes))
            L.append(f"<b>[밸류에이션]</b> P/E 평균 {avg_pe:.0f}x{pe_arrow} (20Y avg {avg_hist:.0f}x)")
            peak_years = [vc.get("implied_peak_years", 0) for vc in val_ctx.values() if vc.get("implied_peak_years") is not None]
            if peak_years:
                avg_py = sum(peak_years) / len(peak_years)
                L.append(f" → 시장은 피크 실적 ~{avg_py:.0f}년 지속 가격 반영")
            if avg_pe > avg_hist * 1.5:
                L.append(f" → 고평가 구간. 실적 둔화 시 주가 민감")
            elif avg_pe < avg_hist:
                L.append(f" → 저평가. 사이클 회의론 반영")

    # 실적 + 해석
    if fin_trends:
        margins = [ft["op_margin"] for ft in fin_trends.values() if ft.get("op_margin") is not None]
        margin_qoqs = [ft["op_margin_qoq"] for ft in fin_trends.values() if ft.get("op_margin_qoq") is not None]
        if margins:
            avg_margin = sum(margins) / len(margins)
            margin_arrow = ""
            if has_prev and prev.get("financials"):
                prev_ms = [pf.get("op_margin") for pf in prev["financials"].values() if pf.get("op_margin") is not None]
                if prev_ms:
                    margin_arrow = _arrow(avg_margin, sum(prev_ms) / len(prev_ms))
            L.append(f"\n<b>[실적]</b> 영업이익률 {avg_margin:.1f}%{margin_arrow}")
            if margin_qoqs:
                avg_mqoq = sum(margin_qoqs) / len(margin_qoqs)
                improving = sum(1 for m in margin_qoqs if m > 0)
                L.append(f" QoQ {avg_mqoq:+.1f}%p ({improving}/{len(margin_qoqs)}사 개선)")
                if avg_mqoq > 1.0:
                    L.append(f" → 고가 수주 인도 단계. 영업레버리지 작동")
                elif avg_mqoq < -1.0:
                    L.append(f" → ⚠️ 마진 축소. 피크아웃 경고")

    # 잔고 + 해석
    ca_vals = [ft["contract_assets"] for ft in fin_trends.values() if ft.get("contract_assets")]
    ca_qoqs = [ft["contract_assets_qoq"] for ft in fin_trends.values() if ft.get("contract_assets_qoq") is not None]
    if ca_vals:
        total_ca = sum(ca_vals) / 1e12
        ca_arrow = ""
        if has_prev and prev.get("financials"):
            prev_ca = [pf.get("contract_assets") for pf in prev["financials"].values() if pf.get("contract_assets")]
            if prev_ca:
                ca_arrow = _arrow(total_ca, sum(prev_ca) / 1e12)
        L.append(f"\n<b>[잔고]</b> 계약자산 {total_ca:.1f}조{ca_arrow}")
        if ca_qoqs:
            avg_caq = sum(ca_qoqs) / len(ca_qoqs)
            L.append(f" QoQ {avg_caq:+.1f}%")
            if avg_caq < -5:
                L.append(f" → ⚠️ 잔고 빠르게 감소. 인도 > 신규수주")
            elif avg_caq > 0:
                L.append(f" → 잔고 증가. 파이프라인 건재")
    if backlog.get("lead_time_avg_years"):
        L.append(f" 리드타임 {backlog['lead_time_avg_years']}년")

    # 수주 + 선종 믹스
    if dart_data and dart_data.get("estimates"):
        est = dart_data["estimates"]
        L.append(f"\n<b>[수주]</b> 90일 {est.get('total_orders', 0)}건 {est.get('total_ships', 0)}척")
        if est.get("total_amount_usd"):
            L.append(f" ${est['total_amount_usd'] / 1e9:.1f}B")
    if vessel_mix.get("total_ships", 0) > 0:
        p1r = vessel_mix.get("phase1_ratio", 0)
        p2r = vessel_mix.get("phase2_ratio", 0)
        if vessel_mix.get("phase_signal") == "REAL_TRANSITION":
            L.append(f" ⚡ 탱커·벌커({p2r:.0%}) > LNG({p1r:.0%}) — Real 전환!")
        elif p2r >= 0.30:
            L.append(f" 🔶 1기 {p1r:.0%} / 2기 {p2r:.0%} — 2기 접근 (30%↑)")
        else:
            L.append(f" 1기(LNG·컨) {p1r:.0%} / 2기(탱커) {p2r:.0%} — Pre 단계 유지")

    # 피크아웃
    warnings = [p for p in peakout if p["status"] == "warning"]
    warning_count = len(warnings)
    L.append("")
    if warning_count >= 3:
        L.append(f"⚠️ 피크아웃 {warning_count}개 경고: {', '.join(p['desc'] for p in warnings)}")
        L.append("→ 사이클 하강 전환 가능. 포지션 재점검")
    elif warning_count >= 1:
        L.append(f"⚠️ 피크아웃 {warning_count}개: {', '.join(p['desc'] for p in warnings)}")
        L.append("→ 추이 관찰 필요")
    else:
        L.append("피크아웃: 전 지표 정상 ✅")

    # 탱커 시황 1줄
    L.append(f"\n<b>[탱커]</b> VLCC ${TANKER_MARKET_SNAPSHOT['vlcc_dayrate_usd'].split(' ')[0]}/일 "
             f"| 오더북/함대 {TANKER_MARKET_SNAPSHOT['orderbook_to_fleet'].split(' ')[0]} "
             f"| 선령20y+ {TANKER_MARKET_SNAPSHOT['fleet_age']['20y_plus_pct']}%")

    # 경쟁국 요약 (대한조선은 major로 승격됨 — v6.0)
    L.append("─ ─ ─ ─ ─ ─ ─ ─")
    L.append("<b>[경쟁국]</b> 중국: 물량 독점, 고부가 미진입. 일본: 인력 부족→한국 수혜")

    return "\n".join(L)


# ══════════════════════════════════════════════════════════════════
#  Charts (matplotlib)
# ══════════════════════════════════════════════════════════════════

def _setup_chart_env():
    """matplotlib 한글 폰트 + Agg 백엔드 설정. market_indicator_tracker 패턴 재사용."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    for font in ["NanumGothic", "AppleGothic", "Apple SD Gothic Neo", "DejaVu Sans"]:
        try:
            plt.rcParams["font.family"] = font
            break
        except Exception:
            continue
    plt.rcParams["axes.unicode_minus"] = False
    return plt


def _chart_radar(combined: dict, cycle: dict | None,
                 date_str: str) -> Path | None:
    """5축 레이더 차트."""
    try:
        plt = _setup_chart_env()
        import numpy as np

        axis_labels = ["Demand", "Financial", "Order", "Valuation", "Structural"]
        scores: list[float] = []
        if cycle and cycle.get("axis_scores"):
            for ax in ["demand", "financial", "order", "valuation", "structural"]:
                s = cycle["axis_scores"].get(ax)
                scores.append(s if s is not None else 0)
        else:
            scores = [combined.get("market_pulse", 0)] + [0] * 4

        angles = np.linspace(0, 2 * np.pi, len(axis_labels), endpoint=False).tolist()
        scores_plot = scores + [scores[0]]
        angles += [angles[0]]

        fig, ax = plt.subplots(figsize=(4, 4), subplot_kw={"projection": "polar"})
        ax.fill(angles, scores_plot, alpha=0.25, color="#2196F3")
        ax.plot(angles, scores_plot, "o-", linewidth=2, color="#1565C0")
        ax.set_xticks(angles[:-1])
        ax.set_xticklabels(axis_labels, fontsize=12)
        ax.set_ylim(0, 100)
        ax.set_title(f"5축 스코어 레이더 ({date_str})", fontsize=14, pad=20)

        # 점수 라벨
        for angle, score, label in zip(angles[:-1], scores, axis_labels):
            ax.annotate(f"{score:.0f}", xy=(angle, score), fontsize=10,
                        ha="center", va="bottom", fontweight="bold")

        out = CHART_DIR / f"{date_str}_radar.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart radar error: {e}")
        return None


def _chart_valuation_bars(val_ctx: dict, date_str: str) -> Path | None:
    """밸류에이션 비교 (P/E, P/B 병렬 바 차트)."""
    try:
        plt = _setup_chart_env()
        import numpy as np

        names = [vc["name"] for vc in val_ctx.values()]
        pe_vals = [vc.get("pe_ttm") or 0 for vc in val_ctx.values()]
        pb_vals = [vc.get("pb") or 0 for vc in val_ctx.values()]

        x = np.arange(len(names))
        w = 0.35
        fig, ax1 = plt.subplots(figsize=(8, 4))
        bars1 = ax1.bar(x - w / 2, pe_vals, w, label="P/E", color="#2196F3")
        ax1.set_ylabel("P/E (x)")
        ax1.set_xticks(x)
        ax1.set_xticklabels(names, fontsize=10)

        ax2 = ax1.twinx()
        bars2 = ax2.bar(x + w / 2, pb_vals, w, label="P/B", color="#FF9800", alpha=0.8)
        ax2.set_ylabel("P/B (x)")

        # 역사적 평균선 (전체 업종 평균)
        all_hist_avgs = [HISTORICAL_PE_RANGES.get(k, {}).get("avg", 0)
                         for k in val_ctx.keys()]
        valid_hist = [h for h in all_hist_avgs if h > 0]
        if valid_hist:
            sector_avg = sum(valid_hist) / len(valid_hist)
            ax1.axhline(y=sector_avg, color="red", linestyle="--", alpha=0.6, linewidth=1.5)
            ax1.text(len(names) - 0.5, sector_avg + 1, f"20Y 업종 평균 {sector_avg:.0f}x",
                     fontsize=8, color="red", ha="right")

        # 값 라벨
        for bar in bars1:
            h = bar.get_height()
            if h > 0:
                ax1.text(bar.get_x() + bar.get_width() / 2, h, f"{h:.0f}x",
                         ha="center", va="bottom", fontsize=9)
        for bar in bars2:
            h = bar.get_height()
            if h > 0:
                ax2.text(bar.get_x() + bar.get_width() / 2, h, f"{h:.1f}x",
                         ha="center", va="bottom", fontsize=9)

        fig.legend(loc="upper right", bbox_to_anchor=(0.95, 0.95))
        ax1.set_title(f"밸류에이션 비교 ({date_str})", fontsize=13)
        fig.tight_layout()
        out = CHART_DIR / f"{date_str}_valuation.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart valuation error: {e}")
        return None


def _chart_margin_trend(financials: dict | None, date_str: str) -> Path | None:
    """영업이익률 분기별 추이 차트."""
    try:
        plt = _setup_chart_env()
        if not financials or not financials.get("companies"):
            return None

        fig, ax = plt.subplots(figsize=(8, 4))
        cos = financials["companies"]
        all_quarters: set[str] = set()
        for cd in cos.values():
            all_quarters.update(cd.get("quarters", {}).keys())
        sorted_qs = sorted(all_quarters)
        if len(sorted_qs) < 2:
            plt.close(fig)
            return None

        for ckey, cd in cos.items():
            cname = cd.get("name", ckey)
            margins: list[float | None] = []
            for q in sorted_qs:
                qd = cd.get("quarters", {}).get(q, {})
                rev = qd.get("revenue")
                op = qd.get("operating_profit")
                if rev and op and rev > 0:
                    margins.append(op / rev * 100)
                else:
                    margins.append(None)
            # 연결선: None 구간 스킵
            valid_qs = [q for q, m in zip(sorted_qs, margins) if m is not None]
            valid_ms = [m for m in margins if m is not None]
            if valid_ms:
                ax.plot(valid_qs, valid_ms, "o-", label=cname, linewidth=2, markersize=6)

        ax.axhspan(5, 7, alpha=0.1, color="gray", label="장기 평균(5~7%)")
        ax.set_ylabel("영업이익률 (%)")
        ax.set_title(f"영업이익률 추이 ({date_str})", fontsize=13)
        ax.legend(fontsize=9, loc="best")
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        out = CHART_DIR / f"{date_str}_margin_trend.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart margin trend error: {e}")
        return None


def _chart_contract_assets(fin_trends: dict, financials: dict | None,
                            date_str: str) -> Path | None:
    """계약자산 12분기 시계열 차트 (기업별 멀티라인)."""
    try:
        plt = _setup_chart_env()
        if not financials or not financials.get("companies"):
            return None

        fig, ax = plt.subplots(figsize=(8, 4))
        cos = financials["companies"]
        all_quarters: set[str] = set()
        for cd in cos.values():
            all_quarters.update(cd.get("quarters", {}).keys())
        sorted_qs = sorted(all_quarters)
        if len(sorted_qs) < 2:
            plt.close(fig)
            return None

        has_data = False
        for ckey, cd in cos.items():
            cname = cd.get("name", ckey)
            ca_vals: list[float | None] = []
            for q in sorted_qs:
                qd = cd.get("quarters", {}).get(q, {})
                ca = qd.get("contract_assets")
                ca_vals.append(ca / 1e12 if ca else None)  # 조 단위
            valid_qs = [q[-5:] for q, v in zip(sorted_qs, ca_vals) if v is not None]
            valid_vs = [v for v in ca_vals if v is not None]
            if valid_vs:
                ax.plot(valid_qs, valid_vs, "o-", label=cname, linewidth=2, markersize=5)
                has_data = True

        if not has_data:
            plt.close(fig)
            return None

        ax.set_ylabel("계약자산 (조 원)")
        ax.set_title(f"계약자산 추이 ({date_str})", fontsize=13)
        ax.legend(fontsize=9, loc="best")
        ax.grid(True, alpha=0.3)
        ax.tick_params(axis="x", labelsize=7, rotation=45)
        fig.tight_layout()
        out = CHART_DIR / f"{date_str}_contract_assets.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart contract assets error: {e}")
        return None


def _chart_vessel_mix(vessel_mix: dict, dart_data: dict | None,
                      date_str: str) -> Path | None:
    """선종 믹스 가로 스택 바 차트 (조선 4사별)."""
    try:
        plt = _setup_chart_env()
        import numpy as np
        if not dart_data or not dart_data.get("orders"):
            return None

        # 회사별 선종 집계
        company_types: dict[str, dict[str, int]] = {}
        for order in dart_data["orders"]:
            company = order.get("company", "기타")
            ship_type = order.get("ship_type", "기타")
            if company not in company_types:
                company_types[company] = {}
            company_types[company][ship_type] = company_types[company].get(ship_type, 0) + 1

        if not company_types:
            return None

        # 전체 선종 목록
        all_types = sorted(set(t for types in company_types.values() for t in types))
        companies = sorted(company_types.keys())

        # 색상 팔레트
        COLORS = ["#2196F3", "#F44336", "#4CAF50", "#FF9800", "#9C27B0",
                  "#00BCD4", "#795548", "#607D8B", "#E91E63", "#CDDC39"]
        type_colors = {t: COLORS[i % len(COLORS)] for i, t in enumerate(all_types)}

        fig, ax = plt.subplots(figsize=(7, max(2.5, len(companies) * 1.0)))
        y_pos = np.arange(len(companies))

        left = np.zeros(len(companies))
        for ship_type in all_types:
            widths = [company_types.get(c, {}).get(ship_type, 0) for c in companies]
            ax.barh(y_pos, widths, left=left, label=ship_type,
                    color=type_colors[ship_type], height=0.6)
            # 라벨 (0이 아닌 경우만)
            for i, w in enumerate(widths):
                if w > 0:
                    ax.text(left[i] + w / 2, y_pos[i], str(w),
                            ha="center", va="center", fontsize=9, fontweight="bold",
                            color="white")
            left += widths

        ax.set_yticks(y_pos)
        ax.set_yticklabels(companies, fontsize=11)
        ax.set_xlabel("척수", fontsize=11)
        p1r = vessel_mix.get("phase1_ratio", 0)
        p2r = vessel_mix.get("phase2_ratio", 0)
        ax.set_title(f"기업별 수주 선종 (최근 90일) — 1기(LNG/컨) {p1r:.0%} / 2기(탱커/벌커) {p2r:.0%}",
                     fontsize=12)
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.08),
                  ncol=min(len(all_types), 4), fontsize=8)
        ax.invert_yaxis()
        fig.tight_layout()

        out = CHART_DIR / f"{date_str}_vessel_mix.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart vessel mix error: {e}")
        return None


def _chart_demand_zscore(indicators: dict, date_str: str) -> Path | None:
    """수요지표 z-score 막대 차트."""
    try:
        plt = _setup_chart_env()
        import numpy as np

        keys_to_show = list(MARKET_PULSE_WEIGHTS.keys()) + ["container_proxy", "tanker_proxy", "tanker_proxy2"]
        items = [(indicators[k]["name"], indicators[k].get("zscore", 0))
                 for k in keys_to_show if k in indicators]
        if not items:
            return None

        names = [i[0] for i in items]
        zscores = [i[1] for i in items]
        colors = ["#4CAF50" if z >= 0 else "#F44336" for z in zscores]

        fig, ax = plt.subplots(figsize=(8, 4))
        y = np.arange(len(names))
        bars = ax.barh(y, zscores, color=colors, alpha=0.8)
        ax.set_yticks(y)
        ax.set_yticklabels(names, fontsize=10)
        ax.axvline(x=0, color="black", linewidth=0.8)
        ax.axvline(x=1.0, color="green", linewidth=0.5, linestyle="--", alpha=0.5)
        ax.axvline(x=-1.0, color="red", linewidth=0.5, linestyle="--", alpha=0.5)
        # 기준선 라벨
        ylim = ax.get_ylim()
        ax.text(1.05, ylim[1] * 0.95, "강세 기준", fontsize=7, color="green", va="top")
        ax.text(-1.05, ylim[1] * 0.95, "약세 기준", fontsize=7, color="red", va="top", ha="right")
        ax.set_xlabel("z-score", fontsize=10)
        ax.set_title(f"수요지표 Z-Score ({date_str})", fontsize=13)
        # 하단 해설
        ax.text(0.5, -0.12, "초록=강세(수요 증가), 빨강=약세(수요 감소)",
                transform=ax.transAxes, fontsize=8, ha="center", color="#666666",
                style="italic")

        for bar, z in zip(bars, zscores):
            ax.text(z + (0.05 if z >= 0 else -0.05), bar.get_y() + bar.get_height() / 2,
                    f"{z:+.2f}", ha="left" if z >= 0 else "right", va="center", fontsize=9)

        fig.tight_layout()
        out = CHART_DIR / f"{date_str}_demand_zscore.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart demand zscore error: {e}")
        return None


def _chart_delivery_schedule(backlog: dict, dart_data: dict | None,
                              date_str: str) -> Path | None:
    """인도 스케줄 기업별 stacked bar 차트."""
    try:
        plt = _setup_chart_env()
        import numpy as np

        # 기업별 연도 집계 (dart_data → orders)
        company_year: dict[str, dict[str, int]] = {}
        if dart_data and dart_data.get("orders"):
            for order in dart_data["orders"]:
                company = order.get("company", "기타")
                dd = order.get("delivery_date", "")
                year = dd[:4] if len(dd) >= 4 else ""
                if not year:
                    continue
                if company not in company_year:
                    company_year[company] = {}
                company_year[company][year] = company_year[company].get(year, 0) + 1

        # dart_data 없으면 기존 backlog fallback
        if not company_year:
            sched = backlog.get("delivery_schedule", {})
            if not sched:
                return None
            years = sorted(sched.keys())
            counts = [sched[y] for y in years]
            fig, ax = plt.subplots(figsize=(8, 4))
            ax.bar(years, counts, color="#FF9800", alpha=0.8)
            for i, c in enumerate(counts):
                ax.text(i, c, str(c), ha="center", va="bottom", fontsize=10, fontweight="bold")
            ax.set_xlabel("인도 연도")
            ax.set_ylabel("척수")
            ax.set_title(f"인도 스케줄 ({date_str})", fontsize=13)
            if backlog.get("lead_time_avg_years"):
                lt = backlog["lead_time_avg_years"]
                lt_comment = "여유" if lt < 3 else ("보통" if lt < 4 else "병목")
                ax.annotate(f"평균 리드타임: {lt}년 ({lt_comment})",
                            xy=(0.02, 0.95), xycoords="axes fraction", fontsize=11,
                            bbox={"boxstyle": "round,pad=0.3", "facecolor": "lightyellow"})
            fig.tight_layout()
            out = CHART_DIR / f"{date_str}_delivery.png"
            CHART_DIR.mkdir(parents=True, exist_ok=True)
            fig.savefig(out, dpi=140, bbox_inches="tight")
            plt.close(fig)
            return out

        # 기업별 stacked bar
        all_years = sorted({y for cy in company_year.values() for y in cy})
        companies = sorted(company_year.keys())
        colors = ["#2196F3", "#FF9800", "#4CAF50", "#F44336", "#9C27B0",
                  "#00BCD4", "#795548", "#607D8B"]

        fig, ax = plt.subplots(figsize=(8, 4))
        x = np.arange(len(all_years))
        bottom = np.zeros(len(all_years))

        for ci, comp in enumerate(companies):
            vals = [company_year[comp].get(y, 0) for y in all_years]
            color = colors[ci % len(colors)]
            ax.bar(x, vals, bottom=bottom, label=comp, color=color, alpha=0.85)
            bottom += np.array(vals)

        # 총합 라벨
        for i, total in enumerate(bottom):
            if total > 0:
                ax.text(i, total, str(int(total)), ha="center", va="bottom",
                        fontsize=9, fontweight="bold")

        ax.set_xticks(x)
        ax.set_xticklabels(all_years, fontsize=10)
        ax.set_xlabel("인도 연도")
        ax.set_ylabel("척수")
        ax.set_title(f"인도 스케줄 — 기업별 ({date_str})", fontsize=13)
        ax.legend(fontsize=8, loc="upper right")
        if backlog.get("lead_time_avg_years"):
            lt = backlog["lead_time_avg_years"]
            lt_comment = "여유" if lt < 3 else ("보통" if lt < 4 else "병목")
            ax.annotate(f"평균 리드타임: {lt}년 ({lt_comment})",
                        xy=(0.02, 0.95), xycoords="axes fraction", fontsize=11,
                        bbox={"boxstyle": "round,pad=0.3", "facecolor": "lightyellow"})
        fig.tight_layout()
        out = CHART_DIR / f"{date_str}_delivery.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart delivery error: {e}")
        return None


def _chart_peakout_gauge(peakout: list, date_str: str) -> Path | None:
    """피크아웃 차트: 히스토리 2주+ 시 시계열, 아니면 상태 바."""
    try:
        plt = _setup_chart_env()
        import numpy as np

        if not peakout:
            return None

        history = _load_peakout_history()

        # 히스토리 2건 이상 → 시계열 라인 차트
        if len(history) >= 2:
            # 지표 키 추출 (date 제외)
            all_keys = [k for k in history[-1] if k != "date"]
            if not all_keys:
                all_keys = [p.get("key", p.get("desc", "")[:10]) for p in peakout]

            # 임계치 매핑 (key → warning threshold)
            thresholds: dict[str, float] = {}
            for p in peakout:
                key = p.get("key", p.get("desc", "")[:10])
                if p.get("threshold") is not None:
                    thresholds[key] = p["threshold"]

            dates = [h["date"][-5:] for h in history]  # MM-DD
            fig, ax = plt.subplots(figsize=(8, 4))
            colors_cycle = ["#2196F3", "#FF9800", "#4CAF50", "#F44336", "#9C27B0", "#00BCD4"]

            for ci, key in enumerate(all_keys):
                vals = [h.get(key) for h in history]
                valid_dates = [d for d, v in zip(dates, vals) if v is not None]
                valid_vals = [v for v in vals if v is not None]
                if not valid_vals:
                    continue
                # 지표 한글 설명 찾기
                desc = key
                for p in peakout:
                    if p.get("key") == key:
                        desc = p.get("desc", key)
                        break
                color = colors_cycle[ci % len(colors_cycle)]
                ax.plot(valid_dates, valid_vals, "o-", label=desc, color=color,
                        linewidth=2, markersize=4)
                # 임계치 수평선 + 라벨
                if key in thresholds:
                    thr_val = thresholds[key]
                    ax.axhline(y=thr_val, color=color, linestyle="--",
                               alpha=0.4, linewidth=1)
                    ax.text(len(valid_dates) - 0.5, thr_val,
                            f" {thr_val}", fontsize=6, color=color, alpha=0.7,
                            va="bottom")

            ax.set_title(f"피크아웃 추이 ({date_str})", fontsize=13)
            ax.legend(fontsize=8, loc="best")
            ax.grid(True, alpha=0.3)
            ax.tick_params(axis="x", labelsize=7, rotation=45)
            fig.tight_layout()
            out = CHART_DIR / f"{date_str}_peakout.png"
            CHART_DIR.mkdir(parents=True, exist_ok=True)
            fig.savefig(out, dpi=140, bbox_inches="tight")
            plt.close(fig)
            return out

        # fallback: 상태 바 게이지
        labels = [p["desc"] for p in peakout]
        statuses = [p["status"] for p in peakout]
        bar_colors_map = {"normal": "#4CAF50", "warning": "#F44336", "no_data": "#9E9E9E"}

        fig, ax = plt.subplots(figsize=(7, 3))
        y = np.arange(len(labels))
        bar_colors = [bar_colors_map.get(s, "#9E9E9E") for s in statuses]
        ax.barh(y, [1] * len(labels), color=bar_colors, alpha=0.8, height=0.6)
        ax.set_yticks(y)
        ax.set_yticklabels(labels, fontsize=10)
        ax.set_xlim(0, 1.3)
        ax.set_xticks([])

        for i, (status, p) in enumerate(zip(statuses, peakout)):
            val_str = f"{p['value']}" if p.get("value") is not None else "N/A"
            label = "[OK]" if status == "normal" else "[!!]" if status == "warning" else "[-]"
            ax.text(1.05, i, f"{label} {val_str}", va="center", fontsize=10)

        warning_count = sum(1 for s in statuses if s == "warning")
        ax.set_title(f"피크아웃 추이 ({date_str}) — 경고 {warning_count}/6", fontsize=13)
        fig.tight_layout()
        out = CHART_DIR / f"{date_str}_peakout.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart peakout error: {e}")
        return None


def _chart_longterm_cycles(date_str: str) -> Path | None:
    """20년 장기 사이클 차트 (FRO + SBLK 정규화 오버레이)."""
    try:
        plt = _setup_chart_env()
        data = _load_longterm_proxies()
        if not data:
            return None

        fig, ax = plt.subplots(figsize=(9, 4))
        has_data = False

        proxies = data.get("proxies", data)
        proxy_display = [
            ("fro", "FRO (탱커)", "#1565C0", 1.8),
            ("sblk", "SBLK (벌크)", "#FF6F00", 1.8),
            ("lng", "Cheniere (LNG)", "#2E7D32", 1.3),
            ("zim", "ZIM (컨테이너)", "#C62828", 1.3),
            ("rig", "Transocean (해양)", "#6A1B9A", 1.3),
        ]
        for key, info, color, lw in proxy_display:
            series = proxies.get(key, {}).get("data", [])
            if len(series) < 12:
                continue
            dates = [datetime.strptime(d["date"], "%Y-%m") for d in series]
            closes = [d["close"] for d in series]
            # Min-max 정규화 (0-100)
            mn, mx = min(closes), max(closes)
            if mx > mn:
                norm = [(c - mn) / (mx - mn) * 100 for c in closes]
            else:
                norm = [50] * len(closes)
            ax.plot(dates, norm, label=info, linewidth=lw, color=color)
            has_data = True

        if not has_data:
            plt.close(fig)
            return None

        # 2003-2008 슈퍼사이클 회색 밴드
        ax.axvspan(datetime(2003, 1, 1), datetime(2008, 9, 1),
                   alpha=0.15, color="gray", label="2003-2008 슈퍼사이클")
        # 슈퍼사이클 텍스트 annotation
        ax.text(datetime(2005, 7, 1), 85, "2003-08\nSupercycle",
                fontsize=8, ha="center", va="center", color="#555555",
                style="italic")

        # 현재 위치
        ax.axvline(datetime.now(), color="red", linestyle="--",
                   linewidth=1.5, label="현재")

        ax.set_ylabel("각 지표 정규화 (0=역사 최저, 100=최고)", fontsize=10)
        ax.set_title(f"장기 사이클 프록시 ({date_str})", fontsize=13)
        ax.legend(fontsize=9, loc="upper left")
        ax.grid(alpha=0.3)
        # 해설 주석
        ax.text(0.98, 0.02, "다수 지표가 동시에 50+ 이면 조선 호황 신호",
                transform=ax.transAxes, fontsize=8, ha="right", va="bottom",
                color="#666666", style="italic")
        fig.tight_layout()

        out = CHART_DIR / f"{date_str}_longterm_cycles.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart longterm cycles error: {e}")
        return None


def _chart_score_history(combined: dict, cycle: dict | None,
                         date_str: str) -> Path | None:
    """스코어 추이 차트 (히스토리 라인 + 사이클 단계 배경색)."""
    try:
        plt = _setup_chart_env()
        history = _load_score_history()
        if len(history) < 2:
            return None

        fig, ax = plt.subplots(figsize=(7, 3))
        dates = [h["date"] for h in history]
        scores = [h["combined"] for h in history]

        ax.plot(dates, scores, "o-", color="#1565C0", linewidth=2, markersize=4)

        # 사이클 단계 배경색 밴드
        PHASE_COLORS = {
            "TROUGH": ("#E3F2FD", "바닥"),
            "RECOVERY": ("#FFF3E0", "회복"),
            "EXPANSION": ("#E8F5E9", "확장"),
            "PEAK": ("#FCE4EC", "피크"),
            "DOWNTURN": ("#FFEBEE", "하강"),
        }
        for i, h in enumerate(history):
            phase = h.get("phase", "")
            if phase in PHASE_COLORS:
                color, _ = PHASE_COLORS[phase]
                x0 = max(0, i - 0.5)
                x1 = min(len(history) - 1, i + 0.5)
                ax.axvspan(x0, x1, alpha=0.3, color=color)

        # 임계치 기준선
        ax.axhline(y=66, color="#E53935", linestyle="--", linewidth=0.8, alpha=0.6)
        ax.text(len(dates) - 0.5, 67, "피크 진입 (66)", fontsize=7,
                color="#E53935", ha="right", va="bottom")
        ax.axhline(y=46, color="#43A047", linestyle="--", linewidth=0.8, alpha=0.6)
        ax.text(len(dates) - 0.5, 47, "확장 시작 (46)", fontsize=7,
                color="#43A047", ha="right", va="bottom")

        ax.set_ylabel("Combined Score", fontsize=11)
        ax.set_title(f"스코어 추이 ({date_str})", fontsize=13)
        ax.set_ylim(0, 100)
        ax.grid(alpha=0.3, axis="y")
        # x축 라벨 간솎기
        if len(dates) > 20:
            step = max(1, len(dates) // 10)
            ax.set_xticks(range(0, len(dates), step))
            ax.set_xticklabels([dates[i] for i in range(0, len(dates), step)],
                               rotation=45, ha="right", fontsize=8)
        else:
            ax.set_xticks(range(len(dates)))
            ax.set_xticklabels(dates, rotation=45, ha="right", fontsize=8)
        fig.tight_layout()

        out = CHART_DIR / f"{date_str}_score_history.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart score history error: {e}")
        return None


def _chart_company_dashboard(val_ctx: dict, fin_trends: dict,
                              financials: dict | None,
                              combined: dict, cycle: dict | None,
                              date_str: str) -> Path | None:
    """기업 종합 2x2 대시보드 (P/E | OPM 추이 | 계약자산 | 레이더)."""
    try:
        plt = _setup_chart_env()
        import numpy as np

        fig, axes = plt.subplots(2, 2, figsize=(12, 9))

        # (0,0) P/E 막대 + 값 라벨
        ax = axes[0][0]
        if val_ctx:
            names = [vc.get("name", k)[:8] for k, vc in val_ctx.items()]
            pe_vals = [vc.get("pe_ttm", 0) or 0 for vc in val_ctx.values()]
            hist_avgs = [HISTORICAL_PE_RANGES.get(k, {}).get("avg", 13)
                         for k in val_ctx.keys()]
            x = np.arange(len(names))
            bars_pe = ax.bar(x - 0.15, pe_vals, 0.3, label="현재 P/E", color="#2196F3")
            bars_avg = ax.bar(x + 0.15, hist_avgs, 0.3, label="20Y 평균", color="#BDBDBD")
            for bar in bars_pe:
                h = bar.get_height()
                if h > 0:
                    ax.text(bar.get_x() + bar.get_width() / 2, h,
                            f"{h:.0f}x", ha="center", va="bottom", fontsize=7)
            for bar in bars_avg:
                h = bar.get_height()
                if h > 0:
                    ax.text(bar.get_x() + bar.get_width() / 2, h,
                            f"{h:.0f}", ha="center", va="bottom", fontsize=6,
                            color="#666666")
            ax.set_xticks(x)
            ax.set_xticklabels(names, fontsize=9)
            ax.legend(fontsize=8)
        ax.set_title("P/E 비교", fontsize=11)

        # (0,1) 영업이익률 분기 추이 — revenue/operating_profit에서 직접 계산
        ax = axes[0][1]
        _all_companies = financials.get("companies", financials) if isinstance(financials, dict) else {}
        _vk = set(SHIPBUILDER_STOCKS.keys())
        companies = {k: v for k, v in _all_companies.items() if k in _vk}
        if companies:
            for corp_code, corp_data in companies.items():
                if not isinstance(corp_data, dict):
                    continue
                name = corp_data.get("corp_name", corp_data.get("name", corp_code))
                name = (name or corp_code)[:8]
                raw_q = corp_data.get("quarters", {})
                qlabels: list[str] = []
                margins: list[float] = []
                if isinstance(raw_q, dict) and raw_q:
                    q_items = sorted(raw_q.items())[-12:]
                    for k, v in q_items:
                        qlabels.append(k[-5:])
                        if isinstance(v, dict):
                            rev = v.get("revenue", 0) or 0
                            op = v.get("operating_profit", 0) or 0
                            margins.append((op / rev * 100) if rev > 0 else 0)
                        else:
                            margins.append(0)
                elif isinstance(raw_q, list) and raw_q:
                    for q in raw_q[-12:]:
                        qlabels.append(q.get("quarter", "")[-5:])
                        rev = q.get("revenue", 0) or 0
                        op = q.get("operating_profit", 0) or 0
                        margins.append((op / rev * 100) if rev > 0 else 0)
                if qlabels:
                    ax.plot(qlabels, margins, "o-", label=name, markersize=3)
            ax.legend(fontsize=7, loc="upper left")
            ax.axhspan(5, 7, alpha=0.1, color="gray")
            ax.text(0.98, 0.15, "장기 평균 5-7%", transform=ax.transAxes,
                    fontsize=7, ha="right", va="center", color="#888888",
                    style="italic")
            if companies:
                ax.tick_params(axis="x", labelsize=7, rotation=45)
        ax.set_title("영업이익률 추이 (12분기)", fontsize=11)
        ax.set_ylabel("%", fontsize=9)

        # (1,0) 계약자산 시계열 (미니)
        ax = axes[1][0]
        if companies:
            for corp_code, corp_data in companies.items():
                if not isinstance(corp_data, dict):
                    continue
                name_ca = corp_data.get("corp_name", corp_data.get("name", corp_code))
                name_ca = (name_ca or corp_code)[:8]
                raw_q_ca = corp_data.get("quarters", {})
                if isinstance(raw_q_ca, dict) and raw_q_ca:
                    q_items_ca = sorted(raw_q_ca.items())[-12:]
                    qlabels_ca = [k[-5:] for k, _ in q_items_ca]
                    ca_vals_plot = []
                    for _, v in q_items_ca:
                        ca_val = v.get("contract_assets", 0) if isinstance(v, dict) else 0
                        ca_vals_plot.append((ca_val or 0) / 1e12)
                    if any(v > 0 for v in ca_vals_plot):
                        ax.plot(qlabels_ca, ca_vals_plot, "o-", label=name_ca, markersize=3)
            ax.legend(fontsize=7, loc="upper left")
            ax.tick_params(axis="x", labelsize=7, rotation=45)
        ax.set_title("계약자산 추이", fontsize=11)
        ax.set_ylabel("조 원", fontsize=9)

        # (1,1) 5축 레이더 (미니)
        ax_radar = fig.add_subplot(2, 2, 4, projection="polar")
        axes[1][1].set_visible(False)
        axis_labels = ["Demand", "Financial", "Order", "Valuation", "Structural"]
        scores: list[float] = []
        if cycle and cycle.get("axis_scores"):
            for a in ["demand", "financial", "order", "valuation", "structural"]:
                s = cycle["axis_scores"].get(a)
                scores.append(s if s is not None else 0)
        else:
            scores = [combined.get("market_pulse", 0)] + [0] * 4
        angles = np.linspace(0, 2 * np.pi, len(axis_labels), endpoint=False).tolist()
        scores_plot = scores + [scores[0]]
        angles_plot = angles + [angles[0]]
        ax_radar.fill(angles_plot, scores_plot, alpha=0.25, color="#2196F3")
        ax_radar.plot(angles_plot, scores_plot, "o-", linewidth=2, color="#1565C0")
        ax_radar.set_xticks(angles)
        ax_radar.set_xticklabels(axis_labels, fontsize=9)
        ax_radar.set_ylim(0, 100)
        ax_radar.set_yticks([20, 40, 60, 80])
        ax_radar.set_yticklabels(["20", "40", "60", "80"], fontsize=6, color="#888888")
        ax_radar.set_title("5축 스코어", fontsize=11, pad=15)

        fig.suptitle(f"기업 종합 대시보드 ({date_str})", fontsize=14)
        fig.tight_layout(rect=[0, 0, 1, 0.96])

        out = CHART_DIR / f"{date_str}_company_dashboard.png"
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        fig.savefig(out, dpi=140, bbox_inches="tight")
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart company dashboard error: {e}")
        return None


def generate_charts(data: dict, pulse: dict, combined: dict,
                    cycle: dict | None, fin_trends: dict, val_ctx: dict,
                    backlog: dict, peakout: list, vessel_mix: dict,
                    dart_data: dict | None, financials: dict | None,
                    indicators: dict) -> list[tuple[Path, str]]:
    """7개 차트 생성. [(path, caption), ...] 반환. 실패 시 skip (partial success)."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    CHART_DIR.mkdir(parents=True, exist_ok=True)
    results: list[tuple[Path, str]] = []

    chart_specs: list[tuple[str, Any]] = [
        ("장기 사이클 프록시", lambda: _chart_longterm_cycles(date_str)),
        ("스코어 추이", lambda: _chart_score_history(combined, cycle, date_str)),
        ("기업 종합 대시보드", lambda: _chart_company_dashboard(val_ctx, fin_trends, financials, combined, cycle, date_str)),
        ("선종 믹스", lambda: _chart_vessel_mix(vessel_mix, dart_data, date_str)),
        ("수요지표 Z-Score", lambda: _chart_demand_zscore(indicators, date_str)),
        ("인도 스케줄", lambda: _chart_delivery_schedule(backlog, dart_data, date_str)),
        ("피크아웃 추이", lambda: _chart_peakout_gauge(peakout, date_str)),
    ]

    for caption, fn in chart_specs:
        try:
            path = fn()
            if path and path.exists():
                results.append((path, caption))
                log(f"Chart OK: {caption}")
        except Exception as e:
            log(f"Chart SKIP ({caption}): {e}")

    log(f"Charts generated: {len(results)}/{len(chart_specs)}")
    return results


# ══════════════════════════════════════════════════════════════════
#  PDF Report (fpdf2)
# ══════════════════════════════════════════════════════════════════

def _find_korean_font() -> str | None:
    """시스템에서 한글 TTC/TTF 폰트 경로 반환. NanumGothic 우선 (윈도우 호환)."""
    candidates = [
        "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/7a0b5c0f3c1d41c4c52a33343496c9c65ad52c50.asset/AssetData/NanumGothic.ttc",
        "/Library/Fonts/NanumGothic.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",  # Linux
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    return None


def build_pdf_report(report_md: str, charts: list[tuple[Path, str]],
                     date_str: str) -> Path | None:
    """MD 리포트 + 차트 PNG → PDF 파일 생성."""
    try:
        from fpdf import FPDF

        font_path = _find_korean_font()
        if not font_path:
            log("ERROR: Korean font not found for PDF")
            return None

        pdf = FPDF()
        pdf.set_margins(10, 10, 10)
        pdf.set_auto_page_break(auto=True, margin=15)

        # 폰트 등록 (fpdf2 2.8+ TTC 직접 지원)
        pdf.add_font("Korean", "", font_path)
        pdf.add_font("Korean", "B", font_path)

        # ── 표지 (축소 — Section 1과 같은 페이지) ──
        pdf.add_page()
        pdf.set_font("Korean", "B", 20)
        pdf.cell(0, 12, "조선업 사이클 분석 리포트", align="C")
        pdf.ln()
        pdf.set_font("Korean", "", 12)
        pdf.cell(0, 8, f"{date_str}  |  5축 스코어링 + 피크아웃  |  v6.2", align="C")
        pdf.ln(8)

        # ── 본문 ──
        # 섹션별로 분할해서 차트를 적절히 삽입
        sections = re.split(r"(?=^## )", report_md, flags=re.MULTILINE)

        # 차트 매핑: v5 섹션 키워드 → 차트 캡션
        chart_map: dict[str, list[tuple[Path, str]]] = {
            "종합 판정": [],
            "기업 종합": [],
            "수주": [],
            "수요 환경": [],
            "피크아웃": [],
        }
        for path, caption in charts:
            if "사이클" in caption or "스코어 추이" in caption:
                chart_map["종합 판정"].append((path, caption))
            elif "대시보드" in caption:
                chart_map["기업 종합"].append((path, caption))
            elif "선종" in caption or "인도" in caption:
                chart_map["수주"].append((path, caption))
            elif "Z-Score" in caption or "수요" in caption:
                chart_map["수요 환경"].append((path, caption))
            elif "피크아웃" in caption:
                chart_map["피크아웃"].append((path, caption))

        _cap_emoji_re = re.compile(
            r"[\U0001f300-\U0001f9ff\u2705\u26a0\ufe0f\u274c"
            r"\u2b06\u2b07\u27a1\u2714\u2716"
            r"\U0001f4ca\U0001f4c8\U0001f4c9\U0001f6a2\u2693"
            r"\u2191\u2193\u2190\u2192\u25b2\u25bc\u25b6\u25c0]"
        )

        # sections[0] = "# 제목..." (표지에 이미 렌더), 스킵
        # sections[1] = "## 1. 종합 판정" → 표지와 같은 페이지
        # sections[2+] = 새 페이지
        body_sections = [s for s in sections if s.strip()]
        for si, section in enumerate(body_sections):
            if not section.strip():
                continue
            # 첫 chunk(# 제목)는 표지에 이미 렌더 → 본문만 렌더(add_page 안함)
            # 두번째 chunk(## 1. 종합판정)는 표지 이어서
            if si == 0:
                # MD 제목 줄은 표지에 이미 표시. "첫 리포트" 인용문 등만 렌더
                lines_skip = [l for l in section.strip().split("\n") if not l.startswith("# ")]
                if lines_skip:
                    _render_md_section(pdf, "\n".join(lines_skip))
                continue
            elif si == 1:
                pass  # 같은 페이지에 이어서 렌더
            else:
                pdf.add_page()
            _render_md_section(pdf, section)

            # 해당 섹션에 맞는 차트 — 텍스트와 분리 배치
            matched = []
            for key, chart_list in chart_map.items():
                # 섹션 제목(첫 줄)에서만 매칭 — 본문 키워드 오매칭 방지
                sec_title = section.strip().split("\n")[0]
                if key in sec_title:
                    matched.extend(chart_list)

            for ci, (cpath, ccaption) in enumerate(matched):
                if not cpath.exists():
                    continue
                # 공간 부족 시 새 페이지 (차트 크기에 맞춰 동적 판단)
                sz = CHART_SIZES.get(ccaption, {})
                img_w = sz.get("w", 120)
                # 차트 높이 추정: 폭 × 0.6 (일반) ~ 0.7 (대시보드)
                est_h = img_w * 0.65
                remaining = pdf.h - pdf.get_y() - 15
                if remaining < est_h + 12:
                    pdf.add_page()
                pdf.ln(3)
                pdf.set_font("Korean", "B", 10)
                clean_cap = _cap_emoji_re.sub("", ccaption)
                pdf.cell(0, 6, clean_cap, new_x="LMARGIN",
                         new_y="NEXT", align="C")
                sz = CHART_SIZES.get(ccaption, {})
                img_w = sz.get("w", 190)
                if sz.get("center"):
                    x_pos = (pdf.w - img_w) / 2
                else:
                    x_pos = pdf.l_margin
                pdf.image(str(cpath), x=x_pos, w=img_w)
                pdf.ln(3)

        # ── 출력 ──
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        out_path = REPORT_DIR / f"shipbuilding_cycle_{date_str}.pdf"
        pdf.output(str(out_path))
        log(f"PDF saved: {out_path.name} ({out_path.stat().st_size // 1024}KB)")
        return out_path
    except Exception as e:
        log(f"PDF build error: {e}")
        return None


def _render_md_section(pdf, section: str) -> None:
    """MD 섹션을 fpdf2 페이지에 렌더링 — 테이블 그리드 + 특수문자 처리."""
    eff_w = pdf.w - pdf.l_margin - pdf.r_margin

    _emoji_re = re.compile(
        r"[\U0001f300-\U0001f9ff\u2705\u26a0\ufe0f\u274c"
        r"\u2b06\u2b07\u27a1\u2714\u2716"
        r"\U0001f4ca\U0001f4c8\U0001f4c9\U0001f6a2\u2693"
        r"\u25b2\u25bc\u25b6\u25c0]"
    )

    def _clean(s: str) -> str:
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
        s = re.sub(r"\*(.+?)\*", r"\1", s)
        s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
        # 화살표 → 텍스트 치환 (폰트 글리프 누락 방지)
        s = s.replace("\u2191", "(+)").replace("\u2193", "(-)")
        s = s.replace("\u2192", "->").replace("\u2190", "<-")
        s = _emoji_re.sub("", s)
        return s.strip()

    def _safe_multi_cell(w: float, h: float, txt: str, **kw) -> None:
        """multi_cell wrapper — 실패 시에도 반드시 Y 진행."""
        pdf.set_x(pdf.l_margin)  # X 강제 리셋 (오른쪽 밀림 방지)
        try:
            pdf.multi_cell(w, h, txt, **kw)
        except Exception:
            prev = pdf.font_size_pt
            pdf.set_font_size(max(6, prev - 2))
            pdf.set_x(pdf.l_margin)
            try:
                pdf.multi_cell(w, h, txt, **kw)
            except Exception:
                pdf.ln(h)  # 실패해도 Y 진행 (겹침 방지)
            pdf.set_font_size(prev)

    def _render_table(rows: list[str]) -> None:
        """테이블 행 리스트 → 셀 그리드 렌더링."""
        if not rows:
            return
        parsed = []
        for row in rows:
            cells = [c.strip() for c in row.strip().strip("|").split("|")]
            parsed.append(cells)
        ncols = max(len(r) for r in parsed) if parsed else 0
        if ncols == 0:
            return

        font_size = 7 if ncols <= 6 else 6
        row_h = 5.5
        pdf.set_font("Korean", "", font_size)

        # 열 너비: 실제 텍스트 폭 기준 비례 배분
        col_w = [0.0] * ncols
        for row in parsed:
            for i, cell in enumerate(row):
                if i < ncols:
                    try:
                        w = pdf.get_string_width(_clean(cell)) + 3
                    except Exception:
                        w = 15
                    col_w[i] = max(col_w[i], w)
        total = sum(col_w) or 1
        if total > eff_w:
            scale = eff_w / total
            col_w = [w * scale for w in col_w]
        elif total < eff_w:
            extra = (eff_w - total) / ncols
            col_w = [w + extra for w in col_w]

        for ri, row in enumerate(parsed):
            is_header = (ri == 0)
            style = "B" if is_header else ""
            pdf.set_font("Korean", style, font_size)
            if is_header:
                pdf.set_fill_color(230, 230, 230)
            pdf.set_x(pdf.l_margin)  # 매 행 X 리셋
            for ci in range(ncols):
                txt = _clean(row[ci]) if ci < len(row) else ""
                fill = is_header
                try:
                    pdf.cell(col_w[ci], row_h, txt, border=1,
                             align="C", fill=fill)
                except Exception:
                    pdf.cell(col_w[ci], row_h, "?", border=1,
                             align="C", fill=fill)
            pdf.ln()
        pdf.ln(2)

    # ── 라인별 렌더링 (테이블은 연속 수집 후 그리드 출력) ──
    lines = section.split("\n")
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            pdf.ln(3)
            i += 1
            continue

        # 테이블 연속 행 수집
        if stripped.startswith("|"):
            table_rows: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                row = lines[i].strip()
                if "---" not in row:
                    table_rows.append(row)
                i += 1
            _render_table(table_rows)
            continue

        # 헤더
        if stripped.startswith("### "):
            pdf.set_font("Korean", "B", 12)
            _safe_multi_cell(eff_w, 7, _clean(stripped[4:]))
            pdf.ln(2)
        elif stripped.startswith("## "):
            pdf.set_font("Korean", "B", 15)
            _safe_multi_cell(eff_w, 9, _clean(stripped[3:]))
            pdf.ln(3)
        elif stripped.startswith("# "):
            pdf.set_font("Korean", "B", 18)
            _safe_multi_cell(eff_w, 10, _clean(stripped[2:]))
            pdf.ln(4)
        elif stripped.startswith("- "):
            pdf.set_font("Korean", "", 10)
            _safe_multi_cell(eff_w, 6, "  " + _clean(stripped))
        elif stripped.startswith("> "):
            pdf.set_font("Korean", "", 10)
            pdf.set_text_color(100, 100, 100)
            _safe_multi_cell(eff_w, 6, _clean(stripped[2:]))
            pdf.set_text_color(0, 0, 0)
        else:
            pdf.set_font("Korean", "", 10)
            _safe_multi_cell(eff_w, 6, _clean(stripped))
        i += 1


def send_telegram_pdf(pdf_path: Path, caption: str,
                      chat_id: str = str(DM_CHAT_ID),
                      dry_run: bool = False) -> bool:
    """sendDocument API로 PDF 전송 (shared telegram 경유). DM only (테스트 중)."""
    if dry_run:
        log(f"DRY-RUN: skip PDF send ({pdf_path.name})")
        return True
    ok = send_document(chat_id, str(pdf_path), caption=caption)
    if ok:
        log(f"PDF sent to {chat_id}")
    return ok


def _send_progress_dm(msg: str, dry_run: bool = False) -> None:
    """진행 보고 DM 전송 (shared telegram 경유)."""
    if dry_run:
        log(f"DRY-RUN progress: {msg}")
        return
    try:
        send_dm(msg, level="critical")
    except Exception:
        pass  # 진행 보고 실패는 무시


# ══════════════════════════════════════════════════════════════════
#  Telegram
# ══════════════════════════════════════════════════════════════════

def send_telegram(text: str, dry_run: bool = False) -> bool:
    """지식사랑방 론 토픽으로 전송 (shared telegram 경유)."""
    if dry_run:
        log("DRY-RUN: skip send")
        print(text)
        return True
    ok = send_group_chunked(text, topic_id=RON_TOPIC_ID)
    if ok:
        log("Sent to 지식사랑방 론 토픽")
    return ok


def _md_to_telegram_html(md: str) -> str:
    """Markdown → Telegram HTML 간이 변환."""
    import re
    lines: list[str] = []
    for raw_line in md.split("\n"):
        line = raw_line
        # Headers → bold
        m = re.match(r"^(#{1,3})\s+(.*)", line)
        if m:
            line = f"<b>{m.group(2)}</b>"
        # **bold** → <b>
        line = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", line)
        # *italic* → <i> (but not inside already-converted tags)
        line = re.sub(r"(?<![<>/])\*(.+?)\*(?![<>/])", r"<i>\1</i>", line)
        # escape HTML entities (except our tags)
        # Already have <b><i> so just escape & < > outside tags
        lines.append(line)
    return "\n".join(lines)


def _split_report_for_telegram(report: str, max_len: int = 4000) -> list[str]:
    """리포트를 ## 섹션 경계로 분할 (Telegram 4096 limit)."""
    import re
    sections = re.split(r"(?=^## )", report, flags=re.MULTILINE)
    chunks: list[str] = []
    current = ""
    for section in sections:
        if not section.strip():
            continue
        # 단일 섹션이 max_len 초과 → ### 기준으로 재분할
        if len(section) > max_len:
            sub_parts = re.split(r"(?=^### )", section, flags=re.MULTILINE)
            for part in sub_parts:
                if not part.strip():
                    continue
                if len(current) + len(part) > max_len and current:
                    chunks.append(current.strip())
                    current = ""
                current += part + "\n"
        elif len(current) + len(section) > max_len and current:
            chunks.append(current.strip())
            current = section + "\n"
        else:
            current += section + "\n"
    if current.strip():
        chunks.append(current.strip())
    return chunks


def send_telegram_full_report(report: str, dry_run: bool = False,
                              dm_only: bool = True) -> bool:
    """전체 리포트를 분할 전송 (shared telegram 경유).

    dm_only=True면 DM으로만 (테스트 완료 전).
    _split_report_for_telegram으로 ## 섹션 경계 분할 후
    _md_to_telegram_html 변환하여 전송.
    """
    if dry_run:
        log("DRY-RUN: skip report send")
        print(report)
        return True

    chunks = _split_report_for_telegram(report)
    log(f"Sending full report: {len(chunks)} chunks, {len(report)} chars total (dm_only={dm_only})")

    # 각 청크를 MD→HTML 변환하여 결합 후 chunked 전송
    html_report = "\n".join(_md_to_telegram_html(chunk) for chunk in chunks)
    success = send_dm_chunked(html_report)

    if not dm_only:
        if not send_group_chunked(html_report, topic_id=RON_TOPIC_ID):
            success = False

    dest = "DM" if dm_only else "DM + 지식사랑방"
    log(f"Report sent to {dest} ({len(chunks)} parts)" if success else f"ERROR: partial send to {dest}")
    return success


# ══════════════════════════════════════════════════════════════════
#  IO
# ══════════════════════════════════════════════════════════════════

def load_manual_indicators() -> dict:
    if not MANUAL_FILE.exists():
        return {}
    try:
        return json.loads(MANUAL_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def save_manual_indicators(data: dict) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = datetime.now(KST).isoformat()
    MANUAL_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def send_manual_update_reminder(dry_run: bool = False) -> bool:
    """수동 지표가 90일 이상 미갱신이면 DM 리마인더 전송."""
    data = load_manual_indicators()
    updated_at = data.get("updated_at")
    if not updated_at:
        _send_progress_dm("⚠️ 수동 지표 미설정. `--manual-update` 로 초기화 필요.", dry_run)
        return True
    try:
        last = datetime.fromisoformat(updated_at)
        if last.tzinfo is None:
            last = last.replace(tzinfo=KST)
        days_old = (datetime.now(KST) - last).days
    except (ValueError, TypeError):
        days_old = 999
    if days_old >= 90:
        _send_progress_dm(
            f"⚠️ 수동 지표 {days_old}일 미갱신 — `--manual-update regulation=8 vessel_age=7` 등으로 업데이트 필요",
            dry_run,
        )
        return True
    return False


def _ensure_history_files() -> None:
    """히스토리 파일이 없으면 빈 리스트로 생성."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for fpath in (SCORE_HISTORY_FILE, PEAKOUT_HISTORY_FILE, VESSEL_MIX_HISTORY_FILE):
        if not fpath.exists():
            fpath.write_text("[]")


def update_manual(updates: list[str]) -> dict:
    data = load_manual_indicators()
    if "scores" not in data:
        data["scores"] = {}
    for item in updates:
        if "=" not in item:
            log(f"SKIP: {item}")
            continue
        key, val_str = item.split("=", 1)
        key = key.strip()
        if key not in MANUAL_INDICATORS:
            log(f"SKIP unknown: '{key}'. Valid: {list(MANUAL_INDICATORS.keys())}")
            continue
        try:
            val = float(val_str.strip())
            if not (1 <= val <= 10):
                log(f"SKIP {key}={val} (1~10)")
                continue
            data["scores"][key] = val
            log(f"  {key} = {val}")
        except ValueError:
            log(f"SKIP {key}: invalid '{val_str}'")
    save_manual_indicators(data)
    return data


def _load_latest_data() -> dict | None:
    if not OUTPUT_DIR.exists():
        return None
    for f in sorted(OUTPUT_DIR.glob("????-??-??.json"), reverse=True):
        try:
            return json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
    return None


def _load_dart_data() -> dict | None:
    if not DART_ORDERS_FILE.exists():
        return None
    try:
        return json.loads(DART_ORDERS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None


# ══════════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════════

def _append_valuation_history(val_ctx: dict) -> None:
    """주간 밸류에이션 스냅샷 시계열 누적."""
    history: list[dict] = []
    if VALUATION_HISTORY_FILE.exists():
        try:
            history = json.loads(VALUATION_HISTORY_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    snapshot = {"date": datetime.now().strftime("%Y-%m-%d"), "stocks": {}}
    for key, vc in val_ctx.items():
        snapshot["stocks"][key] = {
            "pe_ttm": vc.get("pe_ttm"), "pb": vc.get("pb"),
            "market_cap": vc.get("market_cap"), "ev_ebitda": vc.get("ev_ebitda"),
        }
    history.append(snapshot)
    # 최근 52주만 유지
    history = history[-52:]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    VALUATION_HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2))


def show_status() -> None:
    data = _load_latest_data()
    dart = _load_dart_data()
    manual = load_manual_indicators()
    financials = _load_financials()
    valuation = _load_valuation()
    print("=== 조선업 사이클 트래커 v3 ===\n")

    if data:
        indicators = data.get("indicators", {})
        pulse = calculate_market_pulse(indicators)
        print(f"마지막 수집: {data.get('date')} ({len(indicators)}/{len(TIER1_INDICATORS)} 지표)")
        print(f"Demand (Market Pulse): {pulse['score']:.1f}/100")
    else:
        print("수집 데이터 없음. --collect 실행 필요\n")

    if financials and financials.get("companies"):
        print(f"\nDART 재무제표: {len(financials['companies'])}사")
        for key, comp in financials["companies"].items():
            print(f"  {comp['name']}: {len(comp.get('quarters', {}))} 분기")
    if valuation and valuation.get("stocks"):
        print(f"\n밸류에이션: {len(valuation['stocks'])}사")

    if dart and dart.get("status") == "ok":
        est = dart.get("estimates", {})
        print(f"\nDART 수주: {est.get('total_orders', 0)}건 / {est.get('total_ships', 0)}척")
    elif not _get_dart_api_key():
        print(f"\nDART: 미설정 — echo 'KEY' > {DART_API_KEY_FILE}")

    ms = manual.get("scores", {})
    print(f"\n수동 지표: {len(ms)}/{len(MANUAL_INDICATORS)}")
    for k, m in MANUAL_INDICATORS.items():
        v = ms.get(k)
        print(f"  {m['name']}: {v if v else '미입력'} ({m['desc']})")

    if data:
        indicators = data.get("indicators", {})
        pulse = calculate_market_pulse(indicators)
        fin_trends = analyze_financial_trends(financials)
        val_ctx = analyze_valuation_context(valuation, financials)
        cycle = calculate_cycle_score(fin_trends, val_ctx, dart, manual, indicators)
        combined = calculate_combined_score(pulse, cycle)
        s = combined.get("combined") or pulse["score"]
        pc, pd = determine_cycle_phase(s)
        label = "Combined" if combined.get("combined") else "Demand"
        print(f"\n▶ {label}: {s:.1f}/100 [{pc}] {pd}")


def generate_report(notify: bool = False, dry_run: bool = False) -> dict[str, Any]:
    _ensure_history_files()
    data = _load_latest_data()
    if not data:
        log("ERROR: No data")
        return {"error": "no data"}
    indicators = data.get("indicators", {})
    dart = _load_dart_data()
    manual = load_manual_indicators()
    financials = _load_financials()
    valuation = _load_valuation()

    data["manual"] = manual  # build_weekly_report에서 축별 산출 근거용
    pulse = calculate_market_pulse(indicators)
    fin_trends = analyze_financial_trends(financials)
    val_ctx = analyze_valuation_context(valuation, financials)
    backlog_info = analyze_backlog_timeline(dart, financials)
    vessel_mix = analyze_vessel_type_mix(dart)
    signals = detect_cycle_signals(financials, valuation, dart)
    peakout = compute_peakout_indicators(fin_trends, val_ctx, dart, backlog_info)
    cycle = calculate_cycle_score(fin_trends, val_ctx, dart, manual, indicators)
    combined = calculate_combined_score(pulse, cycle)

    now = datetime.now()
    week = now.isocalendar()[1]
    year = now.isocalendar()[0]
    date_str = now.strftime("%Y-%m-%d")

    # 전월 데이터 로드
    prev_data = _load_previous_report_data(week, year)

    report = build_weekly_report(data, pulse, cycle, combined, signals, dart,
                                  fin_trends, val_ctx, backlog_info, peakout, vessel_mix,
                                  prev_data, financials)

    if not dry_run:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (REPORT_DIR / f"week_{year}-{week:02d}.md").write_text(report)
        VAULT_REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (VAULT_REPORT_DIR / f"shipbuilding-cycle-{year}-W{week:02d}.md").write_text(report)
        _append_valuation_history(val_ctx)
        _save_report_data(week, year, pulse, combined, fin_trends, val_ctx,
                          backlog_info, dart, peakout, vessel_mix, manual, indicators)
        log(f"Report saved (week {week})")
    else:
        print(report)

    # v4: 차트 생성 + PDF 빌드
    charts: list[tuple[Path, str]] = []
    pdf_path: Path | None = None

    if notify or not dry_run:
        _send_progress_dm("🚢 조선업 사이클 리포트 v6.2 생성 시작...", dry_run)

        # 차트 생성
        try:
            charts = generate_charts(
                data, pulse, combined, cycle, fin_trends, val_ctx,
                backlog_info, peakout, vessel_mix, dart, financials, indicators,
            )
            chart_names = [c[1] for c in charts]
            _send_progress_dm(f"📊 차트 {len(charts)}종 생성 완료 ({', '.join(chart_names)})", dry_run)
        except Exception as e:
            log(f"Chart generation failed: {e}")
            _send_progress_dm(f"⚠️ 차트 생성 실패: {e}", dry_run)

        # PDF 빌드
        try:
            pdf_path = build_pdf_report(report, charts, date_str)
            if pdf_path:
                pages_est = len(report.split("## ")) + len(charts)
                _send_progress_dm(f"📄 PDF 빌드 완료 (~{pages_est}페이지, {pdf_path.stat().st_size // 1024}KB)", dry_run)
        except Exception as e:
            log(f"PDF build failed: {e}")
            _send_progress_dm(f"⚠️ PDF 빌드 실패: {e}", dry_run)

    if notify:
        # v6.1: PDF만 전송 (텍스트 청크 제거 — 윈도우 깨짐 방지)
        if pdf_path and pdf_path.exists():
            phase_score = combined.get("combined") or pulse["score"]
            pc, pd = determine_cycle_phase(phase_score)
            caption = f"🚢 조선업 사이클 분석 W{week} | {pc} {phase_score:.0f}/100 | {date_str}"
            send_telegram_pdf(pdf_path, caption, dry_run=dry_run)
            _send_progress_dm("✅ PDF 리포트 전송 완료", dry_run)
        else:
            # PDF 빌드 실패 시 텍스트 fallback
            send_telegram_full_report(report, dry_run)
            _send_progress_dm("⚠️ PDF 실패 → 텍스트 fallback 전송", dry_run)

    phase_score = combined.get("combined") or pulse["score"]
    pc, _ = determine_cycle_phase(phase_score)
    return {"status": "ok", "market_pulse": pulse["score"],
            "cycle_score": cycle["score"] if cycle else None,
            "combined": combined.get("combined"), "phase": pc, "signals": len(signals),
            "charts": len(charts), "pdf": str(pdf_path) if pdf_path else None}


def main():
    parser = argparse.ArgumentParser(description="조선업 사이클 지표 추적")
    parser.add_argument("--collect", action="store_true", help="데이터 수집 (yfinance + DART)")
    parser.add_argument("--collect-longterm", action="store_true", help="장기 시계열 수집 (월 1회)")
    parser.add_argument("--report", action="store_true", help="주간 리포트")
    parser.add_argument("--notify", action="store_true", help="Telegram DM")
    parser.add_argument("--manual-update", nargs="+", metavar="K=V", help="수동 지표 (1~10)")
    parser.add_argument("--status", action="store_true", help="현재 상태")
    parser.add_argument("--setup", action="store_true", help="DART 초기 설정")
    parser.add_argument("--remind", action="store_true", help="수동 지표 미갱신 리마인더")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    args = parser.parse_args()

    if not any([args.collect, args.collect_longterm, args.report, args.manual_update,
                args.status, args.setup, args.remind]):
        parser.print_help()
        return

    if args.setup:
        api_key = _get_dart_api_key()
        if not api_key:
            print(f"DART API 키 먼저 설정:\n  https://opendart.fss.or.kr/ → 인증키 발급\n  echo 'KEY' > {DART_API_KEY_FILE}")
            return
        _resolve_corp_codes(api_key)
        print("DART 설정 완료!")
        return

    if args.manual_update:
        update_manual(args.manual_update)
    if args.collect:
        collect_tier1(dry_run=args.dry_run)
        collect_dart_orders(dry_run=args.dry_run)
        collect_valuation(dry_run=args.dry_run)
        collect_dart_financials(dry_run=args.dry_run)
        collect_dart_supplementary(dry_run=args.dry_run)
    if args.collect_longterm:
        collect_longterm_proxies(dry_run=args.dry_run)
    if args.report:
        result = generate_report(notify=args.notify, dry_run=args.dry_run)
        if "error" not in result:
            log(f"Report: pulse={result['market_pulse']}, phase={result['phase']}")
    if args.remind:
        send_manual_update_reminder(dry_run=args.dry_run)
    if args.status:
        show_status()


if __name__ == "__main__":
    main()
