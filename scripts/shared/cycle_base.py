"""shared/cycle_base.py — 산업 사이클 분석 공통 베이스 모듈.

shipbuilding_cycle_tracker.py에서 도메인 무관 로직을 추출.
반도체, 석유화학, 인프라 등 다양한 산업 사이클 트래커에서 재사용.

Usage:
    from shared.cycle_base import CycleConfig, compute_zscore_entry, ...
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ── 선택적 라이브러리 ─────────────────────────────────────────────
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

KST = timezone(timedelta(hours=9))

# ── 사이클 Phase (공통) ──────────────────────────────────────────
CYCLE_PHASES: list[tuple[int, int, str, str]] = [
    (0,  25, "TROUGH",         "불황"),
    (26, 45, "EARLY_RECOVERY", "초기 회복"),
    (46, 65, "EXPANSION",      "확장"),
    (66, 85, "PEAK",           "피크"),
    (86, 100, "OVERHEATING",   "과열"),
]


# ══════════════════════════════════════════════════════════════════
#  CycleConfig — 도메인별 설정 구조
# ══════════════════════════════════════════════════════════════════

@dataclass
class CycleConfig:
    """각 산업 사이클 트래커가 오버라이드할 설정."""
    domain: str                                     # "shipbuilding", "semiconductor", ...
    output_dir: Path                                # memory/{domain}-indicators/
    report_dir: Path                                # memory/{domain}-indicators/reports/
    tier1_indicators: dict[str, dict[str, str]]     # 도메인별 Tier 1 지표
    market_pulse_weights: dict[str, int]            # 도메인별 가중치
    cycle_score_weights: dict[str, int]             # 5축 가중치
    manual_indicators: dict[str, dict[str, Any]]    # 수동 입력 지표
    peakout_thresholds: dict[str, dict[str, Any]]   # 피크아웃 임계값
    historical_pe_ranges: dict[str, dict[str, Any]] # 20Y PE 레인지
    dart_targets: dict[str, dict[str, str]]         # DART 대상 기업
    scenario_templates: dict[str, dict[str, Any]]   # Bull/Base/Bear
    kr_tickers: set[str]                            # 한국 종목 키 (pykrx 수집용)
    emoji: str = "📊"                               # 도메인 이모지
    report_title: str = "산업 사이클 분석"            # 리포트 타이틀
    demand_weight: int = 15                         # Combined 계산 시 demand %
    cycle_weight: int = 85                          # Combined 계산 시 cycle %
    score_history_max: int = 260                    # 히스토리 최대 건수
    peakout_history_max: int = 52                   # 피크아웃 히스토리 최대
    chart_dir_name: str = "charts"

    # derived paths
    @property
    def manual_file(self) -> Path:
        return self.output_dir / "manual_indicators.json"

    @property
    def score_history_file(self) -> Path:
        return self.output_dir / "score_history.json"

    @property
    def peakout_history_file(self) -> Path:
        return self.output_dir / "peakout_history.json"

    @property
    def chart_dir(self) -> Path:
        return self.output_dir / self.chart_dir_name

    @property
    def dart_financials_file(self) -> Path:
        return self.output_dir / "dart_financials.json"

    @property
    def valuation_file(self) -> Path:
        return self.output_dir / "valuation.json"

    @property
    def report_data_dir(self) -> Path:
        return self.output_dir / "report_data"


# ══════════════════════════════════════════════════════════════════
#  JSON 유틸리티
# ══════════════════════════════════════════════════════════════════

def load_json_safe(path: Path, default: Any = None) -> Any:
    """JSON 로드 with fallback. 파일 없음/파싱 실패 시 default 반환."""
    if not path.exists():
        return default if default is not None else {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default if default is not None else {}


def save_json_atomic(path: Path, data: Any) -> None:
    """원자적 JSON 저장 — temp 파일에 쓴 후 rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, ensure_ascii=False, indent=2)
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        os.write(fd, content.encode("utf-8"))
        os.close(fd)
        os.replace(tmp_path, str(path))
    except Exception:
        os.close(fd) if not os.get_inheritable(fd) else None
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


# ══════════════════════════════════════════════════════════════════
#  Z-Score 계산
# ══════════════════════════════════════════════════════════════════

def compute_zscore_entry(series, meta: dict) -> dict[str, Any] | None:
    """Close 시계열 → z-score 엔트리. 5개 미만이면 None.

    Args:
        series: pandas Series (Close 가격 시계열)
        meta: {"ticker": ..., "name": ..., "category": ...}
    """
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


# ══════════════════════════════════════════════════════════════════
#  데이터 수집
# ══════════════════════════════════════════════════════════════════

def fetch_kr_ohlcv(ticker_6: str, days: int = 520, log=None):
    """pykrx로 KR 종목 OHLCV 수집. 실패 시 None."""
    if not HAS_PYKRX:
        return None
    try:
        end = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")
        df = krx_stock.get_market_ohlcv_by_date(start, end, ticker_6)
        if df is not None and not df.empty:
            df = df.rename(columns={"종가": "Close", "시가": "Open", "고가": "High",
                                     "저가": "Low", "거래량": "Volume"})
            return df
    except Exception as e:
        if log:
            log(f"  pykrx error {ticker_6}: {e}")
    return None


def fetch_global_ohlcv(ticker: str, days: int = 520, log=None):
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
        if log:
            log(f"  FDR error {ticker}: {e}")
    return None


def collect_tier1_generic(config: CycleConfig, dry_run: bool = False,
                          log=None) -> dict[str, Any]:
    """Tier 1 수집: pykrx(KR) + FDR(글로벌) + yfinance(fallback) + zscore 계산.

    도메인 CycleConfig의 tier1_indicators와 kr_tickers를 사용.
    """
    _log = log or (lambda msg, **kw: None)
    today = datetime.now().strftime("%Y-%m-%d")
    result: dict[str, Any] = {
        "date": today,
        "collected_at": datetime.now().isoformat(),
        "indicators": {},
    }

    fetched_keys: set[str] = set()
    for key, meta in config.tier1_indicators.items():
        ticker = meta["ticker"]
        df = None
        if key in config.kr_tickers:
            ticker_6 = ticker.replace(".KS", "")
            df = fetch_kr_ohlcv(ticker_6, log=_log)
            if df is None:
                df = fetch_global_ohlcv(ticker_6, log=_log)
        else:
            df = fetch_global_ohlcv(ticker, log=_log)
        if df is not None and "Close" in df.columns:
            entry = compute_zscore_entry(df["Close"], meta)
            if entry:
                result["indicators"][key] = entry
                fetched_keys.add(key)
                _log(f"  {key}: {entry['close']:.2f} (z={entry['zscore']:.2f})")

    # yfinance fallback
    missing = set(config.tier1_indicators.keys()) - fetched_keys
    if missing:
        _log(f"Fallback yfinance for {len(missing)} tickers: {missing}")
        try:
            import yfinance as yf
            tickers_yf = [config.tier1_indicators[k]["ticker"] for k in missing]
            data = yf.download(tickers_yf, period="2y", progress=False, threads=True)
            close_data = data.get("Close", data) if hasattr(data, "get") else data
            for key in missing:
                meta = config.tier1_indicators[key]
                try:
                    series = close_data[meta["ticker"]].dropna() if meta["ticker"] in close_data.columns else None
                    if series is not None:
                        entry = compute_zscore_entry(series, meta)
                        if entry:
                            result["indicators"][key] = entry
                            _log(f"  {key} (yf): {entry['close']:.2f} (z={entry['zscore']:.2f})")
                except Exception as e:
                    _log(f"  ERROR {key}: {e}")
        except ImportError:
            _log("WARN: yfinance not installed, some tickers skipped")

    # 저장
    if not dry_run:
        config.output_dir.mkdir(parents=True, exist_ok=True)
        save_json_atomic(config.output_dir / "latest_data.json", result)
        _log(f"Tier 1 saved: {len(result['indicators'])}/{len(config.tier1_indicators)}")
    else:
        _log(f"DRY-RUN: {len(result['indicators'])}/{len(config.tier1_indicators)} collected")

    return result


# ══════════════════════════════════════════════════════════════════
#  Z-Score → 정규화 변환
# ══════════════════════════════════════════════════════════════════

def zscore_to_ratio(zscore: float) -> float:
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


def zscore_to_1_10(zscore: float) -> float:
    """z-score → 1~10 선형 매핑. z=-2→1, z=0→5.5, z=+2→10."""
    return round(max(1.0, min(10.0, 5.5 + zscore * 2.25)), 1)


# ══════════════════════════════════════════════════════════════════
#  Market Pulse (가중평균 스코어)
# ══════════════════════════════════════════════════════════════════

def calculate_market_pulse_generic(indicators: dict[str, Any],
                                   weights: dict[str, int]) -> dict[str, Any]:
    """Tier 1 → Market Pulse (0~100). 가중평균 기반."""
    total_w = 0
    weighted = 0.0
    details: dict[str, Any] = {}
    for key, weight in weights.items():
        ind = indicators.get(key)
        if not ind or "zscore" not in ind:
            continue
        ratio = zscore_to_ratio(ind["zscore"])
        contrib = ratio * weight
        weighted += contrib
        total_w += weight
        details[key] = {
            "zscore": ind["zscore"], "ratio": ratio,
            "contribution": round(contrib, 1), "weight": weight,
        }
    score = (weighted / total_w * 100) if total_w > 0 else 0.0
    return {
        "score": round(score, 1),
        "indicators_used": len(details),
        "indicators_total": len(weights),
        "details": details,
    }


# ══════════════════════════════════════════════════════════════════
#  Combined Score + Phase 판정
# ══════════════════════════════════════════════════════════════════

def calculate_combined_score(pulse: dict, cycle: dict | None,
                             demand_pct: int = 15,
                             cycle_pct: int = 85) -> dict[str, Any]:
    """Demand(Market Pulse) + Cycle Score = Combined."""
    ps = pulse["score"]
    if cycle is None:
        return {
            "combined": None, "market_pulse": ps, "cycle_score": None,
            "method": "market_pulse_only",
            "note": "Cycle Score 데이터 부족",
        }
    cs = cycle["score"]
    combined = round(ps * (demand_pct / 100) + cs * (cycle_pct / 100), 1)
    return {
        "combined": combined, "market_pulse": ps, "cycle_score": cs,
        "method": "combined",
        "note": f"Demand {demand_pct}%({ps:.0f}) + Cycle {cycle_pct}%({cs:.0f})",
    }


def determine_cycle_phase(score: float) -> tuple[str, str]:
    """점수 → 5단계 위상 판정."""
    for lo, hi, code, desc in CYCLE_PHASES:
        if lo <= score <= hi:
            return code, desc
    return "UNKNOWN", "판정 불가"


# ══════════════════════════════════════════════════════════════════
#  히스토리 관리
# ══════════════════════════════════════════════════════════════════

def append_score_history(config: CycleConfig, week: int, year: int,
                         combined: dict, pulse: dict,
                         cycle: dict | None) -> None:
    """스코어 히스토리에 주간 엔트리 append (circular buffer)."""
    history: list[dict[str, Any]] = load_json_safe(config.score_history_file, [])
    if not isinstance(history, list):
        history = []

    week_tag = f"{year}-W{week:02d}"
    entry: dict[str, Any] = {
        "date": datetime.now(KST).strftime("%Y-%m-%d"),
        "week_tag": week_tag,
        "year": year, "week": week,
        "combined": combined.get("combined"),
        "market_pulse": pulse.get("score"),
        "cycle_score": combined.get("cycle_score"),
        "pulse_details": pulse.get("details", {}),
    }
    # week_tag 기반 upsert
    history = [h for h in history if not (h.get("year") == year and h.get("week") == week)]
    history.append(entry)
    if len(history) > config.score_history_max:
        history = history[-config.score_history_max:]

    config.output_dir.mkdir(parents=True, exist_ok=True)
    save_json_atomic(config.score_history_file, history)


def append_peakout_history(config: CycleConfig,
                           peakout: list[dict[str, Any]]) -> None:
    """피크아웃 히스토리에 주간 스냅샷 append (circular buffer)."""
    existing: list[dict[str, Any]] = load_json_safe(config.peakout_history_file, [])
    if not isinstance(existing, list):
        existing = []

    date_str = datetime.now(KST).strftime("%Y-%m-%d")
    snapshot: dict[str, Any] = {"date": date_str}
    for p in peakout:
        key = p.get("key", p.get("desc", "")[:10])
        snapshot[key] = p.get("value")
    existing = [h for h in existing if h.get("date") != date_str]
    existing.append(snapshot)
    if len(existing) > config.peakout_history_max:
        existing = existing[-config.peakout_history_max:]

    config.output_dir.mkdir(parents=True, exist_ok=True)
    save_json_atomic(config.peakout_history_file, existing)


def load_score_history(config: CycleConfig) -> list[dict[str, Any]]:
    """스코어 히스토리 로드."""
    data = load_json_safe(config.score_history_file, [])
    return data if isinstance(data, list) else []


def load_peakout_history(config: CycleConfig) -> list[dict[str, Any]]:
    """피크아웃 히스토리 로드."""
    data = load_json_safe(config.peakout_history_file, [])
    return data if isinstance(data, list) else []


# ══════════════════════════════════════════════════════════════════
#  수동 지표 관리
# ══════════════════════════════════════════════════════════════════

def load_manual_indicators(config: CycleConfig) -> dict[str, Any]:
    """수동 지표 로드."""
    return load_json_safe(config.manual_file, {"scores": {}, "updated_at": None})


def save_manual_indicators(config: CycleConfig, data: dict) -> None:
    """수동 지표 저장."""
    data["updated_at"] = datetime.now(KST).isoformat()
    save_json_atomic(config.manual_file, data)


def update_manual(config: CycleConfig, kv_list: list[str], log=None) -> None:
    """CLI --manual-update key=value 처리."""
    _log = log or (lambda msg, **kw: None)
    manual = load_manual_indicators(config)
    scores = manual.get("scores", {})
    for item in kv_list:
        if "=" not in item:
            _log(f"SKIP: {item} (key=value 형식 아님)")
            continue
        key, val = item.split("=", 1)
        if key not in config.manual_indicators:
            _log(f"SKIP: {key} (유효하지 않은 지표)")
            continue
        try:
            v = float(val)
            v = max(1.0, min(10.0, v))
            scores[key] = v
            _log(f"  {key} = {v}")
        except ValueError:
            _log(f"SKIP: {val} (숫자 아님)")
    manual["scores"] = scores
    save_manual_indicators(config, manual)


# ══════════════════════════════════════════════════════════════════
#  피크아웃 판정 유틸
# ══════════════════════════════════════════════════════════════════

def peakout_item(key: str, value: float | None,
                 thresholds: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """단일 피크아웃 항목 생성."""
    thresh = thresholds.get(key, {})
    warning_val = thresh.get("warning", 0)
    desc = thresh.get("desc", key)
    if value is None:
        return {"key": key, "desc": desc, "value": None, "status": "N/A", "warning": warning_val}
    if thresh.get("above"):
        triggered = value >= warning_val
    elif thresh.get("below"):
        triggered = value <= warning_val
    else:
        triggered = value <= warning_val
    return {
        "key": key, "desc": desc, "value": round(value, 2),
        "status": "WARNING" if triggered else "OK",
        "warning": warning_val,
    }


# ══════════════════════════════════════════════════════════════════
#  텔레그램 유틸
# ══════════════════════════════════════════════════════════════════

def send_progress_dm(msg: str, dry_run: bool = False, log=None) -> None:
    """진행 보고 DM 전송 (shared telegram 경유)."""
    _log = log or (lambda m, **kw: None)
    if dry_run:
        _log(f"DRY-RUN progress: {msg}")
        return
    try:
        from shared.telegram import send_dm
        send_dm(msg, level="critical")
    except Exception:
        pass


def send_telegram_pdf_generic(pdf_path: Path, caption: str,
                              dry_run: bool = False, log=None) -> bool:
    """sendDocument API로 PDF 전송."""
    _log = log or (lambda m, **kw: None)
    if dry_run:
        _log(f"DRY-RUN: skip PDF send ({pdf_path.name})")
        return True
    try:
        from shared.telegram import send_document, DM_CHAT_ID
        ok = send_document(str(DM_CHAT_ID), str(pdf_path), caption=caption)
        if ok:
            _log(f"PDF sent to DM")
        return ok
    except Exception as e:
        _log(f"PDF send error: {e}")
        return False


# ══════════════════════════════════════════════════════════════════
#  PDF 빌드 (fpdf2 기반)
# ══════════════════════════════════════════════════════════════════

def find_korean_font() -> str | None:
    """시스템에서 한글 TTC/TTF 폰트 경로 반환."""
    candidates = [
        "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/7a0b5c0f3c1d41c4c52a33343496c9c65ad52c50.asset/AssetData/NanumGothic.ttc",
        "/Library/Fonts/NanumGothic.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    ]
    for p in candidates:
        if Path(p).exists():
            return p
    return None


_EMOJI_RE = re.compile(
    r"[\U0001f300-\U0001f9ff\u2705\u26a0\ufe0f\u274c"
    r"\u2b06\u2b07\u27a1\u2714\u2716"
    r"\U0001f4ca\U0001f4c8\U0001f4c9\U0001f6a2\u2693"
    r"\u2191\u2193\u2190\u2192\u25b2\u25bc\u25b6\u25c0]"
)


def render_md_section(pdf, section: str) -> None:
    """MD 섹션을 fpdf2 페이지에 렌더링 — 테이블 그리드 + 특수문자 처리."""
    eff_w = pdf.w - pdf.l_margin - pdf.r_margin

    for line in section.split("\n"):
        stripped = line.strip()
        if not stripped:
            pdf.ln(2)
            continue

        # 이모지 제거 (폰트 미지원 방지)
        stripped = _EMOJI_RE.sub("", stripped)

        # 헤딩
        if stripped.startswith("## "):
            pdf.set_font("Korean", "B", 14)
            pdf.cell(0, 8, stripped[3:].strip(), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)
        elif stripped.startswith("### "):
            pdf.set_font("Korean", "B", 12)
            pdf.cell(0, 7, stripped[4:].strip(), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)
        elif stripped.startswith("#### "):
            pdf.set_font("Korean", "B", 10)
            pdf.cell(0, 6, stripped[5:].strip(), new_x="LMARGIN", new_y="NEXT")
        elif stripped.startswith("|") and stripped.endswith("|"):
            # 테이블 구분선 스킵
            if set(stripped.replace("|", "").replace("-", "").replace(":", "").strip()) == set():
                continue
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            col_w = eff_w / max(len(cells), 1)
            pdf.set_font("Korean", "", 8)
            for cell in cells:
                cell = _EMOJI_RE.sub("", cell)
                pdf.cell(col_w, 5, cell[:40], border=1, align="C")
            pdf.ln()
        elif stripped.startswith("- ") or stripped.startswith("* "):
            pdf.set_font("Korean", "", 9)
            text = _EMOJI_RE.sub("", stripped[2:])
            pdf.cell(5, 5, " *")
            pdf.multi_cell(eff_w - 5, 5, text)
        elif stripped.startswith("> "):
            pdf.set_font("Korean", "", 9)
            text = _EMOJI_RE.sub("", stripped[2:])
            pdf.set_fill_color(240, 240, 240)
            pdf.multi_cell(eff_w, 5, text, fill=True)
        else:
            pdf.set_font("Korean", "", 9)
            text = _EMOJI_RE.sub("", stripped)
            # 볼드 태그 간단 처리
            text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
            pdf.multi_cell(eff_w, 5, text)


def build_pdf_report_generic(report_md: str, charts: list[tuple[Path, str]],
                              date_str: str, config: CycleConfig,
                              chart_sizes: dict[str, dict] | None = None,
                              log=None) -> Path | None:
    """MD 리포트 + 차트 PNG → PDF 파일 생성."""
    _log = log or (lambda m, **kw: None)
    try:
        from fpdf import FPDF

        font_path = find_korean_font()
        if not font_path:
            _log("ERROR: Korean font not found for PDF")
            return None

        pdf = FPDF()
        pdf.set_margins(10, 10, 10)
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_font("Korean", "", font_path)
        pdf.add_font("Korean", "B", font_path)

        # 표지
        pdf.add_page()
        pdf.set_font("Korean", "B", 20)
        title = _EMOJI_RE.sub("", config.report_title)
        pdf.cell(0, 12, f"{title} 리포트", align="C")
        pdf.ln()
        pdf.set_font("Korean", "", 12)
        pdf.cell(0, 8, f"{date_str}  |  5축 스코어링 + 피크아웃", align="C")
        pdf.ln(8)

        # 본문 섹션별 분할
        sections = re.split(r"(?=^## )", report_md, flags=re.MULTILINE)
        _sizes = chart_sizes or {}

        body_sections = [s for s in sections if s.strip()]
        for si, section in enumerate(body_sections):
            if not section.strip():
                continue
            if si == 0:
                lines_skip = [l for l in section.strip().split("\n") if not l.startswith("# ")]
                if lines_skip:
                    render_md_section(pdf, "\n".join(lines_skip))
                continue
            elif si >= 2:
                pdf.add_page()
            render_md_section(pdf, section)

        # 차트 삽입
        for cpath, ccaption in charts:
            if not cpath.exists():
                continue
            sz = _sizes.get(ccaption, {})
            img_w = sz.get("w", 120)
            est_h = img_w * 0.65
            remaining = pdf.h - pdf.get_y() - 15
            if remaining < est_h + 12:
                pdf.add_page()
            pdf.ln(3)
            pdf.set_font("Korean", "B", 10)
            clean_cap = _EMOJI_RE.sub("", ccaption)
            pdf.cell(0, 6, clean_cap, new_x="LMARGIN", new_y="NEXT", align="C")
            if sz.get("center"):
                x_pos = (pdf.w - img_w) / 2
            else:
                x_pos = pdf.l_margin
            pdf.image(str(cpath), x=x_pos, w=img_w)
            pdf.ln(3)

        # 출력
        config.report_dir.mkdir(parents=True, exist_ok=True)
        out_path = config.report_dir / f"{config.domain}_cycle_{date_str}.pdf"
        pdf.output(str(out_path))
        _log(f"PDF saved: {out_path.name} ({out_path.stat().st_size // 1024}KB)")
        return out_path
    except Exception as e:
        _log(f"PDF build error: {e}")
        return None


# ══════════════════════════════════════════════════════════════════
#  DART 재무 공통
# ══════════════════════════════════════════════════════════════════

DART_REPRT_CODES: dict[str, str] = {
    "11013": "Q1", "11012": "Q2", "11014": "Q3", "11011": "Q4",
}

DART_ACCOUNT_PATTERNS: dict[str, list[str]] = {
    "revenue":              ["매출액", "수익(매출액)"],
    "operating_profit":     ["영업이익", "영업이익(손실)"],
    "net_income":           ["당기순이익", "당기순이익(손실)", "분기순이익"],
    "total_assets":         ["자산총계"],
    "total_equity":         ["자본총계"],
    "operating_cf":         ["영업활동현금흐름", "영업활동으로인한현금흐름"],
}


def qoq_change(current: int | float | None,
               previous: int | float | None) -> float | None:
    """QoQ 변동률 (%). None이면 계산 불가."""
    if current is None or previous is None or previous == 0:
        return None
    return (current - previous) / abs(previous) * 100


def sorted_quarters(quarters: dict) -> list[tuple[str, dict]]:
    """분기 키를 시간순 정렬 (오래된 것 먼저)."""
    return sorted(quarters.items(), key=lambda x: x[0])


# ══════════════════════════════════════════════════════════════════
#  차트 환경 설정
# ══════════════════════════════════════════════════════════════════

def setup_chart_env():
    """matplotlib 환경 설정 (한글 폰트 + 스타일)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    font_path = find_korean_font()
    if font_path:
        from matplotlib import font_manager
        font_manager.fontManager.addfont(font_path)
        prop = font_manager.FontProperties(fname=font_path)
        plt.rcParams["font.family"] = prop.get_name()
    plt.rcParams["axes.unicode_minus"] = False
    plt.style.use("seaborn-v0_8-whitegrid")
    return plt
