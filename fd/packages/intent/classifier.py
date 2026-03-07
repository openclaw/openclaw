"""Intent classifier — maps natural language prompts to structured intents.

Uses keyword/pattern matching as a fast first pass. When Ollama is available,
the classifier can delegate to a local LLM for ambiguous prompts.

The classifier is the first step in the prompt-first pipeline:
  prompt → classify → map → plan → execute → respond
"""

from __future__ import annotations

import re
from typing import Optional

from packages.intent.models import (
    Brand,
    ClassifiedIntent,
    Confidence,
    IntentCategory,
)

# ── Keyword Patterns ──
# Each pattern maps to (category, domain, action_hint).
# Order matters — first match wins within a category.

_PATTERNS: list[tuple[re.Pattern, IntentCategory, str, str]] = [
    # System health — both word orders: "check the cluster" / "cluster health"
    (re.compile(r"\b(check|status|health|alive|online|running)\b.*\b(cluster|system|node|m[14]|i7|server)\b", re.I), IntentCategory.SYSTEM_HEALTH, "cluster", "health_check"),
    (re.compile(r"\b(cluster|system|node)\b.*\b(check|status|health|running|alive|online)\b", re.I), IntentCategory.SYSTEM_HEALTH, "cluster", "health_check"),
    (re.compile(r"\bollama\b.*\b(status|running|online)\b", re.I), IntentCategory.SYSTEM_HEALTH, "cluster", "ollama_status"),
    # "Is the cluster running?" pattern
    (re.compile(r"\bcluster\b.*\brunning\b", re.I), IntentCategory.SYSTEM_HEALTH, "cluster", "health_check"),

    # Approval decisions
    (re.compile(r"^\s*(approve|accept|confirm|yes|go ahead|proceed)\s*$", re.I), IntentCategory.APPROVAL_DECISION, "", "approve"),
    (re.compile(r"^\s*(reject|deny|cancel|abort)\s*$", re.I), IntentCategory.APPROVAL_DECISION, "", "reject"),
    (re.compile(r"\b(approve|accept|confirm)\b.*\b(this|it|that|submission|grant|campaign)\b", re.I), IntentCategory.APPROVAL_DECISION, "", "approve"),
    (re.compile(r"\b(reject|deny|cancel)\b.*\b(this|it|that|submission|grant|campaign)\b", re.I), IntentCategory.APPROVAL_DECISION, "", "reject"),

    # GrantOps workflows — more specific patterns first
    (re.compile(r"\b(run|start|execute)\b.*\bgrant\s*(scan|search)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "daily_scan"),
    (re.compile(r"\bgrant\b.*\b(scan|search)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "daily_scan"),
    (re.compile(r"\b(submit|apply|send)\b.*\bgrants?\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "submit"),
    (re.compile(r"\bgrants?\b.*\b(submit|apply|application)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "submit"),
    (re.compile(r"\b(draft|prepare)\b.*\bgrant\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "draft_package"),
    (re.compile(r"\bgrant\b.*\b(draft|prepare|package)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "draft_package"),
    # Discovery: "find grants" or "grants find" in either order
    (re.compile(r"\b(find|scan|search|discover|look for)\b.*\b(grant|grants|funding)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "discovery"),
    (re.compile(r"\b(grant|grants|funding)\b.*\b(find|scan|search|discover)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "grantops", "discovery"),

    # Marketing / content — both word orders
    (re.compile(r"\b(generate|create|write|draft|make)\b.*\b(ad|ads|hook|hooks|caption|captions|script|scripts|copy|content|promo)\b", re.I), IntentCategory.CONTENT_GENERATE, "marketing", "generate_content"),
    (re.compile(r"\b(ad|ads|hook|hooks|caption|captions|script|scripts)\b.*\b(generate|create|write)\b", re.I), IntentCategory.CONTENT_GENERATE, "marketing", "generate_content"),
    (re.compile(r"\b(campaign|launch|promote)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "marketing", "campaign"),
    (re.compile(r"\b(content\s*calendar|schedule\s*content|plan\s*content)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "marketing", "content_calendar"),

    # Sales / pipeline
    (re.compile(r"\b(pipeline|leads?|prospects?|follow.?up)\b", re.I), IntentCategory.INFORMATION, "sales", "pipeline_status"),
    (re.compile(r"\b(proposal|quote|outreach)\b", re.I), IntentCategory.WORKFLOW_EXECUTE, "sales", "outreach"),

    # Analysis
    (re.compile(r"\b(why|analyze|analysis|compare|trend|performance|underperform)\b", re.I), IntentCategory.ANALYSIS, "", ""),
    (re.compile(r"\b(report|summary|digest|overview)\b", re.I), IntentCategory.INFORMATION, "", "summary"),

    # Configuration
    (re.compile(r"\b(enable|disable|configure|change|update|set)\b.*\b(setting|config|mode|schedule)\b", re.I), IntentCategory.CONFIGURATION, "", ""),
    (re.compile(r"\b(enable|disable)\b.*\b(grantops|marketing|dry.?run)\b", re.I), IntentCategory.CONFIGURATION, "", ""),

    # Information requests
    (re.compile(r"\b(show|list|what|how many|tell me|get)\b", re.I), IntentCategory.INFORMATION, "", ""),
    (re.compile(r"\b(today|priority|tasks?|focus)\b", re.I), IntentCategory.INFORMATION, "", "daily_priorities"),
]

# Brand detection patterns
_BRAND_PATTERNS: list[tuple[re.Pattern, Brand]] = [
    (re.compile(r"\bfull\s*digital\b", re.I), Brand.FULLDIGITAL),
    (re.compile(r"\bfd\b", re.I), Brand.FULLDIGITAL),
    (re.compile(r"\bcutmv\b", re.I), Brand.CUTMV),
    (re.compile(r"\bcut\s*mv\b", re.I), Brand.CUTMV),
]


def classify_intent(
    prompt: str,
    channel_brand: Optional[Brand] = None,
) -> ClassifiedIntent:
    """Classify a natural language prompt into a structured intent.

    Args:
        prompt: The raw user prompt.
        channel_brand: Brand context from the channel binding (if known).

    Returns:
        ClassifiedIntent with category, confidence, brand, and action hint.
    """
    prompt_clean = prompt.strip()
    if not prompt_clean:
        return ClassifiedIntent(
            category=IntentCategory.CONVERSATION,
            confidence=Confidence.LOW,
            raw_prompt=prompt,
        )

    # Step 1: Detect brand
    brand = channel_brand or Brand.UNKNOWN
    if brand == Brand.UNKNOWN:
        for pattern, detected_brand in _BRAND_PATTERNS:
            if pattern.search(prompt_clean):
                brand = detected_brand
                break

    # Step 2: Match intent patterns
    matched_category = IntentCategory.CONVERSATION
    matched_domain = ""
    matched_action = ""
    confidence = Confidence.LOW

    for pattern, category, domain, action_hint in _PATTERNS:
        if pattern.search(prompt_clean):
            matched_category = category
            matched_domain = domain
            matched_action = action_hint
            confidence = Confidence.HIGH
            break

    # Step 3: Extract entities (numbers, dates, counts)
    entities: dict = {}
    # Try digit match first, then word-numbers
    count_match = re.search(r"\b(\d+)\b", prompt_clean)
    if count_match:
        entities["count"] = int(count_match.group(1))
    else:
        word_numbers = {
            "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
            "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
        }
        for word, num in word_numbers.items():
            if re.search(rf"\b{word}\b", prompt_clean, re.I):
                entities["count"] = num
                break

    # Step 4: If no pattern matched but prompt is a question, it's information
    if matched_category == IntentCategory.CONVERSATION:
        if prompt_clean.endswith("?"):
            matched_category = IntentCategory.INFORMATION
            confidence = Confidence.MEDIUM

    # Step 5: Downgrade confidence if brand is ambiguous for brand-specific actions
    if brand == Brand.UNKNOWN and matched_category in (
        IntentCategory.WORKFLOW_EXECUTE,
        IntentCategory.CONTENT_GENERATE,
    ):
        if matched_domain in ("marketing", "sales"):
            confidence = Confidence.MEDIUM

    return ClassifiedIntent(
        category=matched_category,
        confidence=confidence,
        brand=brand,
        domain=matched_domain,
        action_hint=matched_action,
        entities=entities,
        raw_prompt=prompt,
    )
