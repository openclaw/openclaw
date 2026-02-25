#!/usr/bin/env python3
"""
stock -> sector 연결 위에 세부분류(subSector)를 추가한다.

우선순위:
1) manual map
2) portfolio_macro wrapper rules
3) sector별 키워드 rules
4) {sector}:general

출력:
- TTL에 ron:subSector, ron:subSectorMethod, ron:subSectorRule 기록 (--apply)
- 종목별 근거 CSV
- 해외 종목용 Markdown 체크리스트
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from rdflib import Graph, Literal, Namespace, RDF

RON = Namespace("http://ron.openclaw.local/ontology#")

from shared.vault_paths import ONTOLOGY, REPORTS

DEFAULT_TTL = ONTOLOGY / "knowledge.ttl"
DEFAULT_REPORT_DIR = REPORTS / "섹터분류-2026-02-23"
DEFAULT_MANUAL_MAP = DEFAULT_REPORT_DIR / "subsector_manual_map.json"

WRAPPER_RE = re.compile(
    r"(^ace_|^kodex_|^tiger_|^sol_|^time_|^kiwoom_|^ishares_|^vanguard_|^state_street_|_etf$|_index$|_fut_)",
    re.I,
)
KR_RE = re.compile(r"[가-힣]")


@dataclass
class SubResult:
    sub_sector: str
    method: str
    rule: str


RULES_BY_SECTOR: Dict[str, List[Tuple[str, List[str]]]] = {
    "ai_semiconductor": [
        ("semi_memory_storage", ["sandisk", "seagate", "western_digital", "winbond", "nanya", "macronix", "sk하이닉스", "samsung_electronics", "삼성전자"]),
        ("semi_foundry", ["taiwan_semiconductor", "tsmc", "smic", "semiconductor_manufacturing", "tower_semiconductor", "hua_hong", "powerchip", "globalfoundries"]),
        ("semi_equipment", ["asml", "applied_materials", "naura", "lam_research", "teradyne", "hans_cnc"]),
        ("semi_packaging_test", ["ase_", "unimicron", "kinsus", "dongshan_precision"]),
        ("semi_optical_photonics", ["photon", "innolight", "eoptolink", "lumentum", "coherent", "zhongji"]),
        ("semi_design_fabless", ["nvidia", "mediatek", "cambricon", "gigadevice", "hygon", "novatek", "silicon_motion", "tower_semiconductor", "파두", "fadu"]),
        ("semi_defense_electronics", ["aerospace_times_electronics"]),
        ("semi_power_infra", ["eos_energy", "fluence_energy", "hd현대일렉트릭", "두산에너빌리티", "삼성sdi", "로보티즈", "현대오토에버", "international_business_machines", "mercadolibre"]),
        ("semi_thematic_etf", ["time_글로벌우주테크_방산액티브", "time_차이나ai테크액티브"]),
    ],
    "china_tech": [
        ("china_internet_platform", ["alibaba", "baidu", "tencent", "kuaishou", "xiaomi", "sensetime"]),
        ("china_ev_mobility", ["leapmotor", "hesai", "pony_ai", "horizon_robotics", "contemporary_amperex"]),
        ("china_industrial_automation", ["inovance", "dobot", "sanhua", "dtech", "leader_harmonious", "ubtech", "hans_cnc"]),
        ("china_semiconductor_chain", ["semiconductor", "micro", "chip", "interconnect", "electronics", "innolux", "mediatek", "nanya", "macronix", "naura", "hygon", "cambricon", "ase_"]),
        ("china_hardware_infra", ["accton", "quanta", "elite_material", "sieyuan", "zhejiang_rongtai", "suzhou_dongshan", "eoptolink", "zhongji_innolight", "spacesat"]),
        ("china_finance_proxy", ["securities", "hstech_index_fut"]),
        ("china_materials_resources", ["rare_earth", "ganfeng_lithium", "cgn_mining", "drinda"]),
    ],
    "space_defense": [
        ("defense_prime", ["boeing", "airbus", "bae", "lockheed", "northrop", "rtx", "rheinmetall", "thales", "safran", "general_dynamics"]),
        ("space_satellite_launch", ["rocket_lab", "planet_labs", "ast_spacemobile", "redwire", "ondas", "sat", "space"]),
        ("defense_components", ["transdigm", "moog", "teledyne", "huntington_ingalls", "karman", "kratos", "l3harris", "bwx", "carpenter", "teradyne"]),
        ("defense_aero_engineering", ["ftai_aviation", "general_electric", "honeywell", "rolls_royce", "mitsubishi_heavy", "kawasaki_heavy", "ihi_", "saab", "elbit", "hd현대중공업", "레인보우로보틱스"]),
        ("defense_korea", ["한화", "한국항공우주", "현대로템", "쎄트렉"]),
        ("defense_misc_finance_proxy", ["미래에셋증권"]),
    ],
    "technology": [
        ("tech_big_platform", ["alphabet", "amazon", "meta", "microsoft", "apple", "coreweave"]),
        ("tech_network_infra", ["cisco", "ciena", "t_mobile", "echostar"]),
        ("tech_compute_components", ["intel", "arm", "broadcom", "texas_instruments", "micron", "ibm", "samsung_electronics", "삼성전자", "sk스퀘어"]),
        ("tech_semi_equipment_optics", ["applied_materials", "lam_research", "lumentum", "corning", "usa_rare_earth"]),
        ("tech_medical_robotics", ["intuitive_surgical"]),
        ("tech_datacenter_power", ["vertiv", "iren"]),
        ("tech_index_proxy", ["e_mini", "_index_", "_fut_", "strategy_inc", "nasdaq_100"]),
        ("tech_noncore_consumer", ["walmart", "costco", "pepsico"]),
    ],
    "biotech": [
        ("bio_big_pharma", ["abbvie", "amgen", "eli_lilly", "johnson", "merck", "novartis", "novo_nordisk", "gsk", "gilead", "teva", "biogen", "moderna", "regeneron", "녹십자", "jw중외제약", "일동제약", "hk이노엔"]),
        ("bio_rna_gene", ["alnylam", "arrowhead", "olix", "ionis", "알지노믹스", "에이비엘바이오", "앱클론", "에스티팜", "올릭스", "펩트론", "지투지바이오", "에이프릴바이오"]),
        ("bio_korea_growth", ["셀트리온", "알테오젠", "리가켐", "파마리서치", "한미약품", "한올바이오", "삼성바이오", "삼성에피스", "hlb", "hlb이노베이션", "씨어스테크놀로지", "인벤티지랩", "네이처셀", "삼천당제약", "차바이오텍", "케어젠", "코오롱티슈진", "토모큐브", "에스바이오메딕스", "메디포스트", "메지온", "보로노이", "디앤디파마텍", "넥스트바이오메디컬"]),
        ("bio_oncology_pipeline", ["exelixis", "structure_therapeutics", "terns_pharmaceuticals", "오스코텍", "오름테라퓨틱", "에임드바이오"]),
        ("bio_tools_services", ["thermo_fisher", "medpace", "revvity", "natera", "intuitive_surgical", "icon_plc", "리브스메드", "고영", "그래피"]),
    ],
    "energy": [
        ("energy_nuclear_uranium", ["cameco", "uranium_energy", "energy_fuels", "원자력", "한전기술"]),
        ("energy_renewable_power", ["first_solar", "bloom_energy", "ge_vernova", "fluence", "eos_energy"]),
        ("energy_power_grid", ["효성중공업", "hd현대일렉트릭"]),
        ("energy_battery_materials", ["lg에너지솔루션", "삼성sdi", "이수스페셜티", "고려아연", "두산", "세아베스틸"]),
    ],
    "automotive": [
        ("auto_oem", ["tesla", "현대차", "기아"]),
        ("auto_parts_modules", ["현대모비스", "hl만도", "에스피지"]),
        ("auto_industrial_mobility", ["hd건설기계"]),
    ],
    "culture": [
        ("culture_entertainment", ["jyp", "와이지", "하이브", "에스엠", "cj_enm", "스튜디오드래곤", "펄어비스", "더핑크퐁컴퍼니"]),
        ("culture_consumer_beauty", ["에이피알", "코스메카", "클래시스", "휴젤", "달바", "삼양식품", "엘앤씨바이오", "제닉", "한스바이오메드"]),
        ("culture_retail", ["롯데쇼핑", "신세계", "미스토홀딩스", "cj"]),
        ("culture_b2b_services", ["gs피앤엘", "서부t_d", "아이티센글로벌"]),
    ],
    "iot": [
        ("iot_telecom_network", ["sk텔레콤", "echostar", "telecom", "satellite"]),
        ("iot_device_platform", ["iot", "sensor", "smart_device"]),
    ],
    "portfolio_macro": [
        ("macro_futures", ["_fut_", "fut_", "e_mini", "mini_index"]),
        ("macro_commodity_gold", ["gold", "krx금현물"]),
        ("macro_commodity_energy", ["원유", "oil", "energy기업"]),
        ("macro_sector_semiconductor", ["semiconductor"]),
        ("macro_sector_healthcare", ["헬스케어", "healthcare"]),
        ("macro_sector_finance", ["증권"]),
        ("macro_broad_index", ["s_p500", "nasdaq100", "코스닥150", "코스피", "니케이225", "토탈월드"]),
        ("macro_dividend", ["배당"]),
        ("macro_multi_asset", ["채권혼합"]),
        ("macro_thematic_ai", ["ai", "인공지능"]),
        ("macro_thematic_biotech", ["바이오"]),
    ],
}


def slug(uri) -> str:
    text = str(uri)
    if "#" in text:
        text = text.rsplit("#", 1)[-1]
    return text.rstrip("/").rsplit("/", 1)[-1]


def is_wrapper(stock_slug: str) -> bool:
    return bool(WRAPPER_RE.search(stock_slug))


def is_overseas(stock_slug: str) -> bool:
    return not bool(KR_RE.search(stock_slug))


def load_manual_map(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for k, v in raw.items():
        if not k or not v:
            continue
        out[str(k).strip().lower()] = str(v).strip()
    return out


def match_by_keywords(stock_slug: str, rules: List[Tuple[str, List[str]]]) -> Optional[SubResult]:
    s = stock_slug.lower()
    for sub, keys in rules:
        if any(k.lower() in s for k in keys):
            return SubResult(sub, "keyword_rule", f"kw:{sub}")
    return None


def classify_subsector(stock_slug: str, sector_slug: str, manual_map: Dict[str, str]) -> SubResult:
    s = stock_slug.lower()

    if s in manual_map:
        return SubResult(manual_map[s], "manual_map", f"manual:{manual_map[s]}")

    if sector_slug == "portfolio_macro" and is_wrapper(stock_slug):
        matched = match_by_keywords(s, RULES_BY_SECTOR["portfolio_macro"])
        if matched:
            return matched
        return SubResult("macro_general", "wrapper_rule", "wrapper:general")

    rules = RULES_BY_SECTOR.get(sector_slug, [])
    if rules:
        matched = match_by_keywords(s, rules)
        if matched:
            return matched
        return SubResult(f"{sector_slug}_general", "sector_fallback", "fallback:sector_general")

    return SubResult(f"{sector_slug}_general", "global_fallback", "fallback:global")


def write_overseas_markdown(rows: List[dict], path: Path) -> None:
    overseas = [r for r in rows if is_overseas(r["stock_slug"])]
    overseas.sort(key=lambda r: (r["sector_slug"], r["sub_sector"], r["stock_slug"]))

    lines = []
    lines.append("# 해외종목 세부분류 검토체크")
    lines.append("")
    lines.append(f"- 대상: {len(overseas)}건")
    lines.append("- 체크: `유지/수정/보류` 중 하나로 관리")
    lines.append("")
    lines.append("| 체크 | 종목 | 대분류 | 세부분류 | 분류근거 | 규칙 |")
    lines.append("|---|---|---|---|---|---|")
    for r in overseas:
        lines.append(
            f"| [ ] | `{r['stock_slug']}` | `{r['sector_slug']}` | `{r['sub_sector']}` | `{r['method']}` | `{r['rule']}` |"
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    p = argparse.ArgumentParser(description="Backfill stock sub-sector classification")
    p.add_argument("--ttl", default=str(DEFAULT_TTL), help="knowledge.ttl path")
    p.add_argument("--manual-map", default=str(DEFAULT_MANUAL_MAP), help="manual map JSON path")
    p.add_argument("--apply", action="store_true", help="write ron:subSector triples")
    p.add_argument("--csv", default=str(DEFAULT_REPORT_DIR / "stock_subsector_provenance_2026-02-23.csv"))
    p.add_argument("--md", default=str(DEFAULT_REPORT_DIR / "해외종목_세부분류표_검토체크_2026-02-23.md"))
    args = p.parse_args()

    ttl = Path(args.ttl)
    manual = load_manual_map(Path(args.manual_map))
    g = Graph()
    g.parse(str(ttl), format="turtle")

    rows = []
    method_counter = Counter()

    for stock, _, _ in g.triples((None, RDF.type, RON.Stock)):
        stock_slug = slug(stock)
        sectors = [slug(o) for _, _, o in g.triples((stock, RON.belongsTo, None))]
        if not sectors:
            continue
        sector_slug = sectors[0]

        result = classify_subsector(stock_slug, sector_slug, manual)
        rows.append(
            {
                "stock_uri": str(stock),
                "stock_slug": stock_slug,
                "sector_slug": sector_slug,
                "sub_sector": result.sub_sector,
                "method": result.method,
                "rule": result.rule,
                "manual_hit": str(stock_slug.lower() in manual),
            }
        )
        method_counter[result.method] += 1

        if args.apply:
            # replace existing values for deterministic output
            for _, _, o in list(g.triples((stock, RON.subSector, None))):
                g.remove((stock, RON.subSector, o))
            for _, _, o in list(g.triples((stock, RON.subSectorMethod, None))):
                g.remove((stock, RON.subSectorMethod, o))
            for _, _, o in list(g.triples((stock, RON.subSectorRule, None))):
                g.remove((stock, RON.subSectorRule, o))

            g.add((stock, RON.subSector, Literal(result.sub_sector)))
            g.add((stock, RON.subSectorMethod, Literal(result.method)))
            g.add((stock, RON.subSectorRule, Literal(result.rule)))

    rows.sort(key=lambda r: r["stock_slug"])

    csv_path = Path(args.csv)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=["stock_uri", "stock_slug", "sector_slug", "sub_sector", "method", "rule", "manual_hit"],
        )
        w.writeheader()
        w.writerows(rows)

    md_path = Path(args.md)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    write_overseas_markdown(rows, md_path)

    if args.apply:
        g.serialize(str(ttl), format="turtle")

    summary = {
        "status": "ok",
        "stocks_classified": len(rows),
        "apply": bool(args.apply),
        "manual_map_entries": len(manual),
        "methods": dict(method_counter),
        "csv": str(csv_path),
        "md": str(md_path),
        "ttl": str(ttl),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
