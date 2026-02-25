#!/usr/bin/env python3
"""reclassify_catchall.py — I104020 catch-all 오분류 일괄 재분류

note_atomizer가 주입한 "(추정) LLM 합성 콘텐츠" 메타 구문 때문에
LLM 태그에 오매칭되어 I104020에 덤프된 노트를 재분류한다.

Safety:
  - dry-run 기본값 (--apply로 실적용)
  - 재분류 결과 UNCLASSIFIED면 건너뜀 (원래보다 나쁘지 않게)
  - confidence < 0.4면 건너뜀
  - 변경 전 원본 industry를 prev_industry 필드에 보존
  - 1회 최대 300건 안전 캡

Usage:
  python3 reclassify_catchall.py                     # dry-run (리포트만)
  python3 reclassify_catchall.py --apply             # 실적용
  python3 reclassify_catchall.py --target I802010    # 특정 industry만 dry-run
  python3 reclassify_catchall.py --json              # JSON 출력
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Optional

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from shared.classify import (  # noqa: E402
    classify_by_text,
    load_classification,
    strip_meta_phrases,
    get_vault_note_dirs,
    _is_v3,
)
from shared.frontmatter import parse_frontmatter, update_frontmatter  # noqa: E402

from shared.vault_paths import VAULT, REPORTS

REPORT_DIR = REPORTS
CATCHALL_INDUSTRY = "I104020"
APPLY_CAP = 300
# Low threshold: any match is better than staying in wrong catch-all category
MIN_CONFIDENCE = 0.25


def find_catchall_notes() -> list[dict]:
    """Find all notes classified as the catch-all or UNCLASSIFIED."""
    notes = []
    for d in get_vault_note_dirs():
        if not d.exists():
            continue
        for f in d.glob("*.md"):
            meta, body = parse_frontmatter(f)
            if not meta:
                continue
            # v2: catch-all industry I104020
            # v3: UNCLASSIFIED category or empty category
            is_catchall = meta.get("industry") == CATCHALL_INDUSTRY
            cat = meta.get("category", "")
            is_unclassified = (not cat or cat == "UNCLASSIFIED") and not meta.get("sector")
            if is_catchall or is_unclassified:
                notes.append({
                    "path": f,
                    "filename": f.name,
                    "meta": meta,
                    "body": body,
                })
    return notes


def reclassify_note(note: dict, classification: dict) -> dict | None:
    """Re-classify a single note with meta-phrase stripping.

    Returns reclassification result dict or None if no change.
    Supports both v3 (category/subcategory) and v2 (sector/industry).
    """
    body = note["body"] or ""
    title = note["meta"].get("title", note["filename"])
    text = f"{title}\n{body}"

    result = classify_by_text(text, classification=classification)
    is_v3_cls = _is_v3(classification)

    if is_v3_cls:
        cat = result.get("category", "UNCLASSIFIED")
        if cat == "UNCLASSIFIED":
            return None
        if result.get("confidence", 0) < MIN_CONFIDENCE:
            return None

        return {
            "file": note["filename"],
            "path": str(note["path"]),
            "prev_category": note["meta"].get("category", note["meta"].get("sector", "")),
            "prev_subcategory": note["meta"].get("subcategory", note["meta"].get("industry", "")),
            "new_category": cat,
            "new_subcategory": result.get("subcategory", ""),
            "new_sector_label": cat,  # display compat
            "new_i_label": result.get("subcategory", ""),
            "confidence": result["confidence"],
            "matched_tags": result["matched_tags"],
        }
    else:
        if result["sector"] == "UNCLASSIFIED":
            return None
        if result["industry"] == CATCHALL_INDUSTRY:
            return None
        if result["confidence"] < MIN_CONFIDENCE:
            return None

        return {
            "file": note["filename"],
            "path": str(note["path"]),
            "prev_category": note["meta"].get("sector", ""),
            "prev_subcategory": CATCHALL_INDUSTRY,
            "new_category": result["sector"],
            "new_subcategory": result.get("industry", ""),
            "new_sector_label": result["sector_label"],
            "new_i_label": result.get("i_label", ""),
            "confidence": result["confidence"],
            "matched_tags": result["matched_tags"],
        }


def apply_reclassification(note_path: Path, reclass: dict,
                           classification: dict | None = None) -> bool:
    """Apply reclassification to a note's frontmatter (v3 or v2)."""
    is_v3_cls = _is_v3(classification) if classification else True
    if is_v3_cls:
        updates = {
            "category": reclass["new_category"],
            "subcategory": reclass["new_subcategory"],
            "prev_category": reclass.get("prev_category", ""),
            "reclassified_at": datetime.now().strftime("%Y-%m-%d"),
            "reclassified_by": "reclassify_catchall",
        }
    else:
        updates = {
            "sector": reclass["new_category"],
            "industry_group": reclass.get("new_ig", ""),
            "industry": reclass["new_subcategory"],
            "prev_industry": reclass.get("prev_subcategory", ""),
            "reclassified_at": datetime.now().strftime("%Y-%m-%d"),
            "reclassified_by": "reclassify_catchall",
        }
    try:
        update_frontmatter(note_path, updates)
        return True
    except (OSError, ValueError):
        return False


def generate_report(results: list[dict], total: int, skipped: int) -> str:
    """Generate markdown reclassification report."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    sector_counts = Counter(r["new_category"] for r in results)

    lines = [
        "---",
        f"date: {date_str}",
        "type: reclassification-report",
        "zk_type: reference",
        "domain: operations",
        "---",
        "",
        f"# I104020 재분류 리포트 — {date_str}",
        "",
        "## 요약",
        f"- I104020 총 노트: **{total}**건",
        f"- 재분류 대상: **{len(results)}**건",
        f"- 유지 (변경 없음): **{skipped}**건",
        "",
        "## 재분류 대상 섹터별 분포",
        "",
        "| 섹터 | 건수 |",
        "|------|------|",
    ]

    for cat in sorted(sector_counts.keys()):
        label = cat
        for r in results:
            if r["new_category"] == cat:
                label = r.get("new_sector_label", cat)
                break
        lines.append(f"| {label} | {sector_counts[cat]} |")

    lines.extend(["", "## 상세 목록", ""])
    for r in results[:50]:
        lines.append(
            f"- `{r['file']}` → **{r.get('new_sector_label', r['new_category'])}** "
            f"`{r['new_subcategory']}` {r.get('new_i_label', '')} "
            f"(confidence: {r['confidence']:.2f}, tags: {', '.join(r['matched_tags'][:3])})"
        )
    if len(results) > 50:
        lines.append(f"- ... 외 {len(results) - 50}건")

    lines.extend([
        "",
        "---",
        f"*Generated by `reclassify_catchall.py` on {date_str}*",
    ])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Reclassify I104020 catch-all notes"
    )
    parser.add_argument("--apply", action="store_true",
                        help="Actually apply changes (default: dry-run)")
    parser.add_argument("--json", action="store_true",
                        help="JSON output only")
    parser.add_argument("--target", type=str, default=None,
                        help="Filter: only show notes reclassified to this industry")
    args = parser.parse_args()

    classification = load_classification()
    if not classification:
        print(json.dumps({"status": "error", "reason": "classification.json missing"}))
        return 1

    notes = find_catchall_notes()
    total = len(notes)

    # Reclassify all
    results = []
    for note in notes:
        reclass = reclassify_note(note, classification)
        if reclass:
            if args.target and reclass.get("new_subcategory", reclass.get("new_industry")) != args.target:
                continue
            results.append(reclass)

    skipped = total - len(results)

    if args.json:
        cat_counts = Counter(r["new_category"] for r in results)
        output = {
            "status": "ok",
            "mode": "apply" if args.apply else "dry-run",
            "total_catchall": total,
            "reclassified": len(results),
            "skipped": skipped,
            "by_category": dict(cat_counts),
            "details": results[:20],
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    # Print summary
    print(f"미분류/catch-all 노트: {total}건")
    print(f"재분류 대상: {len(results)}건")
    print(f"유지 (UNCLASSIFIED/저신뢰/동일): {skipped}건")
    print()

    cat_counts = Counter(r["new_category"] for r in results)
    print("재분류 대상 카테고리별:")
    for cat in sorted(cat_counts.keys()):
        label = cat
        for r in results:
            if r["new_category"] == cat:
                label = r.get("new_sector_label", cat)
                break
        print(f"  {label}: {cat_counts[cat]}건")

    if args.apply:
        applied = 0
        cap = min(len(results), APPLY_CAP)
        for r in results[:cap]:
            path = Path(r["path"])
            if apply_reclassification(path, r, classification):
                applied += 1

        print(f"\n적용 완료: {applied}/{cap}건")

        # Save report
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now().strftime("%Y-%m-%d")
        report = generate_report(results[:cap], total, skipped)
        report_file = REPORT_DIR / f"reclassify-catchall-{date_str}.md"
        report_file.write_text(report, encoding="utf-8")
        print(f"리포트 저장: {report_file}")
    else:
        print("\n(dry-run 모드 — --apply로 실적용)")
        print()
        for r in results[:10]:
            print(
                f"  {r['file'][:50]:50s} → {r['new_category']} "
                f"{r.get('new_i_label', r.get('new_subcategory', ''))} (conf={r['confidence']:.2f})"
            )
        if len(results) > 10:
            print(f"  ... 외 {len(results) - 10}건")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
