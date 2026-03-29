"""
v16.4 Stress Test: Autonomous Self-Healing & Verifiable Testing

Proves the full cycle:
  Error → Reflection (LLM) → Obsidian Learning_Log → Self-Healing Retry

SUPER-IMPORTANT: All output via print() for physical proof in terminal.
"""

import asyncio
import os
import sys
import traceback

# Ensure project root is on sys.path
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from src.pipeline._logic_provider import (
    LEARNING_LOG_PATH,
    _ensure_dirs,
    autonomous_reflection,
    is_tool_error,
    record_learning,
)

PASS = 0
FAIL = 0


def result(name: str, ok: bool):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}")


# --------------- Helpers ---------------

def _clear_learning_log():
    """Remove Learning_Log.md so we start clean."""
    if os.path.exists(LEARNING_LOG_PATH):
        os.remove(LEARNING_LOG_PATH)


def _read_learning_log() -> str:
    if os.path.exists(LEARNING_LOG_PATH):
        with open(LEARNING_LOG_PATH, "r", encoding="utf-8") as f:
            return f.read()
    return ""


# --------------- Tests ---------------

def test_is_tool_error():
    """Test that is_tool_error correctly identifies error responses."""
    print("\n[TEST 1] is_tool_error — error pattern detection")
    assert is_tool_error("⏳ TimeoutError: Tool 'shell' took too long")
    assert is_tool_error("❌ Execution Error in tool 'read_file': ENOENT")
    assert is_tool_error("🔒 SQLite Error: Database is locked.")
    assert is_tool_error("🛡️ PermissionError: You do not have access")
    assert is_tool_error("📁 FileNotFoundError: The requested file")
    assert is_tool_error("Error: Tool 'xyz' is not recognized.")
    assert not is_tool_error("Execution successful, but no output returned.")
    assert not is_tool_error("Here is the result of the query...")
    assert not is_tool_error("")
    assert not is_tool_error(None)  # type: ignore
    result("is_tool_error detects all patterns", True)


def test_record_learning_writes():
    """Test that record_learning physically writes to Learning_Log.md."""
    print("\n[TEST 2] record_learning — physical write to Obsidian")
    _clear_learning_log()
    _ensure_dirs()

    record_learning(
        task="Unit test: division by zero",
        error="ZeroDivisionError: division by zero",
        fix="Check denominator != 0 before dividing",
    )

    content = _read_learning_log()
    print("--- Learning_Log.md CONTENT (proof) ---")
    print(content)
    print("--- END ---")

    ok = "ZeroDivisionError" in content and "denominator" in content
    result("record_learning wrote to file", ok)
    return content


async def test_autonomous_reflection_no_llm():
    """Test autonomous_reflection with no LLM (fallback to auto-pattern)."""
    print("\n[TEST 3] autonomous_reflection — fallback without LLM")
    _clear_learning_log()
    _ensure_dirs()

    fix = await autonomous_reflection(
        task="API call to /v2/prices",
        code="resp = requests.get('https://api.example.com/v2/prices')",
        stderr="❌ Execution Error: 404 Not Found",
        inference_fn=None,  # no LLM — triggers auto-pattern fallback
    )

    print(f"  Fix rule returned: {fix}")
    content = _read_learning_log()
    print("--- Learning_Log.md AFTER REFLECTION ---")
    print(content)
    print("--- END ---")

    ok = fix != "" and "404" in content
    result("autonomous_reflection fallback recorded error", ok)


async def test_autonomous_reflection_with_mock_llm():
    """Test autonomous_reflection with a mock LLM that returns a fix rule."""
    print("\n[TEST 4] autonomous_reflection — mock LLM reflection")
    _clear_learning_log()
    _ensure_dirs()

    async def mock_llm(prompt: str) -> str:
        # Simulate LLM generating a fix rule
        return "Правило: Перед делением всегда проверяй, что знаменатель != 0. Используй try-except ZeroDivisionError."

    fix = await autonomous_reflection(
        task="Calculate average price",
        code="avg = total / count",
        stderr="ZeroDivisionError: division by zero",
        inference_fn=mock_llm,
    )

    print(f"  LLM Reflection result: {fix}")
    content = _read_learning_log()
    print("--- Learning_Log.md AFTER LLM REFLECTION ---")
    print(content)
    print("--- END ---")

    ok = "знаменатель" in fix and "ZeroDivisionError" in content
    result("LLM reflection recorded with fix rule", ok)


async def test_full_self_healing_cycle():
    """Full integration: Error → Traceback → Reflection → Learning_Log → Verify."""
    print("\n[TEST 5] FULL SELF-HEALING CYCLE — Error → Reflection → Obsidian → Verify")
    _clear_learning_log()
    _ensure_dirs()

    # Step 1: Simulate an error with traceback
    captured_tb = ""
    try:
        _ = 1 / 0
    except ZeroDivisionError:
        captured_tb = traceback.format_exc()

    print("=" * 60)
    print("[STEP 1] CAPTURED TRACEBACK:")
    print(captured_tb)
    print("=" * 60)

    # Step 2: Run autonomous reflection with mock LLM
    async def mock_llm_v2(prompt: str) -> str:
        return (
            "Правило-фикс: ZeroDivisionError возникает при count=0. "
            "Добавь guard clause: if count == 0: return 0.0"
        )

    fix_rule = await autonomous_reflection(
        task="Calculate user metrics",
        code="result = total_score / num_users  # num_users may be 0",
        stderr=captured_tb,
        inference_fn=mock_llm_v2,
    )

    print("=" * 60)
    print("[STEP 2] LLM REFLECTION RESULT:")
    print(fix_rule)
    print("=" * 60)

    # Step 3: Physical proof — read Learning_Log.md
    content = _read_learning_log()

    print("=" * 60)
    print("[STEP 3] file.read() of Learning_Log.md — PHYSICAL PROOF:")
    print(content)
    print("=" * 60)

    # Assertions
    ok_tb = "ZeroDivisionError" in captured_tb
    ok_fix = "guard clause" in fix_rule or "count == 0" in fix_rule
    ok_log = "ZeroDivisionError" in content and "guard clause" in content

    result("Traceback captured", ok_tb)
    result("LLM generated fix rule", ok_fix)
    result("Learning_Log.md contains full cycle data", ok_log)


async def test_reflection_empty_stderr():
    """autonomous_reflection returns empty string for empty stderr."""
    print("\n[TEST 6] autonomous_reflection — empty stderr returns ''")
    fix = await autonomous_reflection(task="noop", code="", stderr="", inference_fn=None)
    ok = fix == ""
    result("Empty stderr → empty fix", ok)


async def test_reflection_llm_exception():
    """autonomous_reflection handles LLM failure gracefully."""
    print("\n[TEST 7] autonomous_reflection — LLM exception fallback")
    _clear_learning_log()
    _ensure_dirs()

    async def broken_llm(prompt: str) -> str:
        raise ConnectionError("LLM server unreachable")

    fix = await autonomous_reflection(
        task="Test resilience",
        code="x = broken()",
        stderr="ConnectionError: refused",
        inference_fn=broken_llm,
    )

    print(f"  Fix (fallback): {fix}")
    ok = fix != "" and "auto" in fix.lower()
    result("LLM exception → auto-pattern fallback", ok)
    content = _read_learning_log()
    ok2 = "ConnectionError" in content
    result("Fallback still recorded to Learning_Log", ok2)


# --------------- Runner ---------------

async def main():
    print("=" * 60)
    print("  v16.4 STRESS TEST: Autonomous Self-Healing")
    print("  Verifiable Physical Logging — ALL output via print()")
    print("=" * 60)

    test_is_tool_error()
    test_record_learning_writes()
    await test_autonomous_reflection_no_llm()
    await test_autonomous_reflection_with_mock_llm()
    await test_full_self_healing_cycle()
    await test_reflection_empty_stderr()
    await test_reflection_llm_exception()

    print("\n" + "=" * 60)
    print(f"  RESULTS: {PASS} passed, {FAIL} failed, {PASS + FAIL} total")
    print("=" * 60)

    if FAIL > 0:
        sys.exit(1)
    print("\n🎉 ALL v16.4 TESTS PASSED — Self-Healing cycle verified!")


if __name__ == "__main__":
    asyncio.run(main())
