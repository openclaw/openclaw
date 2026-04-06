#!/usr/bin/env python3
"""Extract a pickleball invite list from a Google Contacts export/merge CSV.

Designed for Davo's workflow:
- Source of truth: a CSV like `pkb_contacts_merged_YYYY-MM-DD-vN.csv`
- Filter: only rows whose `Last Name` contains the exact substring `CKS` (case-sensitive)
- Rating extraction:
  1) Prefer `LR:<number>` anywhere in First Name / Old Last Name / Last Name
  2) Else find the first `[3-5].<digit+>` anywhere
- Keep rating in inclusive range [minRating, maxRating]
- First name output: first word of `First Name` field, capitalized
- Include Phone + Email in output
- Optionally discard already-signed-up people via fuzzy name match

Outputs:
- Invite list CSV: First Name, Last Name, Rating, Phone, Email
- Failures CSV: rows where rating couldn't be extracted
"""

import argparse
import csv
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable


LR_RE = re.compile(r"\bLR:\s*([0-9]+(?:\.[0-9]+)?)", re.I)
ALT_RE = re.compile(r"([345]\.\d+)")


def norm(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def similarity(a: str, b: str) -> float:
    a = norm(a)
    b = norm(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def extract_rating(*fields: str) -> float | None:
    hay = " ".join([f for f in fields if f])
    m = LR_RE.search(hay)
    if m:
        return float(m.group(1))
    m2 = ALT_RE.search(hay)
    if m2:
        return float(m2.group(1))
    return None


def first_word_capitalized(first_name_field: str) -> str:
    first_name_field = (first_name_field or "").strip()
    if not first_name_field:
        return ""
    return first_name_field.split()[0].capitalize()


def load_discard_list(text: str | None) -> list[str]:
    if not text:
        return []
    # allow comma-separated or newline-separated
    parts = re.split(r"[\n,]+", text)
    return [p.strip() for p in parts if p.strip()]


def should_discard(contact_first_name_field: str, discard_names: Iterable[str], threshold: float) -> bool:
    for dn in discard_names:
        if norm(dn) in norm(contact_first_name_field):
            return True
        if similarity(dn, contact_first_name_field) >= threshold:
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True, help="Input contacts CSV")
    ap.add_argument("--out", dest="out_path", required=True, help="Output invite list CSV")
    ap.add_argument("--failures", dest="fail_path", required=True, help="Output failures CSV")
    ap.add_argument("--min", dest="min_rating", type=float, default=3.4)
    ap.add_argument("--max", dest="max_rating", type=float, default=4.7)
    ap.add_argument(
        "--tag",
        dest="tag",
        default="CKS",
        help="Case-sensitive substring required in Last Name (default: CKS)",
    )
    ap.add_argument(
        "--discard",
        dest="discard",
        default="",
        help="Comma/newline separated names to discard (already signed up)",
    )
    ap.add_argument(
        "--discard-threshold",
        dest="discard_threshold",
        type=float,
        default=0.72,
        help="Fuzzy similarity threshold for discard matching",
    )

    args = ap.parse_args()

    in_path = Path(args.in_path)
    out_path = Path(args.out_path)
    fail_path = Path(args.fail_path)

    discard_names = load_discard_list(args.discard)

    kept_rows: list[dict] = []
    fail_rows: list[dict] = []

    with in_path.open(newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            last = row.get("Last Name", "") or ""
            if args.tag not in last:
                continue

            rating = extract_rating(
                row.get("First Name", "") or "",
                row.get("Old Last Name", "") or "",
                row.get("Last Name", "") or "",
            )

            if rating is None:
                fail_rows.append(
                    {
                        "Reason": "no rating found",
                        "First Name": row.get("First Name", ""),
                        "Last Name": row.get("Last Name", ""),
                        "Email": row.get("Email", ""),
                        "Phone": row.get("Phone", ""),
                        "Raw": " ".join(
                            [
                                row.get("First Name", "") or "",
                                row.get("Old Last Name", "") or "",
                                row.get("Last Name", "") or "",
                            ]
                        ).strip(),
                    }
                )
                continue

            if rating < args.min_rating or rating > args.max_rating:
                continue

            first_field = (row.get("First Name") or "").strip()
            if not first_field:
                fail_rows.append(
                    {
                        "Reason": "missing first name",
                        "First Name": "",
                        "Last Name": row.get("Last Name", ""),
                        "Email": row.get("Email", ""),
                        "Phone": row.get("Phone", ""),
                        "Raw": "(empty First Name)",
                    }
                )
                continue

            if discard_names and should_discard(first_field, discard_names, args.discard_threshold):
                continue

            kept_rows.append(
                {
                    "First Name": first_word_capitalized(first_field),
                    "Last Name": last,
                    "Rating": rating,
                    "Phone": (row.get("Phone") or "").strip(),
                    "Email": (row.get("Email") or "").strip(),
                }
            )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fail_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["First Name", "Last Name", "Rating", "Phone", "Email"])
        w.writeheader()
        for rr in sorted(kept_rows, key=lambda x: (-x["Rating"], x["Last Name"], x["First Name"])):
            w.writerow(rr)

    with fail_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Reason", "First Name", "Last Name", "Email", "Phone", "Raw"])
        w.writeheader()
        w.writerows(fail_rows)

    print(f"kept={len(kept_rows)} failures={len(fail_rows)} out={out_path} fail={fail_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
