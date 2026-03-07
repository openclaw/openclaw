"""Conservative release-date extraction from card description text."""
from __future__ import annotations

import re
from datetime import date, datetime

# Patterns ordered from most specific to least:
# 1)  Release date: 03/15/2026   |  release date: 2026-03-15
# 2)  March 15, 2026
# 3)  3-15-26  /  03/15/26
#
# Only matches that appear near an explicit "release" keyword are accepted
# to avoid false positives on random dates.

_KEYWORD_RE = re.compile(
    r"release\s*(?:date)?\s*[:\-–—]?\s*", re.IGNORECASE
)

_ISO_RE = re.compile(r"(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})")
_US_RE = re.compile(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})")
_MONTH_NAME_RE = re.compile(
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+(\d{1,2}),?\s+(\d{4})",
    re.IGNORECASE,
)


def extract_release_date(text: str) -> str | None:
    """Return ISO date string (YYYY-MM-DD) if a release date is found, else None."""
    if not text:
        return None

    for match in _KEYWORD_RE.finditer(text):
        after = text[match.end(): match.end() + 60]

        # Named month: March 15, 2026
        m = _MONTH_NAME_RE.search(after)
        if m:
            try:
                dt = datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%B %d %Y")
                return dt.date().isoformat()
            except ValueError:
                pass

        # ISO: 2026-03-15
        m = _ISO_RE.search(after)
        if m:
            try:
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                return d.isoformat()
            except ValueError:
                pass

        # US: 03/15/2026 or 3-15-26
        m = _US_RE.search(after)
        if m:
            month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if year < 100:
                year += 2000
            try:
                d = date(year, month, day)
                return d.isoformat()
            except ValueError:
                pass

    return None
