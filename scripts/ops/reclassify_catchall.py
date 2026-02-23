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
)
from shared.frontmatter import parse_frontmatter, update_frontmatter  # noqa: E402

VAULT = Path(os.path.expanduser("~/knowledge"))
NOTE_DIRS = [
    VAULT / "100 지식" / "110 수신함",
    VAULT / "100 지식" / "120 노트",
]
REPORT_DIR = VAULT / "300 운영" / "340 리포트"
CATCHALL_INDUSTRY = "I104020"
APPLY_CAP = 300
# Low threshold: any match is better than staying in wrong catch-all category
MIN_CONFIDENCE = 0.25


def find_catchall_notes() -> list[dict]:
    """Find all notes classified as the catch-all industry."""
    notes = []
    for d in NOTE_DIRS:
        if not d.exists():
            continue
        for f in d.glob("*.md"):
            meta, body = parse_frontmatter(f)
            if not meta:
                continue
            if meta.get("industry") == CATCHALL_INDUSTRY:
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
    """
    body = note["body"] or ""
    title = note["meta"].get("title", note["filename"])
    text = f"{title}\n{body}"

    result = classify_by_text(text, classification=classification)

    # Skip if still same industry or UNCLASSIFIED
    if result["sector"] == "UNCLASSIFIED":
        return None
    if result["industry"] == CATCHALL_INDUSTRY:
        return None
    if result["confidence"] < MIN_CONFIDENCE:
        return None

    return {
        "file": note["filename"],
        "path": str(note["path"]),
        "prev_sector": note["meta"].get("sector", ""),
        "prev_industry": CATCHALL_INDUSTRY,
        "new_sector": result["sector"],
        "new_sector_label": result["sector_label"],
        "new_ig": result["industry_group"],
        "new_ig_label": result.get("ig_label", ""),
        "new_industry": result["industry"],
        "new_i_label": result.get("i_label", ""),
        "new_domain": result["domain"],
        "confidence": result["confidence"],
        "matched_tags": result["matched_tags"],
    }


def apply_reclassification(note_path: Path, reclass: dict) -> bool:
    """Apply reclassification to a note's frontmatter."""
    updates = {
        "sector": reclass["new_sector"],
        "industry_group": reclass["new_ig"],
        "industry": reclass["new_industry"],
        "domain": reclass["new_domain"],
        "prev_industry": reclass["prev_industry"],
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
    sector_counts = Counter(r["new_sector"] for r in results)

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

    for s_code in sorted(sector_counts.keys()):
        label = results[0]["new_sector_label"] if results else s_code
        for r in results:
            if r["new_sector"] == s_code:
                label = r["new_sector_label"]
                break
        lines.append(f"| {label} ({s_code}) | {sector_counts[s_code]} |")

    lines.extend(["", "## 상세 목록", ""])
    for r in results[:50]:  # Top 50 for readability
        lines.append(
            f"- `{r['file']}` → **{r['new_sector_label']}** "
            f"`{r['new_industry']}` {r['new_i_label']} "
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
            if args.target and reclass["new_industry"] != args.target:
                continue
            results.append(reclass)

    skipped = total - len(results)

    if args.json:
        sector_counts = Counter(r["new_sector"] for r in results)
        output = {
            "status": "ok",
            "mode": "apply" if args.apply else "dry-run",
            "total_catchall": total,
            "reclassified": len(results),
            "skipped": skipped,
            "by_sector": dict(sector_counts),
            "details": results[:20],
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    # Print summary
    print(f"I104020 catch-all 노트: {total}건")
    print(f"재분류 대상: {len(results)}건")
    print(f"유지 (UNCLASSIFIED/저신뢰/동일): {skipped}건")
    print()

    sector_counts = Counter(r["new_sector"] for r in results)
    print("재분류 대상 섹터별:")
    for s_code in sorted(sector_counts.keys()):
        label = s_code
        for r in results:
            if r["new_sector"] == s_code:
                label = r["new_sector_label"]
                break
        print(f"  {label} ({s_code}): {sector_counts[s_code]}건")

    if args.apply:
        applied = 0
        cap = min(len(results), APPLY_CAP)
        for r in results[:cap]:
            path = Path(r["path"])
            if apply_reclassification(path, r):
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
                f"  {r['file'][:50]:50s} → {r['new_sector']} "
                f"{r['new_i_label']} (conf={r['confidence']:.2f})"
            )
        if len(results) > 10:
            print(f"  ... 외 {len(results) - 10}건")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
