"""
bodhi_vault.precognition.signals — Pure signal extraction from message text.

No external dependencies. No LLM calls. Stdlib only.
Completes in <10ms for any message length.

The goal: extract every observable signal that might indicate the sender's
nervous system state BEFORE the LLM generates a response. Not to diagnose.
To inform.

Design:
- All outputs are data, never judgements
- Somatic signals are extracted verbatim — not interpreted
- Crisis signals are phrase-matched against tiered lexicons
- ZPD proxy is a structural measure, not semantic
- Incongruence is a flag for the state inferrer, not resolved here
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# Crisis signal lexicons — three tiers
# RED: explicit, immediate, unambiguous
# ORANGE: hopelessness, worthlessness, profound withdrawal
# YELLOW: accumulating fatigue, isolation, loss of self
# ---------------------------------------------------------------------------

_RED_PHRASES: list[str] = [
    "kill myself", "end my life", "want to die", "want to be dead",
    "don't want to be here anymore", "don't want to exist",
    "better off dead", "better off without me",
    "can't go on", "can't do this anymore",
    "no reason to live", "nothing to live for",
    "end it all", "end it",
    "hurt myself", "harm myself",
    "suicide", "suicidal",
]

_ORANGE_PHRASES: list[str] = [
    "nothing matters", "nothing matters anymore",
    "what's the point", "whats the point",
    "i'm worthless", "im worthless", "i am worthless",
    "i'm a burden", "im a burden", "i am a burden",
    "nobody cares", "no one cares",
    "hopeless", "no hope",
    "i give up", "gave up",
    "completely empty", "feel empty",
    "completely numb", "feel numb",
    "disappear", "want to disappear",
    "can't feel anything", "cant feel anything",
]

_YELLOW_PHRASES: list[str] = [
    "haven't slept", "havent slept", "can't sleep", "cant sleep",
    "haven't eaten", "havent eaten", "can't eat", "cant eat",
    "exhausted", "completely drained", "running on empty",
    "losing myself", "losing who i am",
    "don't recognize myself", "dont recognize myself",
    "withdrawing", "pulling away", "isolating",
    "can't focus", "cant focus", "can't concentrate", "cant concentrate",
    "falling apart", "coming apart",
    "so tired", "too tired",
    "barely functioning",
    "going through the motions",
    "don't care anymore", "dont care anymore",
]


# ---------------------------------------------------------------------------
# Somatic / body language — extracted verbatim
# These are signals that the body is in the message
# ---------------------------------------------------------------------------

_SOMATIC_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\b(chest|stomach|gut|throat|shoulders|jaw|neck|back|head|heart)\b",
        r"\b(heavy|tight|tense|knotted|hollow|numb|burning|aching|sore|raw)\b",
        r"\b(can'?t breathe|short of breath|breath[ing]* (fast|shallow|hard))\b",
        r"\b(shaking|trembling|shaky)\b",
        r"\b(crying|sobbing|tears)\b",
        r"\b(sick|nauseous|dizzy|lightheaded)\b",
        r"\b(exhausted|drained|depleted|wiped)\b",
        r"\b(body|physical[ly]?)\b.*\b(telling|feel[s]?|knows|hurts?|aches?)\b",
        r"\b(feel[s]? it in (my|the))\b",
    ]
]

# ---------------------------------------------------------------------------
# Attachment signals
# ---------------------------------------------------------------------------

_REASSURANCE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bis that okay\b",
        r"\bam i doing this right\b",
        r"\bis this (normal|okay|fine|right|bad)\b",
        r"\bshould i (be|feel|do|have)\b",
        r"\bdo you think i\b",
        r"\bwas that wrong\b",
        r"\bam i (too|being too|overreacting)\b",
        r"\bare you (there|still there|with me)\b",
    ]
]

_INDEPENDENCE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bi('ve| have) got (it|this)\b",
        r"\bi don'?t need (help|advice|to be told)\b",
        r"\bi can (handle|figure|sort|manage) (it|this|myself)\b",
        r"\bjust (thinking|venting|talking)\b",
        r"\bnot looking for (advice|suggestions|help)\b",
        r"\bi know what (i need|to do)\b",
    ]
]

# ---------------------------------------------------------------------------
# Temporal / fatigue markers
# ---------------------------------------------------------------------------

_FATIGUE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bhaven'?t slept\b",
        r"\bno sleep\b",
        r"\b\d+ (days?|nights?|weeks?) (without|no) sleep\b",
        r"\bstill (awake|up)\b",
        r"\bcan'?t sleep\b",
        r"\bup (since|all night|all day)\b",
        r"\bexhausted\b",
        r"\bno energy\b",
    ]
]

# ---------------------------------------------------------------------------
# Positive incongruence markers — "I'm fine" language paired with distress
# ---------------------------------------------------------------------------

_FINE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bi'?m (fine|okay|ok|alright|good|great|fine actually)\b",
        r"\ball (good|fine|okay)\b",
        r"\bnot (that|a) big deal\b",
        r"\bjust (fine|okay|tired)\b",
        r"\bdon'?t worry (about me)?\b",
    ]
]


# ---------------------------------------------------------------------------
# ZPD proxy — structural complexity measures
# ---------------------------------------------------------------------------

def _sentence_lengths(text: str) -> list[int]:
    """Split into sentences and return word counts."""
    sentences = re.split(r'[.!?]+', text)
    return [len(s.split()) for s in sentences if s.strip()]


def _type_token_ratio(words: list[str]) -> float:
    """Lexical diversity: unique words / total words. Range 0-1."""
    if not words:
        return 0.0
    return len(set(w.lower() for w in words)) / len(words)


def _clause_depth(text: str) -> int:
    """Rough clause nesting depth via subordinating conjunctions + relative clauses."""
    subordinators = [
        "although", "because", "while", "whereas", "unless", "until",
        "even though", "so that", "in order that", "provided that",
        "which", "who", "that", "whose", "whom",
    ]
    depth = 0
    text_lower = text.lower()
    for sub in subordinators:
        depth += text_lower.count(sub)
    return depth


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

@dataclass
class MessageSignals:
    """
    All observable signals extracted from a single message.
    None of these are interpretations — they are measurements.
    """

    # --- Crisis ---
    red_signals: list[str] = field(default_factory=list)    # matched RED phrases
    orange_signals: list[str] = field(default_factory=list) # matched ORANGE phrases
    yellow_signals: list[str] = field(default_factory=list) # matched YELLOW phrases

    # --- Somatic ---
    somatic_mentions: list[str] = field(default_factory=list)  # verbatim body language matches

    # --- Attachment ---
    reassurance_seeking: bool = False
    independence_asserting: bool = False

    # --- Linguistic structure ---
    word_count: int = 0
    sentence_count: int = 0
    avg_sentence_length: float = 0.0
    sentence_length_variance: float = 0.0
    type_token_ratio: float = 0.0
    clause_depth: int = 0

    # --- Behavioral proxies ---
    caps_ratio: float = 0.0       # proportion of alphabetic chars that are uppercase
    punctuation_density: float = 0.0  # !?… per word
    emoji_count: int = 0

    # --- Fatigue ---
    fatigue_signals: list[str] = field(default_factory=list)

    # --- Incongruence proxy ---
    fine_language_present: bool = False  # "I'm fine" type language


def extract_signals(text: str) -> MessageSignals:
    """
    Extract all observable signals from a message body.

    Args:
        text: The raw message content as received.

    Returns:
        MessageSignals with all extracted features populated.
    """
    if not text:
        return MessageSignals()

    s = MessageSignals()
    text_lower = text.lower()

    # --- Crisis signals (phrase match, lowercase) ---
    for phrase in _RED_PHRASES:
        if phrase in text_lower:
            s.red_signals.append(phrase)

    for phrase in _ORANGE_PHRASES:
        if phrase in text_lower:
            s.orange_signals.append(phrase)

    for phrase in _YELLOW_PHRASES:
        if phrase in text_lower:
            s.yellow_signals.append(phrase)

    # --- Somatic mentions (regex, case-insensitive) ---
    for pattern in _SOMATIC_PATTERNS:
        for match in pattern.finditer(text):
            mention = match.group(0).strip()
            if mention and mention not in s.somatic_mentions:
                s.somatic_mentions.append(mention)

    # --- Attachment signals ---
    for p in _REASSURANCE_PATTERNS:
        if p.search(text):
            s.reassurance_seeking = True
            break
    for p in _INDEPENDENCE_PATTERNS:
        if p.search(text):
            s.independence_asserting = True
            break

    # --- Fatigue ---
    for p in _FATIGUE_PATTERNS:
        m = p.search(text)
        if m:
            s.fatigue_signals.append(m.group(0))

    # --- Fine language ---
    for p in _FINE_PATTERNS:
        if p.search(text):
            s.fine_language_present = True
            break

    # --- Linguistic structure ---
    words = text.split()
    s.word_count = len(words)
    sentence_lens = _sentence_lengths(text)
    s.sentence_count = len(sentence_lens)
    if sentence_lens:
        s.avg_sentence_length = sum(sentence_lens) / len(sentence_lens)
        mean = s.avg_sentence_length
        s.sentence_length_variance = sum((l - mean) ** 2 for l in sentence_lens) / len(sentence_lens)
    s.type_token_ratio = _type_token_ratio(words)
    s.clause_depth = _clause_depth(text)

    # --- Behavioral proxies ---
    alpha_chars = [c for c in text if c.isalpha()]
    if alpha_chars:
        upper = sum(1 for c in alpha_chars if c.isupper())
        # Sustained caps (not just sentence starts) — penalize whole-word caps
        all_caps_words = sum(1 for w in words if len(w) > 2 and w.isupper())
        s.caps_ratio = all_caps_words / len(words) if words else 0.0

    emphatic_punct = text.count('!') + text.count('?') + text.count('…')
    s.punctuation_density = emphatic_punct / len(words) if words else 0.0

    # Emoji detection via Unicode category Emoticons + Symbols
    s.emoji_count = sum(
        1 for c in text
        if unicodedata.category(c) in ('So', 'Sm') or ord(c) > 0x1F000
    )

    return s


def signals_to_dict(s: MessageSignals) -> dict[str, Any]:
    """Serialize to a plain dict for JSON storage."""
    return {
        "red_signals": s.red_signals,
        "orange_signals": s.orange_signals,
        "yellow_signals": s.yellow_signals,
        "somatic_mentions": s.somatic_mentions,
        "reassurance_seeking": s.reassurance_seeking,
        "independence_asserting": s.independence_asserting,
        "word_count": s.word_count,
        "sentence_count": s.sentence_count,
        "avg_sentence_length": round(s.avg_sentence_length, 2),
        "sentence_length_variance": round(s.sentence_length_variance, 2),
        "type_token_ratio": round(s.type_token_ratio, 3),
        "clause_depth": s.clause_depth,
        "caps_ratio": round(s.caps_ratio, 3),
        "punctuation_density": round(s.punctuation_density, 3),
        "emoji_count": s.emoji_count,
        "fatigue_signals": s.fatigue_signals,
        "fine_language_present": s.fine_language_present,
    }
