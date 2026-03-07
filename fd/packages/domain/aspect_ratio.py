from __future__ import annotations

import re

AR_PATTERNS: list[tuple[str, str]] = [
    (r"\b1\s*:\s*1\b|\b1x1\b", "AR: 1:1"),
    (r"\b4\s*:\s*5\b|\b4x5\b", "AR: 4:5"),
    (r"\b9\s*:\s*16\b|\b9x16\b|\bvertical\b", "AR: 9:16"),
    (r"\b16\s*:\s*9\b|\b16x9\b|\bhorizontal\b", "AR: 16:9"),
]


def detect_aspect_ratio_labels(text: str) -> list[str]:
    t = text or ""
    found = []
    for pattern, label in AR_PATTERNS:
        if re.search(pattern, t, flags=re.IGNORECASE):
            found.append(label)
    return sorted(list(set(found)))
