#!/usr/bin/env python3
"""taxonomy_audit.py — 분류체계 구조 분석 및 감사 도구

볼트 전체를 스캔하여 industry별 노트 수를 카운팅하고,
빈 카테고리 / 과밀 카테고리를 식별, 미분류 태그 빈도를 분석한다.

Usage:
  python3 taxonomy_audit.py                    # 전체 감사 + 리포트 생성
  python3 taxonomy_audit.py --json             # JSON만 출력
  python3 taxonomy_audit.py --dry-run          # 리포트 생성 안 함
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from shared.classify import classify_by_tags, load_classification  # noqa: E402
from shared.frontmatter import parse_frontmatter  # noqa: E402

VAULT = Path(os.path.expanduser("~/knowledge"))
NOTE_DIRS = [
    VAULT / "100 지식" / "110 수신함",
    VAULT / "100 지식" / "120 노트",
]
REPORT_DIR = VAULT / "300 운영" / "340 리포트"

OVERCROWDED_THRESHOLD = 30
NEW_TAG_THRESHOLD = 5


def scan_vault_notes() -> list[dict]:
    """Scan all .md files in vault note directories."""
    notes = []
    for d in NOTE_DIRS:
        if not d.exists():
            continue
        for f in d.glob("*.md"):
            meta, body = parse_frontmatter(f)
            if not meta and not body:
                continue
            tags = meta.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",") if t.strip()]
            notes.append({
                "path": str(f),
                "filename": f.name,
                "tags": tags,
                "sector": meta.get("sector", ""),
                "industry_group": meta.get("industry_group", ""),
                "industry": meta.get("industry", ""),
            })
    return notes


def count_distribution(notes: list[dict], classification: dict) -> dict:
    """Count notes per industry/sector, find gaps and clusters."""
    by_sector = Counter()
    by_ig = Counter()
    by_industry = Counter()
    unclassified = 0
    tag_freq = Counter()
    all_known_tags = set()

    # Collect all known tags from classification
    sectors = classification.get("sectors", {})
    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                all_known_tags.update(t.lower() for t in industry.get("tags", []))

    for note in notes:
        sector = note.get("sector", "")
        if sector and sector != "UNCLASSIFIED":
            by_sector[sector] += 1
            ig = note.get("industry_group", "")
            if ig:
                by_ig[ig] += 1
            ind = note.get("industry", "")
            if ind:
                by_industry[ind] += 1
        else:
            unclassified += 1

        # Count tag frequencies (only non-classification tags for gap detection)
        for t in note.get("tags", []):
            if t.lower() not in all_known_tags:
                tag_freq[t] += 1

    return {
        "total": len(notes),
        "classified": len(notes) - unclassified,
        "unclassified": unclassified,
        "by_sector": dict(by_sector),
        "by_ig": dict(by_ig),
        "by_industry": dict(by_industry),
        "unknown_tag_freq": dict(tag_freq),
    }


def find_empty_industries(classification: dict, by_industry: dict) -> list[dict]:
    """Find industries with 0 notes."""
    empty = []
    sectors = classification.get("sectors", {})
    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                if by_industry.get(i_code, 0) == 0:
                    empty.append({
                        "industry": i_code,
                        "label": f"{sector['label']} > {ig['label']} > {industry['label']}",
                        "sector": s_code,
                    })
    return empty


def find_overcrowded(classification: dict, by_industry: dict,
                     threshold: int = OVERCROWDED_THRESHOLD) -> list[dict]:
    """Find industries with more than threshold notes."""
    crowded = []
    sectors = classification.get("sectors", {})
    for s_code, sector in sectors.items():
        for ig_code, ig in sector.get("industry_groups", {}).items():
            for i_code, industry in ig.get("industries", {}).items():
                count = by_industry.get(i_code, 0)
                if count >= threshold:
                    crowded.append({
                        "industry": i_code,
                        "label": f"{sector['label']} > {ig['label']} > {industry['label']}",
                        "count": count,
                        "sector": s_code,
                    })
    return sorted(crowded, key=lambda x: -x["count"])


def find_new_tag_candidates(tag_freq: dict,
                            threshold: int = NEW_TAG_THRESHOLD) -> list[dict]:
    """Find frequently-occurring tags not in classification (new category candidates)."""
    candidates = []
    for tag, count in sorted(tag_freq.items(), key=lambda x: -x[1]):
        # Skip system tags
        if "/" in tag or tag.startswith("status"):
            continue
        if count >= threshold:
            candidates.append({"tag": tag, "count": count})
        if len(candidates) >= 20:
            break
    return candidates


def generate_audit_report(dist: dict, empty: list, crowded: list,
                          new_tags: list, classification: dict) -> str:
    """Generate markdown audit report."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    sectors = classification.get("sectors", {})

    lines = [
        "---",
        f"date: {date_str}",
        "type: taxonomy-audit",
        "zk_type: reference",
        "domain: operations",
        "---",
        "",
        f"# 분류체계 구조 감사 — {date_str}",
        "",
        "## 요약",
        f"- 총 노트: **{dist['total']}**건",
        f"- 분류됨: **{dist['classified']}**건 "
        f"({dist['classified']/max(dist['total'],1)*100:.0f}%)",
        f"- 미분류: **{dist['unclassified']}**건",
        f"- 빈 카테고리: **{len(empty)}**개",
        f"- 과밀 카테고리 (≥{OVERCROWDED_THRESHOLD}): **{len(crowded)}**개",
        f"- 신규 태그 후보: **{len(new_tags)}**개",
        "",
        "## 섹터별 분포",
        "",
        "| 섹터 | 노트 수 |",
        "|------|---------|",
    ]

    for s_code in sorted(dist["by_sector"].keys()):
        label = sectors.get(s_code, {}).get("label", s_code)
        count = dist["by_sector"][s_code]
        lines.append(f"| {label} ({s_code}) | {count} |")

    if empty:
        lines.extend(["", "## 빈 카테고리 (노트 0건)", ""])
        for e in empty:
            lines.append(f"- `{e['industry']}` — {e['label']}")

    if crowded:
        lines.extend([
            "", f"## 과밀 카테고리 (≥{OVERCROWDED_THRESHOLD}건)", "",
        ])
        for c in crowded:
            lines.append(f"- `{c['industry']}` — {c['label']} (**{c['count']}건**)")

    if new_tags:
        lines.extend(["", "## 미분류 태그 빈도 Top 20 (신규 카테고리 후보)", ""])
        for nt in new_tags:
            lines.append(f"- `{nt['tag']}` — {nt['count']}회")

    lines.extend(["", "---", f"*Generated by `taxonomy_audit.py` on {date_str}*"])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Taxonomy structure audit")
    parser.add_argument("--dry-run", action="store_true", help="No file output")
    parser.add_argument("--json", action="store_true", help="JSON output only")
    args = parser.parse_args()

    classification = load_classification()
    if not classification:
        print(json.dumps({"status": "error", "reason": "classification.json missing"}))
        return 1

    notes = scan_vault_notes()
    dist = count_distribution(notes, classification)
    empty = find_empty_industries(classification, dist["by_industry"])
    crowded = find_overcrowded(classification, dist["by_industry"])
    new_tags = find_new_tag_candidates(dist["unknown_tag_freq"])

    if args.json:
        result = {
            "status": "ok",
            "total": dist["total"],
            "classified": dist["classified"],
            "unclassified": dist["unclassified"],
            "empty_industries": len(empty),
            "overcrowded_industries": len(crowded),
            "new_tag_candidates": len(new_tags),
            "by_sector": dist["by_sector"],
            "empty": empty[:10],
            "crowded": crowded[:5],
            "new_tags": new_tags[:10],
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    report = generate_audit_report(dist, empty, crowded, new_tags, classification)

    if not args.dry_run:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now().strftime("%Y-%m-%d")
        report_file = REPORT_DIR / f"taxonomy-audit-{date_str}.md"
        report_file.write_text(report, encoding="utf-8")
        print(f"Report saved: {report_file}")
    else:
        print(report)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
