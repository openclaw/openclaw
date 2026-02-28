#!/usr/bin/env python3
"""petrochemical_cycle_tracker.py — 석유화학 사이클 분석 파이프라인 v1.0

5축 스코어링 기반 석유화학 산업 사이클 분석.
cycle_base.py 공통 모듈 기반 + 석유화학 도메인 특화 로직.

핵심: 에틸렌-나프타 스프레드가 업종 수익성의 바로미터.
중국 증설 사이클 vs 글로벌 수요 회복이 사이클 결정.

Usage:
    python3 pipeline/petrochemical_cycle_tracker.py --collect
    python3 pipeline/petrochemical_cycle_tracker.py --report --notify
    python3 pipeline/petrochemical_cycle_tracker.py --manual-update china_capacity=7 green_transition=6
    python3 pipeline/petrochemical_cycle_tracker.py --status
    python3 pipeline/petrochemical_cycle_tracker.py --setup
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# -- path setup --
SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from shared.log import make_logger  # noqa: E402
from shared.cycle_base import (  # noqa: E402
    CycleConfig, KST, CYCLE_PHASES,
    DART_REPRT_CODES, DART_ACCOUNT_PATTERNS,
    load_json_safe, save_json_atomic,
    compute_zscore_entry, fetch_kr_ohlcv, fetch_global_ohlcv,
    collect_tier1_generic,
    zscore_to_ratio, zscore_to_1_10,
    calculate_market_pulse_generic, calculate_combined_score,
    determine_cycle_phase,
    append_score_history, append_peakout_history,
    load_score_history, load_peakout_history,
    load_manual_indicators, save_manual_indicators, update_manual,
    peakout_item,
    send_progress_dm, send_telegram_pdf_generic,
    build_pdf_report_generic, find_korean_font,
    setup_chart_env, render_md_section,
    qoq_change, sorted_quarters,
)
from shared.telegram import (  # noqa: E402
    send_dm, send_dm_chunked, send_document,
    DM_CHAT_ID,
)
from shared.vault_paths import REPORTS as VAULT_REPORT_DIR  # noqa: E402

# ── 선택적 라이브러리 ─────────────────────────────────────────────
try:
    import OpenDartReader as _OpenDartReader
    HAS_OPENDART = True
except ImportError:
    HAS_OPENDART = False

# ── 디렉토리 & 로거 ──────────────────────────────────────────────
WORKSPACE = SCRIPTS_DIR.parent
OUTPUT_DIR = WORKSPACE / "memory" / "petrochemical-indicators"
REPORT_DIR = OUTPUT_DIR / "reports"
REPORT_DATA_DIR = OUTPUT_DIR / "report_data"
CHART_DIR = OUTPUT_DIR / "charts"

log = make_logger(log_file=str(WORKSPACE / "logs" / "petrochemical_cycle.log"))

DART_API_KEY_FILE = Path.home() / ".openclaw" / "dart_api_key"

# ══════════════════════════════════════════════════════════════════
#  석유화학 도메인 설정
# ══════════════════════════════════════════════════════════════════

# KR 종목 키 (pykrx 수집용)
_KR_TICKERS = {"lgchem", "lottechem", "hanwhasol", "kumho", "skinno", "hyosung"}

# ── Tier 1 지표 ──────────────────────────────────────────────────
PETRO_TIER1_INDICATORS: dict[str, dict[str, str]] = {
    # 원가/원료 (나프타 = 석유화학 원가의 핵심)
    "wti":         {"ticker": "CL=F",      "name": "WTI 유가",              "category": "feedstock"},
    "brent":       {"ticker": "BZ=F",      "name": "Brent 유가",            "category": "feedstock"},
    "natgas":      {"ticker": "NG=F",      "name": "천연가스 (에탄 프록시)", "category": "feedstock"},
    # 수요측 프록시
    "xle":         {"ticker": "XLE",       "name": "에너지 섹터 ETF",       "category": "demand"},
    "xlb":         {"ticker": "XLB",       "name": "소재 섹터 ETF",         "category": "demand"},
    "eem":         {"ticker": "EEM",       "name": "이머징 마켓 ETF",       "category": "demand"},
    # 글로벌 화학 대형주 (스프레드/마진 프록시)
    "dow":         {"ticker": "DOW",       "name": "Dow Inc.",              "category": "global_chem"},
    "lyb":         {"ticker": "LYB",       "name": "LyondellBasell",        "category": "global_chem"},
    "basf":        {"ticker": "BASFY",     "name": "BASF (ADR)",            "category": "global_chem"},
    "ce":          {"ticker": "CE",        "name": "Celanese",              "category": "global_chem"},
    # 한국 석유화학
    "lgchem":      {"ticker": "051910.KS", "name": "LG화학",               "category": "kr_chem"},
    "lottechem":   {"ticker": "011170.KS", "name": "롯데케미칼",            "category": "kr_chem"},
    "hanwhasol":   {"ticker": "009830.KS", "name": "한화솔루션",            "category": "kr_chem"},
    "kumho":       {"ticker": "011780.KS", "name": "금호석유화학",           "category": "kr_chem"},
    "skinno":      {"ticker": "096770.KS", "name": "SK이노베이션",          "category": "kr_chem"},
    "hyosung":     {"ticker": "298000.KS", "name": "효성화학",              "category": "kr_chem"},
}

# Market Pulse 가중치 (원가+수요+글로벌마진, total=100)
PETRO_MARKET_PULSE_WEIGHTS: dict[str, int] = {
    "wti": 15, "brent": 10, "natgas": 10,
    "xle": 10, "xlb": 15, "eem": 10,
    "dow": 15, "lyb": 15,
}

# ── 5축 스코어링 가중치 ──────────────────────────────────────────
PETRO_CYCLE_WEIGHTS: dict[str, int] = {
    "demand":     20,  # 글로벌 수요 (ETF + 글로벌 화학주)
    "financial":  25,  # 영업이익률, 매출 성장, ROE (DART)
    "order":      15,  # 에틸렌/PE/PP 스프레드 프록시, 가동률
    "valuation":  15,  # P/E vs 역사적
    "structural": 25,  # 중국 증설, 탈탄소 전환, 친환경 규제, 원가 구조
}

# ── DART 대상 기업 ───────────────────────────────────────────────
PETRO_DART_TARGETS: dict[str, dict[str, str]] = {
    "lgchem":    {"code": "051910", "name": "LG화학",       "focus": "NCC/배터리/첨단소재"},
    "lottechem": {"code": "011170", "name": "롯데케미칼",    "focus": "에틸렌/PE/PP/MEG"},
    "hanwhasol": {"code": "009830", "name": "한화솔루션",    "focus": "PVC/가성소다/태양광"},
    "kumho":     {"code": "011780", "name": "금호석유화학",   "focus": "합성고무(BR/SBR)/페놀"},
    "skinno":    {"code": "096770", "name": "SK이노베이션",  "focus": "석유화학/윤활유/E&P"},
    "hyosung":   {"code": "298000", "name": "효성화학",      "focus": "PP/DH/TAC필름"},
}

# ── Historical PE Ranges (석유화학 20Y) ──────────────────────────
PETRO_HISTORICAL_PE: dict[str, dict[str, Any]] = {
    "lgchem":    {"avg": 15.0, "min": 7.0,  "max": 40.0, "peak_range": "25~40 (2020-21 배터리 프리미엄)"},
    "lottechem": {"avg": 10.0, "min": 4.0,  "max": 25.0, "peak_range": "15~25 (2017-18 에틸렌 슈퍼사이클)"},
    "hanwhasol": {"avg": 12.0, "min": 5.0,  "max": 30.0, "peak_range": "20~30 (태양광 호황)"},
    "kumho":     {"avg": 8.0,  "min": 3.0,  "max": 20.0, "peak_range": "12~20 (합성고무 수요 피크)"},
    "skinno":    {"avg": 12.0, "min": 5.0,  "max": 25.0, "peak_range": "15~25 (유가 사이클)"},
}

# ── 피크아웃 지표 ────────────────────────────────────────────────
PETRO_PEAKOUT: dict[str, dict[str, Any]] = {
    "ethylene_spread_qoq":  {"warning": -15.0, "desc": "에틸렌 스프레드 QoQ (%)",   "below": True},
    "ncc_margin_qoq":       {"warning": -3.0,  "desc": "NCC 마진 QoQ (%p)",        "below": True},
    "china_capacity_add":   {"warning": 5.0,   "desc": "중국 신규 캐파 (백만톤/년)", "above": True},
    "utilization_rate":     {"warning": 80,    "desc": "가동률 (%)",                "below": True},
    "pe_vs_avg":            {"warning": 100.0, "desc": "P/E vs 20Y평균 (%)",       "above": True},
    "inventory_days":       {"warning": 45,    "desc": "재고일수 (일)",              "above": True},
}

# ── 수동 입력 지표 ───────────────────────────────────────────────
PETRO_MANUAL_INDICATORS: dict[str, dict[str, Any]] = {
    "china_capacity":    {"name": "중국 증설 위협",       "weight": 25, "desc": "1=증설없음 10=대규모증설",    "inverted": True},
    "green_transition":  {"name": "친환경 전환 압력",     "weight": 20, "desc": "1=현상유지 10=전면전환",      "inverted": False},
    "feedstock_cost":    {"name": "원가 경쟁력",          "weight": 20, "desc": "1=원가열위 10=원가우위",      "inverted": False},
    "demand_recovery":   {"name": "글로벌 수요 회복",     "weight": 20, "desc": "1=침체지속 10=강력회복",      "inverted": False},
    "trade_friction":    {"name": "통상/관세 리스크",     "weight": 15, "desc": "1=자유무역 10=보호무역 심화",  "inverted": True},
}

# ── 시나리오 템플릿 ──────────────────────────────────────────────
PETRO_SCENARIOS: dict[str, dict[str, Any]] = {
    "bull": {
        "label": "Bull (강세)",
        "probability": "25%",
        "score_delta": +15,
        "drivers": [
            "중국 경기 부양 → 석유화학 수요 급반등",
            "에틸렌 스프레드 구조적 회복 (셧다운 효과)",
            "나프타 가격 안정 + 환율 우호적",
        ],
    },
    "base": {
        "label": "Base (기본)",
        "probability": "50%",
        "score_delta": 0,
        "drivers": [
            "중국 증설 소화 진행 (2~3년 과잉 축소)",
            "스프레드 약보합 유지",
            "배터리/첨단소재 부문이 실적 보완",
        ],
    },
    "bear": {
        "label": "Bear (약세)",
        "probability": "25%",
        "score_delta": -20,
        "drivers": [
            "중국 대규모 추가 증설 + 글로벌 경기 침체",
            "에틸렌/PE/PP 스프레드 붕괴",
            "유가 급등 → NCC 원가 압박 + 수요 파괴",
        ],
    },
}

# ── PDF 차트 크기 매핑 ───────────────────────────────────────────
PETRO_CHART_SIZES: dict[str, dict] = {
    "기업 대시보드": {"w": 160, "center": True},
    "스코어 추이":   {"w": 120, "center": True},
    "수요지표 Z-Score": {"w": 110, "center": True},
    "피크아웃 현황":  {"w": 120, "center": True},
}

# ══════════════════════════════════════════════════════════════════
#  CycleConfig 인스턴스
# ══════════════════════════════════════════════════════════════════

PETRO_CONFIG = CycleConfig(
    domain="petrochemical",
    output_dir=OUTPUT_DIR,
    report_dir=REPORT_DIR,
    tier1_indicators=PETRO_TIER1_INDICATORS,
    market_pulse_weights=PETRO_MARKET_PULSE_WEIGHTS,
    cycle_score_weights=PETRO_CYCLE_WEIGHTS,
    manual_indicators=PETRO_MANUAL_INDICATORS,
    peakout_thresholds=PETRO_PEAKOUT,
    historical_pe_ranges=PETRO_HISTORICAL_PE,
    dart_targets=PETRO_DART_TARGETS,
    scenario_templates=PETRO_SCENARIOS,
    kr_tickers=_KR_TICKERS,
    emoji="🧪",
    report_title="석유화학 사이클 분석",
    demand_weight=20,
    cycle_weight=80,
)


# ══════════════════════════════════════════════════════════════════
#  DART 재무제표 수집
# ══════════════════════════════════════════════════════════════════

def _get_dart_api_key() -> str | None:
    if DART_API_KEY_FILE.exists():
        return DART_API_KEY_FILE.read_text().strip()
    return None


def _resolve_corp_codes(api_key: str) -> dict[str, str]:
    """DART 기업 코드 매핑 (캐시)."""
    cache_file = OUTPUT_DIR / ".dart_corp_codes.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    if not HAS_OPENDART:
        log("WARN: OpenDartReader not installed")
        return {}
    try:
        dart = _OpenDartReader(api_key)
        codes = {}
        for key, target in PETRO_DART_TARGETS.items():
            corp_code = dart.find_corp_code(target["code"])
            if corp_code:
                codes[key] = corp_code
                log(f"  {target['name']}: corp_code={corp_code}")
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        save_json_atomic(cache_file, codes)
        return codes
    except Exception as e:
        log(f"ERROR resolving corp codes: {e}")
        return {}


def collect_dart_financials(dry_run: bool = False) -> dict[str, Any]:
    """DART 재무제표 수집 (최근 4분기)."""
    api_key = _get_dart_api_key()
    if not api_key:
        log("DART API key not set")
        return {}
    if not HAS_OPENDART:
        log("WARN: OpenDartReader not installed")
        return {}

    result: dict[str, Any] = {
        "collected_at": datetime.now().isoformat(),
        "companies": {},
    }

    try:
        dart = _OpenDartReader(api_key)
    except Exception as e:
        log(f"ERROR init DART: {e}")
        return result

    now = datetime.now()
    for key, target in PETRO_DART_TARGETS.items():
        stock_code = target["code"]
        comp: dict[str, Any] = {"name": target["name"], "quarters": {}}

        for reprt_code, q_label in DART_REPRT_CODES.items():
            for year_offset in range(2):
                year = now.year - year_offset
                try:
                    fs = dart.finstate(stock_code, year, reprt_code)
                    if fs is None or (hasattr(fs, "empty") and fs.empty):
                        continue
                    q_key = f"{year}{q_label}"
                    q_data: dict[str, Any] = {}
                    for _, row in fs.iterrows():
                        acct = row.get("account_nm", "")
                        val_str = str(row.get("thstrm_amount", "0")).replace(",", "")
                        try:
                            val = int(val_str)
                        except (ValueError, TypeError):
                            continue
                        for field, patterns in DART_ACCOUNT_PATTERNS.items():
                            if any(p in acct for p in patterns):
                                q_data[field] = val
                                break
                    if q_data:
                        comp["quarters"][q_key] = q_data
                except Exception as e:
                    log(f"  DART {target['name']} {year}{q_label}: {e}")

        if comp["quarters"]:
            result["companies"][key] = comp
            log(f"  {target['name']}: {len(comp['quarters'])} quarters")

    if not dry_run:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        save_json_atomic(PETRO_CONFIG.dart_financials_file, result)
        log(f"DART financials saved: {len(result['companies'])} companies")

    return result


# ══════════════════════════════════════════════════════════════════
#  밸류에이션 수집
# ══════════════════════════════════════════════════════════════════

def collect_valuation(dry_run: bool = False) -> dict[str, Any]:
    """KR 종목 밸류에이션 수집 (PER, PBR)."""
    result: dict[str, Any] = {
        "collected_at": datetime.now().isoformat(),
        "stocks": {},
    }
    try:
        from pykrx import stock as krx_stock
        today = datetime.now().strftime("%Y%m%d")
        for key, target in PETRO_DART_TARGETS.items():
            code = target["code"]
            try:
                fund = krx_stock.get_market_cap_by_date(
                    (datetime.now() - timedelta(days=7)).strftime("%Y%m%d"),
                    today, code,
                )
                market_cap = int(fund.iloc[-1].get("시가총액", 0)) if fund is not None and not fund.empty else 0

                val_data = krx_stock.get_market_fundamental_by_date(
                    (datetime.now() - timedelta(days=7)).strftime("%Y%m%d"),
                    today, code,
                )
                per = pbr = None
                if val_data is not None and not val_data.empty:
                    last_v = val_data.iloc[-1]
                    per = float(last_v.get("PER", 0)) or None
                    pbr = float(last_v.get("PBR", 0)) or None

                pe_range = PETRO_HISTORICAL_PE.get(key)
                pe_vs_avg = None
                if per and pe_range:
                    pe_vs_avg = round((per / pe_range["avg"] - 1) * 100, 1)

                result["stocks"][key] = {
                    "name": target["name"], "code": code,
                    "market_cap": market_cap,
                    "per": per, "pbr": pbr,
                    "pe_vs_avg_pct": pe_vs_avg,
                    "pe_range": pe_range,
                }
                log(f"  {target['name']}: PER={per}, PBR={pbr}")
            except Exception as e:
                log(f"  Valuation {target['name']}: {e}")
    except ImportError:
        log("WARN: pykrx not installed, valuation skipped")

    if not dry_run:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        save_json_atomic(PETRO_CONFIG.valuation_file, result)
    return result


# ══════════════════════════════════════════════════════════════════
#  분석 함수
# ══════════════════════════════════════════════════════════════════

def analyze_financial_trends(financials: dict | None) -> dict[str, Any]:
    """QoQ/YoY 매출·마진·순이익 추이 분석."""
    if not financials or not financials.get("companies"):
        return {}
    result: dict[str, Any] = {}
    for key, comp in financials["companies"].items():
        qs = sorted_quarters(comp.get("quarters", {}))
        if len(qs) < 2:
            continue
        latest_key, latest = qs[-1]
        prev_key, prev = qs[-2]
        entry: dict[str, Any] = {"name": comp["name"], "latest_quarter": latest_key}
        entry["revenue"] = latest.get("revenue")
        entry["revenue_qoq"] = qoq_change(latest.get("revenue"), prev.get("revenue"))
        entry["operating_profit"] = latest.get("operating_profit")
        rev = latest.get("revenue")
        op = latest.get("operating_profit")
        entry["op_margin"] = round(op / rev * 100, 1) if (rev and op and rev > 0) else None
        eq = latest.get("total_equity")
        ni = latest.get("net_income")
        entry["roe"] = round(ni / eq * 100, 1) if (eq and ni and eq > 0) else None
        result[key] = entry
    return result


def analyze_valuation_context(valuation: dict | None,
                              financials: dict | None) -> dict[str, Any]:
    """밸류에이션 컨텍스트 분석."""
    if not valuation or not valuation.get("stocks"):
        return {}
    return dict(valuation["stocks"])


def analyze_spread_cycle(indicators: dict | None, fin_trends: dict) -> dict[str, Any]:
    """석유화학 스프레드 사이클 분석.

    에틸렌-나프타 스프레드가 핵심 수익성 지표.
    글로벌 화학주(DOW, LYB) z-score로 스프레드 건강도 추정.
    """
    result: dict[str, Any] = {}
    if indicators:
        chem_zscores = []
        for key in ("dow", "lyb", "basf", "ce"):
            ind = indicators.get(key)
            if ind and "zscore" in ind:
                chem_zscores.append(ind["zscore"])
        if chem_zscores:
            avg_z = sum(chem_zscores) / len(chem_zscores)
            result["global_chem_zscore_avg"] = round(avg_z, 2)
            result["spread_health"] = (
                "healthy" if avg_z > 0.5 else
                "neutral" if avg_z > -0.5 else
                "distressed"
            )
        else:
            result["spread_health"] = "no_data"
    else:
        result["spread_health"] = "no_data"

    # 한국 기업 마진 추이로 NCC 마진 추정
    kr_margins = [ft.get("op_margin") for ft in fin_trends.values() if ft.get("op_margin") is not None]
    if kr_margins:
        avg_margin = sum(kr_margins) / len(kr_margins)
        result["kr_avg_margin"] = round(avg_margin, 1)
        result["ncc_margin_signal"] = (
            "good" if avg_margin > 5 else
            "marginal" if avg_margin > 0 else
            "loss"
        )
    else:
        result["ncc_margin_signal"] = "no_data"

    return result


def compute_peakout_indicators(fin_trends: dict, val_ctx: dict) -> list[dict[str, Any]]:
    """피크아웃 지표 계산."""
    items: list[dict[str, Any]] = []

    # PE vs 평균
    pe_vals = [vc.get("pe_vs_avg_pct") for vc in val_ctx.values() if vc.get("pe_vs_avg_pct") is not None]
    avg_pe_vs = sum(pe_vals) / len(pe_vals) if pe_vals else None
    items.append(peakout_item("pe_vs_avg", avg_pe_vs, PETRO_PEAKOUT))

    # NCC 마진 QoQ (현재 마진 자체를 참고, 히스토리 기반 QoQ는 추후)
    margins = [ft.get("op_margin") for ft in fin_trends.values() if ft.get("op_margin") is not None]
    avg_margin = sum(margins) / len(margins) if margins else None
    items.append(peakout_item("ncc_margin_qoq", avg_margin, PETRO_PEAKOUT))

    # 나머지는 수동/외부 데이터 기반
    for key in ("ethylene_spread_qoq", "china_capacity_add", "utilization_rate", "inventory_days"):
        items.append(peakout_item(key, None, PETRO_PEAKOUT))

    return items


# ══════════════════════════════════════════════════════════════════
#  Cycle Score (4축: Financial + Order + Valuation + Structural)
# ══════════════════════════════════════════════════════════════════

def calculate_cycle_score(fin_trends: dict, val_ctx: dict,
                          manual: dict, indicators: dict | None = None) -> dict[str, Any] | None:
    """4축 Cycle Score → 0~100."""
    axis_scores: dict[str, float | None] = {}
    details: dict[str, Any] = {}

    # ── Financial (0~100) ───
    fin_parts: list[float] = []
    for key, ft in fin_trends.items():
        margin = ft.get("op_margin")
        if margin is not None:
            # 석유화학: 10% 마진이면 우수 (범용화학 저마진 특성)
            fin_parts.append(min(100, max(0, margin / 10 * 100)))
        roe = ft.get("roe")
        if roe is not None:
            fin_parts.append(min(100, max(0, roe / 15 * 100)))
    axis_scores["financial"] = round(sum(fin_parts) / len(fin_parts), 1) if fin_parts else None
    details["financial"] = {"score": axis_scores["financial"], "parts": len(fin_parts)}

    # ── Order (0~100) — 글로벌 화학주 z-score 프록시 ───
    order_parts: list[float] = []
    if indicators:
        for chem_key in ("dow", "lyb", "basf", "ce"):
            ind = indicators.get(chem_key)
            if ind and "zscore" in ind:
                ratio = zscore_to_ratio(ind["zscore"])
                order_parts.append(ratio * 100)
    axis_scores["order"] = round(sum(order_parts) / len(order_parts), 1) if order_parts else None
    details["order"] = {"score": axis_scores["order"], "parts": len(order_parts)}

    # ── Valuation (0~100, inverted) ───
    val_parts: list[float] = []
    for key, vc in val_ctx.items():
        pe_vs = vc.get("pe_vs_avg_pct")
        if pe_vs is not None:
            val_parts.append(max(0, min(100, 100 - (pe_vs + 50) * 0.67)))
    axis_scores["valuation"] = round(sum(val_parts) / len(val_parts), 1) if val_parts else None
    details["valuation"] = {"score": axis_scores["valuation"], "parts": len(val_parts)}

    # ── Structural (수동 지표, 0~100) ───
    scores = dict(manual.get("scores", {}))
    total_w = 0
    weighted = 0.0
    for key, meta in PETRO_MANUAL_INDICATORS.items():
        val = scores.get(key)
        if val is None:
            continue
        ratio = (val - 1) / 9.0
        if meta.get("inverted"):
            ratio = 1.0 - ratio
        contrib = ratio * meta["weight"]
        weighted += contrib
        total_w += meta["weight"]
    if total_w > 0:
        axis_scores["structural"] = round(weighted / total_w * 100, 1)
    else:
        axis_scores["structural"] = None
    details["structural"] = {"score": axis_scores["structural"]}

    # ── 가중 합산 ───
    total_weight = 0
    total_score = 0.0
    for axis, weight in PETRO_CYCLE_WEIGHTS.items():
        if axis == "demand":
            continue
        s = axis_scores.get(axis)
        if s is not None:
            total_score += s * weight
            total_weight += weight
    if total_weight == 0:
        return None
    score = round(total_score / total_weight, 1)
    return {
        "score": score, "axis_scores": axis_scores, "details": details,
        "axes_used": sum(1 for v in axis_scores.values() if v is not None),
        "axes_total": len(axis_scores),
    }


# ══════════════════════════════════════════════════════════════════
#  리포트 빌드
# ══════════════════════════════════════════════════════════════════

def build_petro_report(data: dict, pulse: dict, cycle: dict | None,
                       combined: dict, fin_trends: dict, val_ctx: dict,
                       peakout: list, spread_cycle: dict,
                       manual: dict) -> str:
    """석유화학 전용 마크다운 리포트 빌드."""
    now = datetime.now(KST)
    date_str = now.strftime("%Y-%m-%d")
    phase_score = combined.get("combined") or pulse["score"]
    pc, pd = determine_cycle_phase(phase_score)

    L: list[str] = []
    L.append(f"# 석유화학 사이클 분석 리포트")
    L.append(f"> {date_str} | v1.0 | 5축 스코어링 기반\n")

    # 1. 종합 판정
    L.append("## 1. 종합 판정\n")
    L.append("| 항목 | 값 |")
    L.append("|------|------|")
    L.append(f"| 종합 점수 | **{phase_score:.1f}/100** |")
    L.append(f"| 사이클 위상 | **{pc}** ({pd}) |")
    L.append(f"| Demand (Market Pulse) | {pulse['score']:.1f}/100 |")
    cs_str = f"{cycle['score']:.1f}/100" if cycle else "데이터 부족"
    L.append(f"| Cycle Score | {cs_str} |")
    L.append(f"| 산출 방식 | {combined.get('note', '')} |")
    L.append("")

    # 2. 5축 분석
    L.append("## 2. 5축 분석\n")
    if cycle and cycle.get("axis_scores"):
        L.append("| 축 | 점수 | 가중치 |")
        L.append("|------|------|--------|")
        for axis, weight in PETRO_CYCLE_WEIGHTS.items():
            if axis == "demand":
                s = pulse["score"]
            else:
                s = cycle["axis_scores"].get(axis)
            s_str = f"{s:.1f}" if s is not None else "N/A"
            L.append(f"| {axis} | {s_str} | {weight}% |")
        L.append("")

    # 3. 스프레드 사이클
    L.append("## 3. 스프레드 사이클\n")
    L.append(f"- 글로벌 화학주 Z-Score 평균: {spread_cycle.get('global_chem_zscore_avg', 'N/A')}")
    L.append(f"- 스프레드 건강도: **{spread_cycle.get('spread_health', 'N/A')}**")
    L.append(f"- 한국 기업 평균 마진: {spread_cycle.get('kr_avg_margin', 'N/A')}%")
    L.append(f"- NCC 마진 신호: **{spread_cycle.get('ncc_margin_signal', 'N/A')}**")
    L.append("")

    # 4. 기업별 실적
    L.append("## 4. 기업별 실적\n")
    if fin_trends:
        L.append("| 기업 | 분기 | 매출 QoQ | 영업이익률 | ROE |")
        L.append("|------|------|----------|-----------|-----|")
        for key, ft in fin_trends.items():
            name = ft.get("name", key)
            q = ft.get("latest_quarter", "")
            rev_qoq = f"{ft['revenue_qoq']:.1f}%" if ft.get("revenue_qoq") is not None else "N/A"
            margin = f"{ft['op_margin']:.1f}%" if ft.get("op_margin") is not None else "N/A"
            roe = f"{ft['roe']:.1f}%" if ft.get("roe") is not None else "N/A"
            L.append(f"| {name} | {q} | {rev_qoq} | {margin} | {roe} |")
        L.append("")

    # 5. 밸류에이션
    L.append("## 5. 밸류에이션\n")
    if val_ctx:
        L.append("| 기업 | PER | PBR | vs 20Y 평균 |")
        L.append("|------|-----|-----|------------|")
        for key, vc in val_ctx.items():
            name = vc.get("name", key)
            per = f"{vc['per']:.1f}" if vc.get("per") else "N/A"
            pbr = f"{vc['pbr']:.2f}" if vc.get("pbr") else "N/A"
            vs_avg = f"{vc['pe_vs_avg_pct']:+.1f}%" if vc.get("pe_vs_avg_pct") is not None else "N/A"
            L.append(f"| {name} | {per} | {pbr} | {vs_avg} |")
        L.append("")

    # 6. 피크아웃 지표
    L.append("## 6. 피크아웃 지표\n")
    L.append("| 지표 | 값 | 임계값 | 상태 |")
    L.append("|------|------|--------|------|")
    for p in peakout:
        val = f"{p['value']:.1f}" if p.get("value") is not None else "N/A"
        L.append(f"| {p['desc']} | {val} | {p['warning']} | {p['status']} |")
    L.append("")

    # 7. 수동 지표
    L.append("## 7. 구조적 평가 (수동 지표)\n")
    ms = manual.get("scores", {})
    L.append("| 지표 | 값 | 설명 |")
    L.append("|------|------|------|")
    for key, meta in PETRO_MANUAL_INDICATORS.items():
        val = ms.get(key)
        val_str = f"{val:.0f}" if val else "미입력"
        inv = " (역)" if meta.get("inverted") else ""
        L.append(f"| {meta['name']}{inv} | {val_str}/10 | {meta['desc']} |")
    L.append("")

    # 8. 시나리오
    L.append("## 8. 시나리오 분석\n")
    L.append("| 시나리오 | 확률 | 예상점수 | 위상 | 주요 동인 |")
    L.append("|----------|------|----------|------|-----------|")
    for key in ("bull", "base", "bear"):
        tmpl = PETRO_SCENARIOS[key]
        est_score = max(0, min(100, phase_score + tmpl["score_delta"]))
        est_pc, _ = determine_cycle_phase(est_score)
        drivers_str = " / ".join(tmpl["drivers"][:2])
        L.append(f"| {tmpl['label']} | {tmpl['probability']} | {est_score:.0f}/100 | {est_pc} | {drivers_str} |")
    L.append("")

    # 9. 수요 지표 상세
    L.append("## 9. Tier 1 수요 지표\n")
    indicators = data.get("indicators", {})
    if indicators:
        L.append("| 지표 | 종가 | 변동 | Z-Score | 카테고리 |")
        L.append("|------|------|------|---------|----------|")
        for key, ind in sorted(indicators.items()):
            L.append(f"| {ind['name']} | {ind['close']:.2f} | {ind['change_pct']:+.1f}% | {ind['zscore']:+.2f} | {ind['category']} |")
    L.append("")

    return "\n".join(L)


# ══════════════════════════════════════════════════════════════════
#  차트 생성
# ══════════════════════════════════════════════════════════════════

def _chart_score_history(combined: dict, cycle: dict | None,
                         date_str: str) -> Path | None:
    """스코어 추이 차트."""
    history = load_score_history(PETRO_CONFIG)
    if len(history) < 2:
        return None
    try:
        plt = setup_chart_env()
        fig, ax = plt.subplots(figsize=(10, 5))
        dates = [h.get("date", "") for h in history]
        scores = [h.get("combined") or h.get("market_pulse", 0) for h in history]
        ax.plot(dates, scores, "b-o", markersize=4, label="Combined")
        pulses = [h.get("market_pulse", 0) for h in history]
        ax.plot(dates, pulses, "g--", alpha=0.6, label="Market Pulse")
        ax.set_ylim(0, 100)
        ax.set_ylabel("Score")
        ax.set_title(f"석유화학 사이클 스코어 추이 ({date_str})")
        ax.legend()
        ax.tick_params(axis="x", rotation=45)
        fig.tight_layout()
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        out = CHART_DIR / f"{date_str}_score_history.png"
        fig.savefig(out, dpi=120)
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart score history error: {e}")
        return None


def _chart_demand_zscore(indicators: dict, date_str: str) -> Path | None:
    """수요 지표 Z-Score 차트."""
    scored = {k: indicators[k] for k in PETRO_MARKET_PULSE_WEIGHTS if k in indicators}
    if not scored:
        return None
    try:
        plt = setup_chart_env()
        fig, ax = plt.subplots(figsize=(10, 5))
        names = [ind["name"] for ind in scored.values()]
        zscores = [ind["zscore"] for ind in scored.values()]
        colors = ["green" if z >= 0 else "red" for z in zscores]
        ax.barh(names, zscores, color=colors, alpha=0.7)
        ax.axvline(x=0, color="black", linewidth=0.5)
        ax.set_xlabel("Z-Score")
        ax.set_title(f"석유화학 수요 지표 Z-Score ({date_str})")
        fig.tight_layout()
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        out = CHART_DIR / f"{date_str}_demand_zscore.png"
        fig.savefig(out, dpi=120)
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart demand zscore error: {e}")
        return None


def _chart_peakout_gauge(peakout: list, date_str: str) -> Path | None:
    """피크아웃 현황 차트."""
    valid = [p for p in peakout if p.get("value") is not None]
    if not valid:
        return None
    try:
        plt = setup_chart_env()
        fig, ax = plt.subplots(figsize=(8, 5))
        descs = [p["desc"] for p in valid]
        values = [p["value"] for p in valid]
        warnings = [p["warning"] for p in valid]
        statuses = [p["status"] for p in valid]
        colors = ["red" if s == "WARNING" else "green" for s in statuses]
        y_pos = range(len(descs))
        ax.barh(y_pos, values, color=colors, alpha=0.7)
        for i, w in enumerate(warnings):
            ax.plot(w, i, "k|", markersize=15, markeredgewidth=2)
        ax.set_yticks(y_pos)
        ax.set_yticklabels(descs)
        ax.set_title(f"석유화학 피크아웃 지표 ({date_str})")
        fig.tight_layout()
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        out = CHART_DIR / f"{date_str}_peakout.png"
        fig.savefig(out, dpi=120)
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart peakout error: {e}")
        return None


def _chart_company_dashboard(val_ctx: dict, fin_trends: dict,
                              date_str: str) -> Path | None:
    """기업 대시보드 차트."""
    if not fin_trends:
        return None
    try:
        plt = setup_chart_env()
        n = len(fin_trends)
        cols = min(n, 4)
        fig, axes = plt.subplots(1, cols, figsize=(4 * cols, 5))
        if cols == 1:
            axes = [axes]

        for i, (key, ft) in enumerate(list(fin_trends.items())[:4]):
            ax = axes[i]
            metrics = ["Margin", "ROE"]
            vals = [ft.get("op_margin") or 0, ft.get("roe") or 0]
            ax.bar(metrics, vals, color=["steelblue", "darkorange"])
            ax.set_title(ft.get("name", key), fontsize=10)
            ax.set_ylabel("%")

        fig.suptitle(f"석유화학 기업 대시보드 ({date_str})", fontsize=13)
        fig.tight_layout(rect=[0, 0, 1, 0.95])
        CHART_DIR.mkdir(parents=True, exist_ok=True)
        out = CHART_DIR / f"{date_str}_company_dashboard.png"
        fig.savefig(out, dpi=120)
        plt.close(fig)
        return out
    except Exception as e:
        log(f"Chart company dashboard error: {e}")
        return None


def generate_charts(data: dict, pulse: dict, combined: dict,
                    cycle: dict | None, fin_trends: dict, val_ctx: dict,
                    peakout: list, indicators: dict) -> list[tuple[Path, str]]:
    """차트 생성. [(path, caption), ...] 반환."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    CHART_DIR.mkdir(parents=True, exist_ok=True)
    results: list[tuple[Path, str]] = []

    chart_specs = [
        ("스코어 추이", lambda: _chart_score_history(combined, cycle, date_str)),
        ("기업 대시보드", lambda: _chart_company_dashboard(val_ctx, fin_trends, date_str)),
        ("수요지표 Z-Score", lambda: _chart_demand_zscore(indicators, date_str)),
        ("피크아웃 현황", lambda: _chart_peakout_gauge(peakout, date_str)),
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
#  CLI 명령
# ══════════════════════════════════════════════════════════════════

def collect_all(dry_run: bool = False) -> dict[str, Any]:
    """전체 데이터 수집."""
    log("=== 석유화학 사이클 데이터 수집 시작 ===")
    result = collect_tier1_generic(PETRO_CONFIG, dry_run=dry_run, log=log)
    collect_dart_financials(dry_run=dry_run)
    collect_valuation(dry_run=dry_run)
    log(f"=== 수집 완료: {len(result.get('indicators', {}))} Tier 1 지표 ===")
    return result


def show_status() -> None:
    """현재 상태 출력."""
    data = load_json_safe(PETRO_CONFIG.output_dir / "latest_data.json")
    manual = load_manual_indicators(PETRO_CONFIG)
    financials = load_json_safe(PETRO_CONFIG.dart_financials_file)
    valuation = load_json_safe(PETRO_CONFIG.valuation_file)

    print("=== 석유화학 사이클 트래커 v1.0 ===\n")

    if data and data.get("indicators"):
        indicators = data["indicators"]
        pulse = calculate_market_pulse_generic(indicators, PETRO_MARKET_PULSE_WEIGHTS)
        print(f"마지막 수집: {data.get('date')} ({len(indicators)}/{len(PETRO_TIER1_INDICATORS)} 지표)")
        print(f"Demand (Market Pulse): {pulse['score']:.1f}/100")
    else:
        print("수집 데이터 없음. --collect 실행 필요\n")
        return

    if financials and financials.get("companies"):
        print(f"\nDART 재무제표: {len(financials['companies'])}사")
        for key, comp in financials["companies"].items():
            print(f"  {comp['name']}: {len(comp.get('quarters', {}))} 분기")

    if valuation and valuation.get("stocks"):
        print(f"\n밸류에이션: {len(valuation['stocks'])}사")

    ms = manual.get("scores", {})
    print(f"\n수동 지표: {len(ms)}/{len(PETRO_MANUAL_INDICATORS)}")
    for k, m in PETRO_MANUAL_INDICATORS.items():
        v = ms.get(k)
        print(f"  {m['name']}: {v if v else '미입력'} ({m['desc']})")

    indicators = data["indicators"]
    pulse = calculate_market_pulse_generic(indicators, PETRO_MARKET_PULSE_WEIGHTS)
    fin_trends = analyze_financial_trends(financials)
    val_ctx = analyze_valuation_context(valuation, financials)
    cycle = calculate_cycle_score(fin_trends, val_ctx, manual, indicators)
    combined = calculate_combined_score(pulse, cycle,
                                         demand_pct=PETRO_CONFIG.demand_weight,
                                         cycle_pct=PETRO_CONFIG.cycle_weight)
    s = combined.get("combined") or pulse["score"]
    pc, pd = determine_cycle_phase(s)
    label = "Combined" if combined.get("combined") else "Demand"
    print(f"\n>> {label}: {s:.1f}/100 [{pc}] {pd}")


def generate_report(notify: bool = False, dry_run: bool = False) -> dict[str, Any]:
    """리포트 생성."""
    data = load_json_safe(PETRO_CONFIG.output_dir / "latest_data.json")
    if not data or not data.get("indicators"):
        log("ERROR: No data")
        return {"error": "no data"}

    indicators = data["indicators"]
    manual = load_manual_indicators(PETRO_CONFIG)
    financials = load_json_safe(PETRO_CONFIG.dart_financials_file)
    valuation = load_json_safe(PETRO_CONFIG.valuation_file)

    pulse = calculate_market_pulse_generic(indicators, PETRO_MARKET_PULSE_WEIGHTS)
    fin_trends = analyze_financial_trends(financials)
    val_ctx = analyze_valuation_context(valuation, financials)
    spread_cycle = analyze_spread_cycle(indicators, fin_trends)
    peakout = compute_peakout_indicators(fin_trends, val_ctx)
    cycle = calculate_cycle_score(fin_trends, val_ctx, manual, indicators)
    combined = calculate_combined_score(pulse, cycle,
                                         demand_pct=PETRO_CONFIG.demand_weight,
                                         cycle_pct=PETRO_CONFIG.cycle_weight)

    now = datetime.now()
    week = now.isocalendar()[1]
    year = now.isocalendar()[0]
    date_str = now.strftime("%Y-%m-%d")

    report = build_petro_report(data, pulse, cycle, combined, fin_trends, val_ctx,
                                 peakout, spread_cycle, manual)

    if not dry_run:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (REPORT_DIR / f"week_{year}-{week:02d}.md").write_text(report)
        VAULT_REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (VAULT_REPORT_DIR / f"petrochemical-cycle-{year}-W{week:02d}.md").write_text(report)
        append_score_history(PETRO_CONFIG, week, year, combined, pulse, cycle)
        append_peakout_history(PETRO_CONFIG, peakout)
        log(f"Report saved (week {week})")
    else:
        print(report)

    charts: list[tuple[Path, str]] = []
    pdf_path: Path | None = None

    if notify or not dry_run:
        send_progress_dm("석유화학 사이클 리포트 v1.0 생성 시작...", dry_run, log)

        try:
            charts = generate_charts(data, pulse, combined, cycle, fin_trends, val_ctx,
                                      peakout, indicators)
            send_progress_dm(f"차트 {len(charts)}종 생성 완료", dry_run, log)
        except Exception as e:
            log(f"Chart generation failed: {e}")

        try:
            pdf_path = build_pdf_report_generic(
                report, charts, date_str, PETRO_CONFIG,
                chart_sizes=PETRO_CHART_SIZES, log=log,
            )
            if pdf_path:
                send_progress_dm(f"PDF 빌드 완료 ({pdf_path.stat().st_size // 1024}KB)", dry_run, log)
        except Exception as e:
            log(f"PDF build failed: {e}")

    if notify:
        if pdf_path and pdf_path.exists():
            phase_score = combined.get("combined") or pulse["score"]
            pc, pd = determine_cycle_phase(phase_score)
            caption = f"석유화학 사이클 분석 W{week} | {pc} {phase_score:.0f}/100 | {date_str}"
            send_telegram_pdf_generic(pdf_path, caption, dry_run=dry_run, log=log)
            send_progress_dm("PDF 리포트 전송 완료", dry_run, log)
        else:
            if not dry_run:
                send_dm_chunked(report)
            send_progress_dm("PDF 실패, 텍스트 fallback 전송", dry_run, log)

    phase_score = combined.get("combined") or pulse["score"]
    pc, _ = determine_cycle_phase(phase_score)
    return {
        "status": "ok", "market_pulse": pulse["score"],
        "cycle_score": cycle["score"] if cycle else None,
        "combined": combined.get("combined"), "phase": pc,
        "charts": len(charts), "pdf": str(pdf_path) if pdf_path else None,
    }


def main():
    parser = argparse.ArgumentParser(description="석유화학 사이클 지표 추적")
    parser.add_argument("--collect", action="store_true", help="데이터 수집")
    parser.add_argument("--report", action="store_true", help="주간 리포트")
    parser.add_argument("--notify", action="store_true", help="Telegram DM")
    parser.add_argument("--manual-update", nargs="+", metavar="K=V", help="수동 지표 (1~10)")
    parser.add_argument("--status", action="store_true", help="현재 상태")
    parser.add_argument("--setup", action="store_true", help="DART 초기 설정")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    args = parser.parse_args()

    if not any([args.collect, args.report, args.manual_update, args.status, args.setup]):
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
        update_manual(PETRO_CONFIG, args.manual_update, log=log)
    if args.collect:
        collect_all(dry_run=args.dry_run)
    if args.report:
        result = generate_report(notify=args.notify, dry_run=args.dry_run)
        if "error" not in result:
            log(f"Report: pulse={result['market_pulse']}, phase={result['phase']}")
    if args.status:
        show_status()


if __name__ == "__main__":
    main()
