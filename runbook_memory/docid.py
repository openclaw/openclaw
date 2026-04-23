from __future__ import annotations

import hashlib
import re
from typing import Iterable

DOC_ID_PREFIX = "rbk_"


def normalize_seed(parts: Iterable[object]) -> str:
    values: list[str] = []
    for part in parts:
        if part is None:
            continue
        value = str(part).strip().lower()
        if not value:
            continue
        value = re.sub(r"\s+", " ", value)
        values.append(value)
    return "\n".join(values)


def generate_doc_id(*parts: object, length: int = 12) -> str:
    seed = normalize_seed(parts)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return f"{DOC_ID_PREFIX}{digest[:length]}"
