from __future__ import annotations

import re
from dataclasses import dataclass

URL_RE = re.compile(r"(https?://[^\s)>\]]+)", re.IGNORECASE)

KNOWN_DOMAINS: dict[str, str] = {
    "dropbox.com": "DROPBOX",
    "drive.google.com": "GOOGLE_DRIVE",
    "docs.google.com": "GOOGLE_DOCS",
    "box.com": "BOX",
    "vimeo.com": "VIMEO",
    "youtube.com": "YOUTUBE",
    "youtu.be": "YOUTUBE",
    "frame.io": "FRAMEIO",
}


@dataclass(frozen=True)
class ExtractedLink:
    url: str
    kind: str  # DROPBOX, GOOGLE_DRIVE, etc.
    role: str  # ASSETS, REFERENCE, DRAFT, FINAL, SCHEDULE, UNKNOWN
    confidence: float  # 0..1


def _domain(url: str) -> str:
    u = url.lower().replace("https://", "").replace("http://", "")
    return u.split("/")[0].replace("www.", "")


def extract_links(text: str) -> list[str]:
    """Extract all URLs from text."""
    if not text:
        return []
    return [m.group(1).rstrip(".,;") for m in URL_RE.finditer(text)]


def classify_link(url: str, *, context_text: str) -> ExtractedLink:
    """Classify a URL by platform and role based on surrounding context."""
    dom = _domain(url)
    kind = "UNKNOWN"
    for k, v in KNOWN_DOMAINS.items():
        if dom.endswith(k):
            kind = v
            break

    ctx = (context_text or "").lower()
    role = "UNKNOWN"
    confidence = 0.55

    # Heuristics based on nearby keywords in card description
    if any(w in ctx for w in [
        "master folder", "assets folder", "dropbox folder", "drive folder", "brand kit",
    ]):
        role = "ASSETS"
        confidence = 0.75
    if any(w in ctx for w in ["schedule", "release schedule", "calendar", "dates"]):
        role = "SCHEDULE"
        confidence = 0.70
    if any(w in ctx for w in ["draft", "preview", "wip", "rough"]):
        role = "DRAFT"
        confidence = 0.70
    if any(w in ctx for w in ["final", "approved", "deliver", "delivered", "publish"]):
        role = "FINAL"
        confidence = 0.72

    # Platform hints
    if kind in ("VIMEO", "YOUTUBE", "FRAMEIO"):
        if role == "UNKNOWN":
            role = "DRAFT"
            confidence = 0.62

    if kind in ("DROPBOX", "GOOGLE_DRIVE", "BOX") and role == "UNKNOWN":
        role = "REFERENCE"
        confidence = 0.60

    return ExtractedLink(url=url, kind=kind, role=role, confidence=confidence)


def extract_and_classify(text: str) -> list[ExtractedLink]:
    """Extract all URLs and classify each one."""
    urls = extract_links(text)
    # De-dupe by url while preserving order
    seen: dict[str, ExtractedLink] = {}
    for u in urls:
        if u not in seen:
            seen[u] = classify_link(u, context_text=text)
    return list(seen.values())


def rank_for_human_summary(links: list[ExtractedLink]) -> list[ExtractedLink]:
    """Choose the most useful links for humans.

    Priority: FINAL > DRAFT > ASSETS > SCHEDULE > REFERENCE > UNKNOWN,
    preferring higher confidence within each role.
    """
    role_priority = {
        "FINAL": 0,
        "DRAFT": 1,
        "ASSETS": 2,
        "SCHEDULE": 3,
        "REFERENCE": 4,
        "UNKNOWN": 5,
    }
    kind_priority = {
        "DROPBOX": 0,
        "GOOGLE_DRIVE": 1,
        "BOX": 2,
        "FRAMEIO": 3,
        "VIMEO": 4,
        "YOUTUBE": 5,
        "GOOGLE_DOCS": 6,
        "UNKNOWN": 9,
    }

    def key(lnk: ExtractedLink) -> tuple[int, int, float]:
        return (
            role_priority.get(lnk.role, 9),
            kind_priority.get(lnk.kind, 9),
            -lnk.confidence,
        )

    return sorted(links, key=key)
