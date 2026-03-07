"""Prompt interpreter — rule-first intent classification.

Deterministic keyword/pattern matching runs first.  An optional LLM pass
can be added later for fuzzy interpretation of ambiguous prompts, but
the engine should never hallucinate workflows — rules first, LLM second.

The interpreter wraps and extends ``packages.intent.classifier`` so all
existing regex patterns are reused.
"""

from __future__ import annotations

import re
from typing import Any

from packages.common.logging import get_logger
from packages.intent.classifier import classify_intent as _legacy_classify
from packages.intent.models import (
    Brand as LegacyBrand,
    Confidence,
    IntentCategory,
)

from .types import Intent, UserPrompt

logger = get_logger(__name__)

# Maps legacy IntentCategory → engine IntentType
_CATEGORY_MAP: dict[str, str] = {
    IntentCategory.INFORMATION.value: "question",
    IntentCategory.SYSTEM_HEALTH.value: "status_check",
    IntentCategory.WORKFLOW_EXECUTE.value: "run_workflow",
    IntentCategory.CONTENT_GENERATE.value: "generate_content",
    IntentCategory.APPROVAL_DECISION.value: "approval_decision",
    IntentCategory.ANALYSIS.value: "analysis",
    IntentCategory.CONFIGURATION.value: "configuration",
    IntentCategory.CONVERSATION.value: "conversation",
}

# Extra brand aliases beyond what the legacy classifier knows
_BRAND_ALIASES: dict[str, str] = {
    "full digital": "fulldigital",
    "fd": "fulldigital",
    "cutmv": "cutmv",
    "cut mv": "cutmv",
}

# Domain → workflow mapping for the engine layer
_DOMAIN_WORKFLOW: dict[str, str] = {
    "grantops": "grantops",
    "marketing": "marketing_ops",
    "sales": "sales_ops",
    "cluster": "system_health",
}

# Action-hint overrides for specific action_hints
_ACTION_WORKFLOW: dict[str, str] = {
    "daily_priorities": "daily_guidance",
    "health_check": "system_health",
    "ollama_status": "system_health",
    "generate_content": "content_generation",
    "content_calendar": "content_generation",
}


class PromptInterpreter:
    """Rule-first interpreter that bridges the legacy classifier and
    the prompt engine's richer Intent type.
    """

    def __init__(self, brand_aliases: dict[str, str] | None = None):
        self.brand_aliases = brand_aliases or _BRAND_ALIASES

    def parse(self, prompt: UserPrompt) -> Intent:
        text = prompt.text.strip()
        if not text:
            return Intent(
                intent_type="unknown",
                confidence=0.0,
                clarification_needed=True,
                clarification_question="It looks like you sent an empty message. What would you like me to do?",
            )

        # ── Fast-path: approval shortcuts ───────────────────────────────
        lower = text.lower()
        if lower.startswith(("approve ", "/approve")):
            return self._approval_intent(text, "approve", prompt)
        if lower.startswith(("deny ", "/deny", "reject ", "/reject")):
            return self._approval_intent(text, "deny", prompt)

        # ── Delegate to legacy classifier ───────────────────────────────
        channel_brand = self._resolve_brand_hint(prompt.brand_hint)
        classified = _legacy_classify(text, channel_brand=channel_brand)

        intent_type = _CATEGORY_MAP.get(classified.category.value, "unknown")
        confidence = self._confidence_to_float(classified.confidence)
        brand = None if classified.brand == LegacyBrand.UNKNOWN else classified.brand.value

        # If the classifier didn't find a brand, try our aliases
        if brand is None:
            brand = self._detect_brand(lower, prompt.brand_hint)

        # Map domain + action_hint → workflow
        workflow = (
            _ACTION_WORKFLOW.get(classified.action_hint)
            or _DOMAIN_WORKFLOW.get(classified.domain)
        )

        # ── Brand disambiguation ────────────────────────────────────────
        clarification_needed = False
        clarification_question = None

        if classified.needs_clarification:
            clarification_needed = True
            clarification_question = "Can you tell me what you'd like done in one sentence?"
        elif classified.needs_brand_disambiguation:
            clarification_needed = True
            clarification_question = "Is this for Full Digital or CUTMV?"

        intent = Intent(
            intent_type=intent_type,
            confidence=confidence,
            brand=brand,
            workflow=workflow,
            domain=classified.domain or None,
            entities=classified.entities,
            clarification_needed=clarification_needed,
            clarification_question=clarification_question,
            raw_prompt=text,
        )

        logger.info(
            "prompt_interpreted",
            extra={"extra": {
                "intent_type": intent.intent_type,
                "confidence": intent.confidence,
                "brand": intent.brand,
                "workflow": intent.workflow,
                "clarification_needed": intent.clarification_needed,
            }},
        )

        return intent

    # ── helpers ──────────────────────────────────────────────────────────

    def _approval_intent(self, text: str, decision: str, prompt: UserPrompt) -> Intent:
        # Try to extract an approval ID from the text
        approval_id = None
        id_match = re.search(r"approval_\w+", text)
        if id_match:
            approval_id = id_match.group(0)

        return Intent(
            intent_type="approval_decision",
            confidence=0.99,
            brand=self._detect_brand(text.lower(), prompt.brand_hint),
            entities={"decision": decision, "raw_text": text, "approval_id": approval_id},
        )

    def _detect_brand(self, text: str, brand_hint: str | None) -> str | None:
        if brand_hint:
            return brand_hint
        for alias, key in self.brand_aliases.items():
            if alias in text:
                return key
        return None

    def _resolve_brand_hint(self, hint: str | None) -> LegacyBrand | None:
        if hint is None:
            return None
        mapping = {"fulldigital": LegacyBrand.FULLDIGITAL, "cutmv": LegacyBrand.CUTMV}
        return mapping.get(hint)

    @staticmethod
    def _confidence_to_float(conf: Confidence) -> float:
        return {"high": 0.95, "medium": 0.7, "low": 0.3}.get(conf.value, 0.2)
