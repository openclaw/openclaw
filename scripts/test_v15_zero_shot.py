#!/usr/bin/env python3
"""v15.0 Zero-Shot Autonomy Stress Test.

Validates that the prompt refactoring from v15.0 eliminates:
1. Fillers ("Давайте рассмотрим...", "Хороший вопрос!", conversational padding)
2. Refusals ("Я как языковая модель...", "Я не могу...", ask_user for actionable tasks)
3. Description-instead-of-action ("Я бы выполнил поиск...", "Рекомендую проверить...")
4. Empty delegation (punting vague prompts back to user)

Tests run against build_role_prompt() output and AFlow chain generation.
No live LLM calls required — validates system prompt content and chain routing.
"""

import asyncio
import os
import re
import sys
import unittest

# Ensure repo root is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.pipeline._aflow import (
    AFlowEngine,
    _BRIGADE_ENRICHMENT,
    _VAGUE_INDICATORS,
)
from src.pipeline_utils import (
    _ANALYST_EXECUTION_MANDATE,
    _CODER_EXECUTION_MANDATE,
    _RESEARCHER_EXECUTION_MANDATE,
    _ZERO_SHOT_AUTONOMY_PROTOCOL,
    build_role_prompt,
    clean_response_for_user,
)

FRAMEWORK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────

def _build(role: str):
    return build_role_prompt(role, {"system_prompt": "base"}, FRAMEWORK_ROOT)


# ──────────────────────────────────────────────────────────────────
# Test Suite: Zero-Shot Autonomy Protocol Injection
# ──────────────────────────────────────────────────────────────────

class TestZeroShotProtocolInjection(unittest.TestCase):
    """Verify that ZERO_SHOT_AUTONOMY_PROTOCOL is injected into ALL roles."""

    ROLES = [
        "Planner", "Foreman", "Coder", "Executor_Tools", "Executor_Architect",
        "Auditor", "Archivist", "Researcher", "Analyst", "Summarizer",
        "State_Manager", "Test_Writer",
    ]

    def test_all_roles_have_autonomy_directive(self):
        for role in self.ROLES:
            prompt = _build(role)
            self.assertIn(
                "ZERO-SHOT AUTONOMY",
                prompt,
                f"Role '{role}' missing ZERO-SHOT AUTONOMY protocol",
            )

    def test_all_roles_ban_fillers(self):
        for role in self.ROLES:
            prompt = _build(role)
            self.assertIn(
                "ЗАПРЕТ ФИЛЛЕРА",
                prompt,
                f"Role '{role}' missing anti-filler directive",
            )

    def test_all_roles_ban_refusal(self):
        for role in self.ROLES:
            prompt = _build(role)
            self.assertIn(
                "ОТКАЗ ЗАПРЕЩЁН",
                prompt,
                f"Role '{role}' missing refusal ban",
            )

    def test_vague_prompt_handling_directive(self):
        for role in self.ROLES:
            prompt = _build(role)
            self.assertIn(
                "РАЗМЫТЫЙ ЗАПРОС",
                prompt,
                f"Role '{role}' missing vague prompt handling rule",
            )


# ──────────────────────────────────────────────────────────────────
# Test Suite: Role-Specific Execution Mandates
# ──────────────────────────────────────────────────────────────────

class TestRoleExecutionMandates(unittest.TestCase):
    """Verify role-specific mandates force artifact production."""

    def test_researcher_mandate(self):
        prompt = _build("Researcher")
        self.assertIn("EXECUTION MANDATE", prompt)
        self.assertIn("ОБЯЗАН вызвать инструменты", prompt)

    def test_coder_mandate(self):
        prompt = _build("Coder")
        self.assertIn("EXECUTION MANDATE", prompt)
        self.assertIn("ПОЛНЫЙ работающий код", prompt)

    def test_executor_tools_gets_coder_mandate(self):
        prompt = _build("Executor_Tools")
        self.assertIn("EXECUTION MANDATE", prompt)

    def test_analyst_mandate(self):
        prompt = _build("Analyst")
        self.assertIn("EXECUTION MANDATE", prompt)
        self.assertIn("КОНКРЕТНЫЙ анализ", prompt)

    def test_planner_autonomy_over_ask_user(self):
        prompt = _build("Planner")
        self.assertIn("v15.0 AUTONOMY", prompt)
        self.assertIn("ask_user — ПОСЛЕДНИЙ вариант", prompt)

    def test_auditor_has_no_execution_mandate(self):
        """Auditor is a reviewer, not an executor — should NOT get execution mandate."""
        prompt = _build("Auditor")
        self.assertNotIn("EXECUTION MANDATE", prompt)

    def test_archivist_has_no_execution_mandate(self):
        """Archivist is a formatter, not an executor — should NOT get execution mandate."""
        prompt = _build("Archivist")
        self.assertNotIn("EXECUTION MANDATE", prompt)


# ──────────────────────────────────────────────────────────────────
# Test Suite: AFlow Vague Prompt Enrichment
# ──────────────────────────────────────────────────────────────────

class TestAFlowVagueEnrichment(unittest.TestCase):
    """Verify AFlow enriches vague prompts instead of punting."""

    def test_vague_indicators_detect_common_patterns(self):
        vague_prompts = [
            "напиши что-нибудь прикольное",
            "сделай что-то интересное",
            "проверь что-нибудь",
            "создай что-то круто",
            "найди что-нибудь интересное",
        ]
        for p in vague_prompts:
            self.assertTrue(
                _VAGUE_INDICATORS.search(p),
                f"Vague prompt not detected: '{p}'",
            )

    def test_concrete_prompts_not_flagged(self):
        concrete = [
            "напиши функцию для парсинга JSON",
            "найди ошибку в src/pipeline.py",
            "создай REST API для DMarket",
            "проверь тесты в tests/",
        ]
        for p in concrete:
            self.assertIsNone(
                _VAGUE_INDICATORS.search(p),
                f"Concrete prompt wrongly flagged as vague: '{p}'",
            )

    def test_brigade_enrichment_contexts_exist(self):
        for brigade in ("Dmarket-Dev", "OpenClaw-Core", "Research-Ops"):
            self.assertIn(brigade, _BRIGADE_ENRICHMENT)
            self.assertTrue(len(_BRIGADE_ENRICHMENT[brigade]) > 10)

    def test_aflow_enriches_vague_for_dmarket(self):
        engine = AFlowEngine()
        result = asyncio.run(
            engine.generate_chain(
                "напиши что-нибудь прикольное",
                "Dmarket-Dev",
                ["Planner", "Coder", "Auditor"],
            )
        )
        # Should still produce a valid chain (not empty, not error)
        self.assertTrue(len(result.chain) >= 2)
        self.assertIn(result.source, ("heuristic", "fallback"))

    def test_aflow_enriches_vague_for_research(self):
        engine = AFlowEngine()
        result = asyncio.run(
            engine.generate_chain(
                "найди что-нибудь интересное",
                "Research-Ops",
                ["Researcher", "Analyst", "Summarizer", "Auditor"],
            )
        )
        self.assertTrue(len(result.chain) >= 2)


# ──────────────────────────────────────────────────────────────────
# Test Suite: Protocol Content Quality
# ──────────────────────────────────────────────────────────────────

class TestProtocolContentQuality(unittest.TestCase):
    """Verify protocol constant quality and completeness."""

    def test_zero_shot_protocol_has_all_four_rules(self):
        self.assertIn("ПРАВИЛО №1", _ZERO_SHOT_AUTONOMY_PROTOCOL)
        self.assertIn("ПРАВИЛО №2", _ZERO_SHOT_AUTONOMY_PROTOCOL)
        self.assertIn("ПРАВИЛО №3", _ZERO_SHOT_AUTONOMY_PROTOCOL)
        self.assertIn("ПРАВИЛО №4", _ZERO_SHOT_AUTONOMY_PROTOCOL)

    def test_protocol_includes_tool_mapping(self):
        self.assertIn("youtube_parser", _ZERO_SHOT_AUTONOMY_PROTOCOL)
        self.assertIn("web_search_mcp", _ZERO_SHOT_AUTONOMY_PROTOCOL)
        self.assertIn("sandbox_execute", _ZERO_SHOT_AUTONOMY_PROTOCOL)

    def test_researcher_mandate_bans_description(self):
        self.assertIn("Не пиши 'Я бы выполнил поиск...'", _RESEARCHER_EXECUTION_MANDATE)

    def test_coder_mandate_bans_examples(self):
        self.assertIn("Вот пример кода", _CODER_EXECUTION_MANDATE)

    def test_analyst_mandate_bans_suggestions(self):
        self.assertIn("Не пиши 'Следует проанализировать...'", _ANALYST_EXECUTION_MANDATE)


# ──────────────────────────────────────────────────────────────────
# Test Suite: Response Cleanup (v15.0 additions)
# ──────────────────────────────────────────────────────────────────

class TestResponseCleanupV15(unittest.TestCase):
    """Verify clean_response_for_user strips v15.0 protocol remnants."""

    def test_strips_execution_mandate_remnants(self):
        text = "Результат:\n[EXECUTION MANDATE — CODER v15.0]\nКод тут."
        cleaned = clean_response_for_user(text)
        self.assertNotIn("EXECUTION MANDATE", cleaned)
        self.assertIn("Код тут", cleaned)

    def test_strips_critical_directive_remnants(self):
        text = "Ответ:\n[CRITICAL DIRECTIVE: ZERO-SHOT AUTONOMY — v15.0]\nДанные тут."
        cleaned = clean_response_for_user(text)
        self.assertNotIn("CRITICAL DIRECTIVE", cleaned)
        self.assertIn("Данные тут", cleaned)


# ──────────────────────────────────────────────────────────────────
# Test Suite: Backward Compatibility
# ──────────────────────────────────────────────────────────────────

class TestBackwardCompatibility(unittest.TestCase):
    """Ensure v14.x code that imports _ANTI_REFUSAL_PROTOCOL still works."""

    def test_anti_refusal_alias_exists(self):
        from src.pipeline_utils import _ANTI_REFUSAL_PROTOCOL
        self.assertIn("ZERO-SHOT AUTONOMY", _ANTI_REFUSAL_PROTOCOL)

    def test_anti_refusal_is_same_as_zero_shot(self):
        from src.pipeline_utils import _ANTI_REFUSAL_PROTOCOL
        self.assertIs(_ANTI_REFUSAL_PROTOCOL, _ZERO_SHOT_AUTONOMY_PROTOCOL)


if __name__ == "__main__":
    print("=" * 70)
    print("  v15.0 ZERO-SHOT AUTONOMY — Stress Test Suite")
    print("=" * 70)
    unittest.main(verbosity=2)
