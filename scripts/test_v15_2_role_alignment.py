"""v15.2 stress tests — Omni-Role Alignment & Deep Context Propagation.

Tests:
1. Universal CRITICAL EXECUTION DIRECTIVES injection into ALL roles
2. Role-specific mandates (Researcher, Coder, Planner, Auditor, Analyst)
3. Deep context propagation — [CHAT HISTORY] survives compression & decomposition
4. Anti-laziness: forbidden phrases absent from system prompts' final block

Run: python scripts/test_v15_2_role_alignment.py
"""

import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.pipeline_utils import build_role_prompt, emergency_compress

PASSED = 0
FAILED = 0
FRAMEWORK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check(name: str, condition: bool, detail: str = ""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ✅ {name}")
    else:
        FAILED += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))


def _make_role_config(system_prompt: str = "You are a helpful AI.") -> dict:
    return {"system_prompt": system_prompt}


# ---------------------------------------------------------------------------
# Phase 1: Universal CRITICAL EXECUTION DIRECTIVES
# ---------------------------------------------------------------------------
print("\n=== Phase 1: Universal CRITICAL EXECUTION DIRECTIVES ===")

_ALL_ROLES = [
    "Researcher", "Analyst", "Summarizer", "Coder",
    "Executor_Tools", "Executor_Architect", "Planner", "Foreman",
    "Auditor", "Archivist", "State_Manager", "Test_Writer",
]


def test_critical_directives_in_all_roles():
    """Every role's system prompt must end with [CRITICAL EXECUTION DIRECTIVES]."""
    for role in _ALL_ROLES:
        prompt = build_role_prompt(role, _make_role_config(), FRAMEWORK_ROOT)
        check(
            f"{role} has CRITICAL DIRECTIVES",
            "[CRITICAL EXECUTION DIRECTIVES" in prompt,
            f"Missing in {role}",
        )


def test_critical_directives_content():
    """The directives block must contain all four rules."""
    prompt = build_role_prompt("Researcher", _make_role_config(), FRAMEWORK_ROOT)
    check("has ZERO-SHOT ACTION", "ZERO-SHOT ACTION" in prompt)
    check("has NO REFUSALS", "NO REFUSALS" in prompt)
    check("has NO FILLER", "NO FILLER" in prompt)
    check("has ASSUME CONTEXT", "ASSUME CONTEXT" in prompt)


def test_critical_directives_is_last_block():
    """CRITICAL EXECUTION DIRECTIVES must be the last protocol block."""
    prompt = build_role_prompt("Coder", _make_role_config(), FRAMEWORK_ROOT)
    idx = prompt.rfind("[CRITICAL EXECUTION DIRECTIVES")
    # Nothing else major after it (only the directives text remains)
    after = prompt[idx:]
    check(
        "CRITICAL DIRECTIVES is terminal block",
        after.count("\n[") <= 1,  # only the header line itself
        f"Found extra sections after CRITICAL DIRECTIVES",
    )


def test_fast_path_no_directives():
    """Fast-path (task_type set) should NOT get the heavy directives."""
    prompt = build_role_prompt("Researcher", _make_role_config(), FRAMEWORK_ROOT, task_type="general")
    check(
        "fast-path skips CRITICAL DIRECTIVES",
        "[CRITICAL EXECUTION DIRECTIVES" not in prompt,
    )


# ---------------------------------------------------------------------------
# Phase 2: Role-Specific Hyper-Alignment
# ---------------------------------------------------------------------------
print("\n=== Phase 2: Role-Specific Mandates ===")


def test_researcher_mandate():
    """Researcher must have URL-first tool call mandate."""
    prompt = build_role_prompt("Researcher", _make_role_config(), FRAMEWORK_ROOT)
    check("Researcher has URL tool mandate", "web_search" in prompt or "youtube_parser" in prompt)
    check("Researcher has EXECUTION MANDATE", "EXECUTION MANDATE" in prompt)


def test_analyst_mandate():
    """Analyst must have URL-first and data analysis mandate."""
    prompt = build_role_prompt("Analyst", _make_role_config(), FRAMEWORK_ROOT)
    check("Analyst has URL tool mandate", "web_search" in prompt or "youtube_parser" in prompt)
    check("Analyst has EXECUTION MANDATE", "EXECUTION MANDATE" in prompt)


def test_coder_mandate():
    """Coder must have no-placeholder and complete-code mandate."""
    prompt = build_role_prompt("Coder", _make_role_config(), FRAMEWORK_ROOT)
    check("Coder forbids placeholders", "rest of the code" in prompt or "ЗАПРЕЩЕНО" in prompt)
    check("Coder has EXECUTION MANDATE", "EXECUTION MANDATE" in prompt)


def test_planner_mandate():
    """Planner must have structured output mandate."""
    prompt = build_role_prompt("Planner", _make_role_config(), FRAMEWORK_ROOT)
    check("Planner has numbered list directive", "нумерованный список" in prompt.lower() or "EXECUTION MANDATE" in prompt)
    check("Planner has EXECUTION MANDATE", "EXECUTION MANDATE" in prompt)


def test_auditor_mandate():
    """Auditor must have precision review mandate."""
    prompt = build_role_prompt("Auditor", _make_role_config(), FRAMEWORK_ROOT)
    check("Auditor has line numbers directive", "номера строк" in prompt.lower() or "строк" in prompt)
    check("Auditor has EXECUTION MANDATE", "EXECUTION MANDATE" in prompt)


# ---------------------------------------------------------------------------
# Phase 3: Deep Context Propagation
# ---------------------------------------------------------------------------
print("\n=== Phase 3: Deep Context Propagation ===")


def test_emergency_compress_preserves_chat_history():
    """emergency_compress must keep [CHAT HISTORY] block intact."""
    history_prefix = (
        "[CHAT HISTORY — last conversation turns]:\n"
        "User: Напиши сортировку\n"
        "Assistant: Вот quicksort...\n\n"
        "[CURRENT TASK]:\n"
    )
    task = "Теперь добавь тесты для этой сортировки"
    pipeline_ctx = "x" * 3000  # large pipeline context to trigger compression

    step_prompt = (
        history_prefix + task + "\n\n"
        "[PIPELINE CONTEXT from previous step]\n" + pipeline_ctx + "\n\n"
        "[ORIGINAL USER TASK]\n" + history_prefix + task
    )

    compressed = emergency_compress(step_prompt, 500, "Coder")
    check(
        "compressed keeps CHAT HISTORY header",
        "[CHAT HISTORY" in compressed,
    )
    check(
        "compressed keeps CURRENT TASK marker",
        "[CURRENT TASK]:" in compressed,
    )
    check(
        "compressed keeps user turn",
        "сортировк" in compressed,
    )


def test_emergency_compress_no_history():
    """emergency_compress without history works as before."""
    step_prompt = (
        "[PIPELINE CONTEXT from previous step]\nsome context\n\n"
        "[ORIGINAL USER TASK]\nDo something"
    )
    compressed = emergency_compress(step_prompt, 5000, "Researcher")
    check("no-history compress — preserves ORIGINAL USER TASK", "[ORIGINAL USER TASK]" in compressed)
    check("no-history compress — no spurious CHAT HISTORY", "[CHAT HISTORY" not in compressed)


def test_multi_task_decomposition_preserves_history():
    """_decompose_multi_task + _execute_multi_task should propagate history."""
    # This is a structural test — we verify the code path exists
    import ast
    core_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src", "pipeline", "_core.py",
    )
    with open(core_path, "r", encoding="utf-8") as f:
        source = f.read()
    check(
        "multi-task has CHAT HISTORY extraction",
        "[CHAT HISTORY" in source and "[CURRENT TASK]:" in source and "_history_block" in source,
    )
    check(
        "multi-task prepends history to sub-tasks",
        "_history_block + text" in source or "history_block" in source,
    )


# ---------------------------------------------------------------------------
# Phase 4: Anti-Laziness Checks (prompt structure)
# ---------------------------------------------------------------------------
print("\n=== Phase 4: Anti-Laziness Structural Checks ===")


def test_zero_shot_autonomy_in_all_roles():
    """All roles must have ZERO-SHOT AUTONOMY protocol."""
    for role in _ALL_ROLES:
        prompt = build_role_prompt(role, _make_role_config(), FRAMEWORK_ROOT)
        check(
            f"{role} has ZERO-SHOT AUTONOMY",
            "ZERO-SHOT AUTONOMY" in prompt,
        )


def test_no_conversational_defaults():
    """System prompts should not end with generic conversational instructions."""
    for role in ["Coder", "Researcher", "Executor_Tools"]:
        prompt = build_role_prompt(role, _make_role_config(), FRAMEWORK_ROOT)
        last_200 = prompt[-200:]
        check(
            f"{role} — no 'I am an AI' in tail",
            "I am an AI" not in last_200 and "Я — ИИ" not in last_200,
        )


def test_kill_list_present():
    """All roles must have the Kill List for forbidden phrases."""
    for role in ["Researcher", "Coder", "Planner"]:
        prompt = build_role_prompt(role, _make_role_config(), FRAMEWORK_ROOT)
        check(f"{role} has Kill List", "KILL" in prompt or "ЗАПРЕЩ" in prompt)


# ---------------------------------------------------------------------------
# Phase 5: Integration — combined prompt structure
# ---------------------------------------------------------------------------
print("\n=== Phase 5: Integration — Full Prompt Structure ===")


def test_researcher_full_prompt_flow():
    """Researcher's full prompt has: system_prompt + executor_protocol + researcher_mandate + directives."""
    prompt = build_role_prompt("Researcher", _make_role_config("You are a web researcher."), FRAMEWORK_ROOT)
    # Check ordering: mandate before directives
    mandate_pos = prompt.find("EXECUTION MANDATE")
    directives_pos = prompt.find("CRITICAL EXECUTION DIRECTIVES")
    check(
        "mandate before directives",
        0 < mandate_pos < directives_pos,
        f"mandate@{mandate_pos}, directives@{directives_pos}",
    )


def test_coder_full_prompt_flow():
    """Coder prompt layers: base → executor_protocol → knowledge → coder_mandate → directives."""
    prompt = build_role_prompt("Coder", _make_role_config("You are a code generator."), FRAMEWORK_ROOT)
    layers = [
        ("base", "code generator"),
        ("EXECUTION MANDATE", "EXECUTION MANDATE"),
        ("CRITICAL EXECUTION DIRECTIVES", "CRITICAL EXECUTION DIRECTIVES"),
    ]
    prev_pos = -1
    for name, marker in layers:
        pos = prompt.find(marker)
        check(f"Coder layer order: {name}", pos > prev_pos, f"{name} at {pos}, prev at {prev_pos}")
        prev_pos = pos


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("\n🧪 v15.2 Stress Tests: Omni-Role Alignment & Deep Context Propagation\n")

    test_critical_directives_in_all_roles()
    test_critical_directives_content()
    test_critical_directives_is_last_block()
    test_fast_path_no_directives()

    test_researcher_mandate()
    test_analyst_mandate()
    test_coder_mandate()
    test_planner_mandate()
    test_auditor_mandate()

    test_emergency_compress_preserves_chat_history()
    test_emergency_compress_no_history()
    test_multi_task_decomposition_preserves_history()

    test_zero_shot_autonomy_in_all_roles()
    test_no_conversational_defaults()
    test_kill_list_present()

    test_researcher_full_prompt_flow()
    test_coder_full_prompt_flow()

    total = PASSED + FAILED
    print(f"\n{'='*50}")
    print(f"Results: {PASSED}/{total} passed, {FAILED} failed")
    if FAILED:
        print("❌ SOME TESTS FAILED")
        sys.exit(1)
    else:
        print("✅ ALL TESTS PASSED")
        sys.exit(0)
