"""
Structural Gate — Layer 1 deterministic checks for non-coding task verification.
Fast (< 1s), no external calls. Runs before Grounding Gate and LLM Council.
"""
from dataclasses import dataclass, field
import re


@dataclass
class StructuralResult:
    passed: bool
    failures: list[str] = field(default_factory=list)
    details: str = ""

    @property
    def summary(self) -> str:
        if self.passed:
            return "Structural Gate: PASS ✅"
        return f"Structural Gate: FAIL ❌ — {'; '.join(self.failures)}"


def run_structural_gate(output: str, profile: dict) -> StructuralResult:
    """Run all structural checks defined in the profile."""
    checks = profile.get("structural_checks", [])
    min_words = profile.get("min_word_count", 0)
    required = profile.get("required_sections", [])
    failures = []

    for check in checks:
        if check == "word_count":
            words = len(output.split())
            if words < min_words:
                failures.append(f"word_count: {words} < {min_words} required")

        elif check == "no_empty_sections":
            # Split by markdown headers or double newlines
            sections = re.split(r"\n#{1,3} |\n\n", output)
            for i, section in enumerate(sections):
                if len(section.strip()) < 10 and section.strip():
                    failures.append(f"empty_section: section {i+1} has < 10 chars")

        elif check == "required_sections":
            output_lower = output.lower()
            for section in required:
                if section.lower() not in output_lower:
                    failures.append(f"missing_section: '{section}' not found")

        elif check == "sources_list":
            has_sources = any(
                re.match(r"[\-\*]\s+https?://", line)
                or re.match(r"\[\d+\]", line)
                or re.match(r"\[.+\]\(https?://", line)
                for line in output.split("\n")
            )
            if not has_sources:
                failures.append("sources_list: no references/URLs found")

        elif check == "has_steps":
            has_numbered = any(
                re.match(r"\d+[\.\)]\s", line.strip())
                for line in output.split("\n")
            )
            if not has_numbered:
                failures.append("has_steps: no numbered list found")
        # Unknown checks are skipped silently

    return StructuralResult(
        passed=len(failures) == 0,
        failures=failures,
        details="\n".join(failures) if failures else "All structural checks passed",
    )
