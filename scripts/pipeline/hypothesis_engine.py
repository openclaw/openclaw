#!/usr/bin/env python3
"""
hypothesis_engine.py — 볼트 크로스링크 + 발견 → 검증 가능한 가설 생성

입력:
  1. 볼트 노트 크로스링크 클러스터 (note_atomizer 출력)
  2. filtered-ideas/ (discovery_filter 출력)
  3. idea_sources.json 병목 (엔지니어링) + 투자 도메인 병목

출력:
  - hypotheses/ JSON 파일
  - bus_commands 태스크 (codex: 엔지니어링, data-analyst: 투자)

Usage:
  python3 hypothesis_engine.py              # 가설 생성
  python3 hypothesis_engine.py --dry-run    # 미리보기
  python3 hypothesis_engine.py --max 5      # 최대 5개 생성
  python3 hypothesis_engine.py --vault-only # 볼트 클러스터만 사용
  python3 hypothesis_engine.py --no-llm     # LLM 없이 템플릿만

Cron: 매일 02:50 (Gateway jobs.json에서 등록)
"""

import argparse
import json
import os
import re
import sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen

# Ensure shared modules are importable when run directly
import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.classify import get_vault_note_dirs  # noqa: E402

from shared.vault_paths import VAULT, INBOX

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
INBOX_DIR = INBOX
NOTES_DIR = VAULT / "100 지식" / "120 노트"  # v2 legacy
IDEA_SOURCES = Path(os.path.expanduser("~/.openclaw/idea_sources.json"))
FILTERED_DIR = WORKSPACE / "memory" / "filtered-ideas"
HYPOTHESIS_DIR = WORKSPACE / "memory" / "hypotheses"
DB_PATH = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))

GATEWAY_URL = "http://127.0.0.1:18789/v1/chat/completions"
GATEWAY_TOKEN = os.environ.get("OPENCLAW_TOKEN", "")
if not GATEWAY_TOKEN:
    _env_file = Path(os.path.expanduser("~/.openclaw/.env"))
    if _env_file.exists():
        for _line in _env_file.read_text().splitlines():
            if _line.startswith("OPENCLAW_TOKEN="):
                GATEWAY_TOKEN = _line.split("=", 1)[1].strip().strip('"')

LLM_MODEL_CHAIN = ["openclaw:main", "github-copilot/gpt-5-mini", "qwen3:8b"]
LLM_TIMEOUT = 30

# ── 투자 도메인 병목 (볼트 기반 가설용) ──
INVESTMENT_BOTTLENECKS = [
    {"area": "S10_반도체기술",
     "description": "AI반도체 수요 지속성 vs 피크아웃 리스크 판단",
     "keywords": {"반도체", "gpu", "ai칩", "nvidia", "hbm", "메모리", "파운드리",
                  "tsmc", "삼성전자", "하이닉스", "semiconductor", "chip"}},
    {"area": "S10_반도체기술",
     "description": "첨단 패키징·소재 공급망 병목과 수혜 기업 식별",
     "keywords": {"패키징", "cowos", "hbm", "소재", "장비", "osat", "euv", "노광"}},
    {"area": "S20_바이오",
     "description": "바이오 신약 파이프라인 가치 평가와 승인 리스크",
     "keywords": {"바이오", "신약", "임상", "fda", "파이프라인", "hlb", "셀트리온",
                  "제약", "bio", "pharma"}},
    {"area": "S30_산업재방산",
     "description": "방산 수출 확대와 산업재 턴어라운드 시점",
     "keywords": {"방산", "한화", "현대로템", "산업재", "수출", "무기", "조선", "defense"}},
    {"area": "S40_콘텐츠",
     "description": "콘텐츠·플랫폼 수익화 전환과 AI 영향",
     "keywords": {"콘텐츠", "게임", "엔터", "미디어", "플랫폼", "ai콘텐츠", "넷플릭스"}},
    {"area": "S50_에너지",
     "description": "에너지 전환과 전력 인프라 투자 수혜 판단",
     "keywords": {"에너지", "전력", "원전", "신재생", "태양광", "배터리", "수소", "energy"}},
    {"area": "S60_금융",
     "description": "금리 방향에 따른 금융업 실적 변화와 배당·우선주 가치",
     "keywords": {"금융", "은행", "금리", "배당", "우선주", "보험", "증권", "finance"}},
    {"area": "S70_중국",
     "description": "중국 정책 리스크와 투자 기회 정량화",
     "keywords": {"중국", "china", "시진핑", "관세", "알리바바", "텐센트", "홍콩"}},
    {"area": "S80_매크로",
     "description": "매크로 시그널에 따른 섹터 로테이션과 포트폴리오 조정",
     "keywords": {"매크로", "금리", "환율", "유동성", "fed", "인플레이션", "경기",
                  "포트폴리오", "etf", "리밸런싱", "macro"}},
]


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


# ──────────────────────────────────────────────────────────────
# Note parsing helpers
# ──────────────────────────────────────────────────────────────

def _parse_note_meta(filepath):
    """간단한 프론트매터 파서."""
    try:
        text = filepath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None, ""
    meta = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    k = key.strip()
                    v = val.strip()
                    if v.startswith("["):
                        try:
                            meta[k] = json.loads(v)
                        except json.JSONDecodeError:
                            meta[k] = v
                    else:
                        meta[k] = v.strip('"').strip("'")
            body = parts[2]
    return meta, body


def _extract_wikilinks(body):
    """본문에서 [[link]] 추출."""
    if not body:
        return []
    return re.findall(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]", body)


# ──────────────────────────────────────────────────────────────
# LLM helpers
# ──────────────────────────────────────────────────────────────

def _call_llm(prompt, system=""):
    """Gateway API로 LLM 호출. 전체 모델 체인 시도, 실패 시 None."""
    for model in LLM_MODEL_CHAIN:
        try:
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": prompt})

            payload = json.dumps({
                "model": model, "messages": messages,
                "max_tokens": 400, "temperature": 0.7,
            }).encode("utf-8")

            headers = {"Content-Type": "application/json"}
            if GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"

            req = Request(GATEWAY_URL, data=payload, headers=headers, method="POST")
            with urlopen(req, timeout=LLM_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data["choices"][0]["message"]["content"].strip()
        except Exception:
            continue
    return None


# ──────────────────────────────────────────────────────────────
# Data loading — 병목
# ──────────────────────────────────────────────────────────────

def load_bottlenecks():
    """idea_sources.json (엔지니어링) + 투자 도메인 병목 통합 로드."""
    bottlenecks = []

    # 엔지니어링 병목 (idea_sources.json)
    if IDEA_SOURCES.exists():
        try:
            data = json.loads(IDEA_SOURCES.read_text(encoding="utf-8"))
            for area_name, area in data.get("focus_areas", {}).items():
                for bn in area.get("current_bottlenecks", []):
                    bottlenecks.append({
                        "area": area_name,
                        "domain": "engineering",
                        "description": bn,
                        "keywords": set(w.lower() for w in re.findall(r"[a-zA-Z가-힣]{2,}", bn)),
                    })
        except Exception:
            pass

    # 투자 도메인 병목
    for bn in INVESTMENT_BOTTLENECKS:
        bottlenecks.append({
            "area": bn["area"],
            "domain": "investment",
            "description": bn["description"],
            "keywords": bn["keywords"],
        })

    return bottlenecks


# ──────────────────────────────────────────────────────────────
# Data loading — 발견 (filtered + vault)
# ──────────────────────────────────────────────────────────────

def load_recent_discoveries():
    """최근 필터 결과 로드 (score 높은 순)."""
    items = []
    if not FILTERED_DIR.exists():
        return items
    for f in sorted(FILTERED_DIR.glob("filtered_*.json"), reverse=True)[:5]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            for item in data:
                item["source_type"] = "filtered"
            items.extend(data)
        except Exception:
            continue
    return sorted(items, key=lambda x: x.get("score", 0), reverse=True)


def load_vault_discoveries(max_items=30):
    """볼트 노트 크로스링크 클러스터에서 가설 후보 추출.

    3가지 패턴 (v3: category/subcategory 기반):
      1. 서브카테고리 클러스터: 같은 subcategory에 3+ 보강 노트
      2. 크로스카테고리 브릿지: 2+ 다른 category로 연결된 노트
      3. 카테고리 시계열: 같은 category에 4+ 노트 축적
    """
    all_notes = {}            # stem → note_info
    notes_by_subcategory = defaultdict(list)

    for search_dir in get_vault_note_dirs(include_inbox=True):
        if not search_dir.exists():
            continue
        for f in search_dir.glob("*.md"):
            meta, body = _parse_note_meta(f)
            if not meta:
                continue

            # v3 우선, v2 fallback
            category = meta.get("category", "")
            if not category or category == "UNCLASSIFIED":
                category = meta.get("sector", "UNCLASSIFIED")
            subcategory = meta.get("subcategory", meta.get("industry", ""))
            if not subcategory:
                subcategory = meta.get("industry_group", "")
            enriched = bool(meta.get("enriched_at") or meta.get("enrichment_method"))

            note_info = {
                "filename": f.name,
                "stem": f.stem,
                "title": meta.get("title", f.stem)[:80],
                "category": category,
                "subcategory": subcategory,
                "domain": meta.get("domain", "general"),
                "enriched": enriched,
                "body_len": len(body.strip()) if body else 0,
                "links": _extract_wikilinks(body) if body else [],
                "body_snippet": (body.strip()[:300] if body else ""),
            }
            all_notes[f.stem] = note_info

            if subcategory:
                notes_by_subcategory[subcategory].append(note_info)

    discoveries = []

    # ── 패턴 1: 서브카테고리 클러스터 (같은 subcategory에 보강 노트 3+) ──
    for subcategory, notes in notes_by_subcategory.items():
        enriched = [n for n in notes if n["enriched"] and n["body_len"] > 50]
        if len(enriched) < 3:
            continue

        category = enriched[0]["category"]
        titles = [n["title"] for n in enriched[:6]]
        snippets = " ".join(n["body_snippet"] for n in enriched[:3])
        score = min(10, len(enriched) // 2 + 3)

        discoveries.append({
            "id": f"vault:cluster:{subcategory}:{len(enriched)}",
            "source": f"vault/{category}/{subcategory}",
            "source_type": "vault_cluster",
            "type": "industry_cluster",
            "text": (f"[{subcategory}] {len(enriched)}건 노트 클러스터. "
                     f"주요: {', '.join(titles)}. {snippets[:400]}"),
            "score": score,
            "subcategory": subcategory,
            "category": category,
            "domain": enriched[0].get("domain", "general"),
            "note_count": len(enriched),
            "evidence_notes": [n["filename"] for n in enriched[:10]],
        })

    # ── 패턴 2: 크로스카테고리 브릿지 (2+ 다른 category로 연결) ──
    for stem, note in all_notes.items():
        if not note["links"] or note["category"] == "UNCLASSIFIED":
            continue
        cross_categories = {}
        for link in note["links"]:
            linked = all_notes.get(link)
            if (linked
                    and linked["category"] != "UNCLASSIFIED"
                    and linked["category"] != note["category"]):
                cross_categories.setdefault(linked["category"], []).append(linked["title"])

        if len(cross_categories) >= 2:
            category_list = list(cross_categories.keys())
            detail = " / ".join(
                f"{c}: {', '.join(ns[:2])}" for c, ns in cross_categories.items()
            )
            discoveries.append({
                "id": f"vault:bridge:{stem}",
                "source": f"vault/bridge/{note['category']}",
                "source_type": "vault_bridge",
                "type": "cross_sector_bridge",
                "text": (f"'{note['title']}'({note['category']})가 "
                         f"{', '.join(category_list)}과 교차 연결. {detail}"),
                "score": 7 + len(cross_categories),
                "categories": [note["category"]] + category_list,
                "domain": "investment",
                "bridge_note": note["filename"],
                "evidence_notes": [note["filename"]],
            })

    # ── 패턴 3: 카테고리 시계열 (같은 category에 4+ 보강 노트) ──
    by_cat = defaultdict(list)
    for subcategory, notes in notes_by_subcategory.items():
        if notes:
            cat = notes[0].get("category", subcategory[:6])
            by_cat[cat].extend(notes)

    for cat, notes in by_cat.items():
        enriched = [n for n in notes if n["enriched"]]
        if len(enriched) < 4:
            continue
        titles = [n["title"] for n in enriched[:5]]
        discoveries.append({
            "id": f"vault:temporal:{cat}:{len(enriched)}",
            "source": f"vault/temporal/{cat}",
            "source_type": "vault_temporal",
            "type": "temporal_cluster",
            "text": f"[{cat}] {len(enriched)}건 시계열 축적. 주요: {', '.join(titles)}",
            "score": min(10, len(enriched) // 3 + 4),
            "category": cat,
            "domain": enriched[0].get("domain", "general"),
            "note_count": len(enriched),
            "evidence_notes": [n["filename"] for n in enriched[:10]],
        })

    discoveries.sort(key=lambda x: x["score"], reverse=True)
    log(f"Vault discoveries: {len(discoveries)} "
        f"(cluster/bridge/temporal)")
    return discoveries[:max_items]


def load_existing_hypotheses():
    """이미 생성된 가설 ID 목록."""
    if not HYPOTHESIS_DIR.exists():
        return set()
    ids = set()
    for f in HYPOTHESIS_DIR.glob("hypothesis_*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            for h in data:
                ids.add(h.get("id", ""))
        except Exception:
            continue
    return ids


# ──────────────────────────────────────────────────────────────
# 가설 생성
# ──────────────────────────────────────────────────────────────

def match_discovery_to_bottleneck(discovery, bottlenecks):
    """발견과 가장 관련 높은 병목 매칭."""
    text = discovery.get("text", "").lower()
    text_kw = set(re.findall(r"[a-zA-Z가-힣]{2,}", text))

    # 카테고리/서브카테고리 키워드 포함 (+ v2 fallback)
    for field in ("category", "subcategory", "sector", "industry", "industry_group"):
        val = discovery.get(field, "")
        if val:
            text_kw.add(val.lower())

    best_match = None
    best_overlap = 0
    for bn in bottlenecks:
        overlap = len(text_kw & bn["keywords"])
        if overlap > best_overlap:
            best_overlap = overlap
            best_match = bn
    return best_match, best_overlap


def generate_hypothesis(discovery, bottleneck, use_llm=True):
    """발견+병목에서 가설 생성."""
    disc_text = discovery.get("text", "")[:400]
    bn_desc = bottleneck["description"]
    area = bottleneck["area"]
    domain = bottleneck.get("domain", "engineering")
    disc_type = discovery.get("type", "filtered")

    hypothesis_text = None

    # 볼트 클러스터 → LLM으로 깊이 있는 가설 시도
    if use_llm and disc_type in ("industry_cluster", "cross_sector_bridge", "temporal_cluster"):
        prompt = (
            "다음 정보를 바탕으로 검증 가능한 투자 가설을 한국어 2-3문장으로 생성해줘.\n"
            "반드시 '만약 ~라면, ~일 것이다' 형식의 조건부 가설이어야 함.\n\n"
            f"발견: {disc_text}\n"
            f"관련 과제: {bn_desc}\n"
            f"영역: {area}\n\n가설:"
        )
        hypothesis_text = _call_llm(
            prompt,
            system="당신은 투자 리서치 분석가입니다. 간결하고 검증 가능한 가설만 생성합니다.",
        )

    # 폴백: 템플릿 기반
    if not hypothesis_text:
        note_count = discovery.get("note_count", 0)
        if disc_type == "industry_cluster":
            hypothesis_text = (
                f"[{area}] {note_count}건 노트가 동일 산업에 집중 — "
                f"'{bn_desc}'에 대한 시그널 가능성. 관련 데이터 추적 필요."
            )
        elif disc_type == "cross_sector_bridge":
            sectors = discovery.get("sectors", [])
            hypothesis_text = (
                f"[{area}] {', '.join(sectors)} 교차 연결 — "
                f"크로스섹터 관점에서 '{bn_desc}' 재해석 가능."
            )
        elif disc_type == "temporal_cluster":
            hypothesis_text = (
                f"[{area}] 시계열 {note_count}건 축적 — "
                f"'{bn_desc}' 방향의 트렌드 변화 감지 가능성."
            )
        else:
            hypothesis_text = (
                f"[{area}] '{disc_text[:80]}...'의 접근법을 적용하면 "
                f"'{bn_desc}'를 개선할 수 있다"
            )

    if domain == "investment":
        verification = "관련 가격/실적/뉴스 데이터 수집 후 방향성 확인 (1주 관찰)"
    else:
        verification = "적용 전후 관련 KPI 비교 (최소 2일 관찰)"

    return {
        "id": f"hyp-{datetime.now().strftime('%Y%m%d%H%M')}-"
              f"{area[:12].replace('/', '-')}",
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "area": area,
        "domain": domain,
        "type": disc_type,
        "bottleneck": bn_desc,
        "discovery_source": discovery.get("source", "unknown"),
        "discovery_score": discovery.get("score", 0),
        "discovery_text": disc_text[:300],
        "hypothesis": hypothesis_text,
        "verification": verification,
        "evidence_notes": discovery.get("evidence_notes", []),
        "status": "proposed",
        "experiment_task_created": False,
    }


def create_agent_task(hypothesis, dry_run=False):
    """가설 실험 태스크 생성 — 도메인에 따라 에이전트 라우팅.

    investment → data-analyst, engineering → codex
    """
    domain = hypothesis.get("domain", "engineering")
    agent = "data-analyst" if domain == "investment" else "codex"
    prefix = "[투자가설]" if domain == "investment" else "[가설실험]"
    title = f"{prefix} {hypothesis['area']}: {hypothesis['bottleneck'][:50]}"

    body_parts = [
        f"가설: {hypothesis['hypothesis']}",
        "",
        f"발견 출처: {hypothesis['discovery_source']} (score={hypothesis['discovery_score']})",
        f"유형: {hypothesis.get('type', 'unknown')}",
        f"검증 방법: {hypothesis['verification']}",
    ]
    if hypothesis.get("evidence_notes"):
        body_parts.append(
            f"근거 노트: {', '.join(hypothesis['evidence_notes'][:5])}"
        )
    body_parts.append("\n결과를 리포트하세요.")
    body = "\n".join(body_parts)

    if dry_run:
        log(f"  [DRY-RUN] {agent} task: {title[:70]}")
        return True

    if not DB_PATH.exists():
        log("DB not found, skipping task creation")
        return False

    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.execute(
            "INSERT INTO bus_commands "
            "(agent, title, body, status, priority, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (agent, title, body, "queued", 2,
             datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
        )
        conn.commit()
        conn.close()
        log(f"  Created {agent} task: {title[:70]}")
        return True
    except Exception as e:
        log(f"Task creation failed: {e}")
        return False


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate testable hypotheses from vault clusters + discoveries"
    )
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    parser.add_argument("--max", type=int, default=5, help="최대 가설 수")
    parser.add_argument("--vault-only", action="store_true",
                        help="볼트 클러스터만 사용 (filtered 무시)")
    parser.add_argument("--no-llm", action="store_true",
                        help="LLM 없이 템플릿만 사용")
    args = parser.parse_args()

    HYPOTHESIS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. 데이터 로드
    bottlenecks = load_bottlenecks()

    filtered_disc = [] if args.vault_only else load_recent_discoveries()
    vault_disc = load_vault_discoveries()
    # 볼트 우선 (더 풍부한 컨텍스트)
    discoveries = vault_disc + filtered_disc

    existing_ids = load_existing_hypotheses()

    log(f"Bottlenecks: {len(bottlenecks)} (eng+invest), "
        f"Discoveries: {len(discoveries)} "
        f"(vault={len(vault_disc)}, filtered={len(filtered_disc)}), "
        f"Existing: {len(existing_ids)}")

    if not bottlenecks or not discoveries:
        result = {
            "status": "ok", "generated": 0, "reason": "no data",
            "bottlenecks": len(bottlenecks),
            "discoveries": len(discoveries),
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0

    # 2. 매칭 + 가설 생성
    generated = []
    area_counts = {}
    used_disc_ids = set()

    for disc in discoveries:
        if len(generated) >= args.max:
            break

        disc_id = disc.get("id", "")
        if disc_id in used_disc_ids:
            continue

        match, overlap = match_discovery_to_bottleneck(disc, bottlenecks)

        # 볼트 발견은 키워드가 구체적 → 낮은 threshold
        min_overlap = 1 if disc.get("source_type", "").startswith("vault") else 2
        if not match or overlap < min_overlap:
            continue

        area = match["area"]
        if area_counts.get(area, 0) >= 2:  # 영역당 최대 2개
            continue

        hyp = generate_hypothesis(disc, match, use_llm=not args.no_llm)

        if hyp["id"] in existing_ids:
            continue

        generated.append(hyp)
        area_counts[area] = area_counts.get(area, 0) + 1
        used_disc_ids.add(disc_id)

        log(f"Generated: [{area}] type={disc.get('type', '?')} "
            f"overlap={overlap} score={disc.get('score', 0)}")

        ok = create_agent_task(hyp, dry_run=args.dry_run)
        hyp["experiment_task_created"] = ok

    # 3. 저장
    if generated and not args.dry_run:
        ts = datetime.now().strftime("%Y-%m-%d_%H%M")
        out_file = HYPOTHESIS_DIR / f"hypothesis_{ts}.json"
        out_file.write_text(
            json.dumps(generated, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log(f"Saved {len(generated)} hypotheses to {out_file.name}")

    result = {
        "status": "ok",
        "bottlenecks": len(bottlenecks),
        "discoveries_total": len(discoveries),
        "discoveries_vault": len(vault_disc),
        "discoveries_filtered": len(filtered_disc),
        "generated": len(generated),
        "areas": dict(area_counts),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
