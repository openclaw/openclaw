"""v15.1 stress tests — Multi-Turn Context Bridge & Bare URL Auto-Execution.

Tests the two new features introduced in v15.1:
1. Chat history bridge: per-user, last-5-turn context injection
2. Bare URL auto-execution: automatic action directive for standalone URLs

Run: python scripts/test_v15_1_multiturn.py
"""

import sys
import os

# Ensure repo root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from collections import deque

from src.handlers.prompt_handler import (
    _build_history_prefix,
    _enrich_bare_url,
    _get_chat_history,
    _MAX_HISTORY_TURNS,
    _MAX_TURN_CHARS,
)

PASSED = 0
FAILED = 0


def check(name: str, condition: bool, detail: str = ""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ✅ {name}")
    else:
        FAILED += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# Phase 1: Chat History Bridge tests
# ---------------------------------------------------------------------------
print("\n=== Phase 1: Chat History Bridge ===")


class FakeGateway:
    """Minimal gateway stub for testing."""
    pass


def test_lazy_init():
    """_get_chat_history creates storage on first access."""
    gw = FakeGateway()
    h = _get_chat_history(gw, 123)
    check("lazy init creates deque", isinstance(h, deque))
    check("lazy init — maxlen is correct", h.maxlen == _MAX_HISTORY_TURNS)
    check("lazy init — empty on first access", len(h) == 0)


def test_history_isolation():
    """Different users get separate histories."""
    gw = FakeGateway()
    h1 = _get_chat_history(gw, 1)
    h2 = _get_chat_history(gw, 2)
    h1.append(("msg1", "resp1"))
    check("user isolation — user2 unaffected", len(h2) == 0)
    check("user isolation — user1 has 1 turn", len(h1) == 1)


def test_max_turns_eviction():
    """History respects maxlen — oldest turns get evicted."""
    gw = FakeGateway()
    h = _get_chat_history(gw, 42)
    for i in range(_MAX_HISTORY_TURNS + 3):
        h.append((f"q{i}", f"a{i}"))
    check("max turns — deque length capped", len(h) == _MAX_HISTORY_TURNS)
    check("max turns — oldest evicted", h[0][0] == "q3")
    check("max turns — newest preserved", h[-1][0] == f"q{_MAX_HISTORY_TURNS + 2}")


def test_build_history_empty():
    """Empty history produces empty prefix."""
    result = _build_history_prefix(deque(maxlen=_MAX_HISTORY_TURNS))
    check("empty history — no prefix", result == "")


def test_build_history_format():
    """Non-empty history produces properly formatted prefix."""
    h: deque = deque(maxlen=_MAX_HISTORY_TURNS)
    h.append(("Hello", "Hi there"))
    h.append(("What is 2+2?", "4"))
    prefix = _build_history_prefix(h)
    check("prefix starts with header", "[CHAT HISTORY" in prefix)
    check("prefix contains User: turn", "User: Hello" in prefix)
    check("prefix contains Assistant: turn", "Assistant: Hi there" in prefix)
    check("prefix ends with CURRENT TASK", "[CURRENT TASK]:" in prefix)
    check("prefix has both turns", "User: What is 2+2?" in prefix and "Assistant: 4" in prefix)


def test_build_history_truncation():
    """Long messages are truncated with ellipsis."""
    h: deque = deque(maxlen=_MAX_HISTORY_TURNS)
    long_msg = "x" * (_MAX_TURN_CHARS + 100)
    h.append((long_msg, "short"))
    prefix = _build_history_prefix(h)
    check("long message truncated", f"{'x' * _MAX_TURN_CHARS}…" in prefix)
    check("short message not truncated", "Assistant: short" in prefix and "…" not in prefix.split("Assistant: short")[0].split("\n")[-1])


def test_session_reset_clears_history():
    """Simulates session reset clearing chat history."""
    gw = FakeGateway()
    h = _get_chat_history(gw, 99)
    h.append(("q", "a"))
    # Simulate session reset
    gw._chat_history.clear()
    h2 = _get_chat_history(gw, 99)
    check("session reset — history cleared", len(h2) == 0)


# ---------------------------------------------------------------------------
# Phase 2: Bare URL Auto-Execution tests
# ---------------------------------------------------------------------------
print("\n=== Phase 2: Bare URL Auto-Execution ===")


def test_bare_youtube_url():
    """Bare YouTube URL gets youtube_parser instruction."""
    result = _enrich_bare_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    check("bare YT URL — enriched", "youtube_parser" in result)
    check("bare YT URL — original URL preserved", "dQw4w9WgXcQ" in result)


def test_bare_youtube_short():
    """Short YouTube URL (youtu.be) gets enriched."""
    result = _enrich_bare_url("https://youtu.be/abc123")
    check("short YT URL — enriched", "youtube_parser" in result)


def test_bare_youtube_shorts():
    """YouTube Shorts URL gets enriched."""
    result = _enrich_bare_url("https://youtube.com/shorts/abc123")
    check("YT Shorts — enriched", "youtube_parser" in result)


def test_bare_web_url():
    """Bare HTTP URL (non-YouTube) gets web fetch instruction."""
    result = _enrich_bare_url("https://habr.com/ru/articles/123456/")
    check("bare web URL — enriched", "brave_web_search" in result or "fetch" in result)
    check("bare web URL — original URL preserved", "habr.com" in result)


def test_url_with_instruction_passthrough():
    """URL with explicit instruction is NOT modified."""
    prompt = "Проанализируй эту статью: https://habr.com/ru/articles/123456/"
    result = _enrich_bare_url(prompt)
    check("URL with instruction — not modified", result == prompt)


def test_normal_text_passthrough():
    """Normal text without URL is NOT modified."""
    prompt = "Напиши функцию сортировки на Python"
    result = _enrich_bare_url(prompt)
    check("normal text — not modified", result == prompt)


def test_url_with_short_filler():
    """URL + trivial filler (≤20 chars) IS enriched."""
    result = _enrich_bare_url("https://example.com вот")
    check("URL + filler — enriched", "brave_web_search" in result or "fetch" in result)


def test_url_with_long_instruction():
    """URL + substantial text (>20 chars) is NOT modified."""
    prompt = "https://example.com расскажи подробно что там написано и сделай анализ"
    result = _enrich_bare_url(prompt)
    check("URL + long text — not modified", result == prompt)


def test_multiple_urls_passthrough():
    """Multiple URLs in a prompt are NOT treated as bare URL."""
    prompt = "https://a.com https://b.com"
    result = _enrich_bare_url(prompt)
    check("multiple URLs — not modified", result == prompt)


def test_bare_url_whitespace():
    """URL with leading/trailing whitespace still enriched."""
    result = _enrich_bare_url("  https://youtube.com/watch?v=xyz  ")
    check("whitespace-padded URL — enriched", "youtube_parser" in result)


# ---------------------------------------------------------------------------
# Phase 3: Integration scenario tests
# ---------------------------------------------------------------------------
print("\n=== Phase 3: Integration Scenarios ===")


def test_history_then_bare_url():
    """Simulates multi-turn + bare URL: history prefix + enriched URL."""
    gw = FakeGateway()
    h = _get_chat_history(gw, 10)
    h.append(("check this channel", "Here's the analysis of the channel..."))

    prefix = _build_history_prefix(h)
    enriched = _enrich_bare_url("https://youtube.com/watch?v=test123")

    combined = prefix + enriched
    check("combined — has history header", "[CHAT HISTORY" in combined)
    check("combined — has current task marker", "[CURRENT TASK]:" in combined)
    check("combined — has youtube_parser", "youtube_parser" in combined)
    check("combined — has original context", "check this channel" in combined)


def test_history_full_cycle():
    """Simulates 7 turns — verifies only last 5 are kept."""
    gw = FakeGateway()
    h = _get_chat_history(gw, 77)
    for i in range(7):
        h.append((f"question_{i}", f"answer_{i}"))

    prefix = _build_history_prefix(h)
    check("full cycle — no question_0", "question_0" not in prefix)
    check("full cycle — no question_1", "question_1" not in prefix)
    check("full cycle — has question_2", "question_2" in prefix)
    check("full cycle — has question_6", "question_6" in prefix)


def test_referential_prompt_with_history():
    """Referential prompt ('do the same') — history provides context."""
    gw = FakeGateway()
    h = _get_chat_history(gw, 55)
    h.append(("analyze https://habr.com/article/1", "Here is the analysis of the Habr article..."))

    prefix = _build_history_prefix(h)
    prompt = "сделай то же самое для другой статьи"
    combined = prefix + prompt

    check("referential — history has habr context", "habr.com" in combined)
    check("referential — current prompt present", "сделай то же самое" in combined)


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("\n🧪 v15.1 Stress Tests: Multi-Turn Memory & Bare URL Forcing\n")

    test_lazy_init()
    test_history_isolation()
    test_max_turns_eviction()
    test_build_history_empty()
    test_build_history_format()
    test_build_history_truncation()
    test_session_reset_clears_history()

    test_bare_youtube_url()
    test_bare_youtube_short()
    test_bare_youtube_shorts()
    test_bare_web_url()
    test_url_with_instruction_passthrough()
    test_normal_text_passthrough()
    test_url_with_short_filler()
    test_url_with_long_instruction()
    test_multiple_urls_passthrough()
    test_bare_url_whitespace()

    test_history_then_bare_url()
    test_history_full_cycle()
    test_referential_prompt_with_history()

    total = PASSED + FAILED
    print(f"\n{'='*50}")
    print(f"Results: {PASSED}/{total} passed, {FAILED} failed")
    if FAILED:
        print("❌ SOME TESTS FAILED")
        sys.exit(1)
    else:
        print("✅ ALL TESTS PASSED")
        sys.exit(0)
