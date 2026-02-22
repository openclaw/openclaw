"""
Task-Type Profiles — predefined Structural + Grounding gate configs per task category.
Based on @almai85's 3-layer verification architecture.
"""
from typing import Optional


# Profile schema:
# structural_checks: list of check names to run (layer 1, deterministic)
# grounding_checks:  list of check names to run (layer 2, semi-deterministic)
# min_word_count:    minimum words in output (0 = skip)
# required_sections: section headers that must appear in output

TASK_PROFILES: dict[str, dict] = {
    "research": {
        "structural_checks": ["word_count", "sources_list", "no_empty_sections"],
        "grounding_checks": ["url_reachable", "citations_present"],
        "min_word_count": 200,
        "required_sections": ["summary", "sources"],
    },
    "analysis": {
        "structural_checks": ["word_count", "required_sections", "no_empty_sections"],
        "grounding_checks": ["numbers_consistent"],
        "min_word_count": 150,
        "required_sections": ["findings", "conclusion"],
    },
    "strategy": {
        "structural_checks": ["required_sections", "no_empty_sections", "word_count"],
        "grounding_checks": ["cross_refs_resolve"],
        "min_word_count": 100,
        "required_sections": ["objective", "approach", "risks"],
    },
    "writing": {
        "structural_checks": ["word_count", "no_empty_sections"],
        "grounding_checks": [],
        "min_word_count": 50,
        "required_sections": [],
    },
    "planning": {
        "structural_checks": ["required_sections", "has_steps", "no_empty_sections"],
        "grounding_checks": ["dates_valid"],
        "min_word_count": 50,
        "required_sections": ["tasks", "timeline"],
    },
    "custom": {
        "structural_checks": [],
        "grounding_checks": [],
        "min_word_count": 0,
        "required_sections": [],
    },
}


def get_profile(task_type: str) -> dict:
    """Return gate profile for the given task type. Falls back to 'custom' if unknown."""
    return TASK_PROFILES.get(task_type, TASK_PROFILES["custom"])
