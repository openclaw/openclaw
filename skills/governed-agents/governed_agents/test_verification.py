#!/usr/bin/env python3
"""Unit Tests: Verification Gates"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from governed_agents.verifier import Verifier, VerificationResult
from governed_agents.orchestrator import GovernedOrchestrator
from governed_agents.reputation import init_db, get_task_history


def test_files_gate_pass():
    v = Verifier(required_files=[__file__])
    r = v.run()
    assert r.passed, f"Expected pass: {r.details}"
    print("✅ test_files_gate_pass")


def test_files_gate_fail():
    v = Verifier(required_files=["/nonexistent/path/file.py"])
    r = v.run()
    assert not r.passed
    assert r.gate_failed == "files"
    assert r.score_override == -1.0
    print("✅ test_files_gate_fail")


def test_tests_gate_pass():
    v = Verifier(run_tests='python3 -c "exit(0)"', check_syntax=False)
    r = v.run()
    assert r.passed, f"Expected pass: {r.details}"
    print("✅ test_tests_gate_pass")


def test_tests_gate_fail():
    v = Verifier(run_tests='python3 -c "exit(1)"', check_syntax=False)
    r = v.run()
    assert not r.passed
    assert r.gate_failed == "tests"
    print("✅ test_tests_gate_fail")


def test_lint_gate_skip():
    v = Verifier(run_lint=False, check_syntax=False)
    r = v.run()
    assert r.passed
    print("✅ test_lint_gate_skip")


def test_ast_gate_pass():
    v = Verifier(required_files=[__file__], check_syntax=True)
    r = v.run()
    assert r.passed, f"Expected pass: {r.details}"
    print("✅ test_ast_gate_pass")


def test_ast_gate_fail():
    with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
        f.write("def broken(\n  # unclosed paren\n")
        fname = f.name
    v = Verifier(required_files=[fname], check_syntax=True)
    r = v.run()
    assert not r.passed
    assert r.gate_failed == "ast"
    Path(fname).unlink(missing_ok=True)
    print("✅ test_ast_gate_fail")


def test_score_override_on_hallucinated_success():
    init_db()
    g = GovernedOrchestrator.for_task(
        "Test Hallucinated Success",
        model="openai/gpt-5.2-codex",
        criteria=["nonexistent file check"],
        required_files=["/nonexistent/hallucinated_output.py"],
    )
    result = g.record_success()
    assert not result.passed
    assert result.gate_failed == "files"
    assert result.score_override == -1.0

    tasks = get_task_history("openai-gpt-5_2-codex", limit=20)
    t = next((x for x in tasks if "Hallucinated" in (x.get("objective") or "")), None)
    assert t is not None, "Task not found in DB"
    assert t["score"] == -1.0, f"Expected -1.0, got {t['score']}"
    assert t["verification_passed"] == False
    assert t["gate_failed"] == "files"
    print("✅ test_score_override_on_hallucinated_success")


def test_blocked_skips_verification():
    g = GovernedOrchestrator.for_task(
        "Test Blocked Skip",
        model="openai/gpt-5.2-codex",
        criteria=["does not matter"],
        required_files=["/nonexistent/file.py"],  # würde fehlschlagen
    )
    # record_blocked soll NICHT verifizieren
    g.record_blocked("Cannot access resource")
    # Kein Assert auf Verification — einfach kein Crash
    print("✅ test_blocked_skips_verification")


if __name__ == "__main__":
    test_files_gate_pass()
    test_files_gate_fail()
    test_tests_gate_pass()
    test_tests_gate_fail()
    test_lint_gate_skip()
    test_ast_gate_pass()
    test_ast_gate_fail()
    test_score_override_on_hallucinated_success()
    test_blocked_skips_verification()
    print("\n🏆 ALL VERIFICATION GATE TESTS PASS")
