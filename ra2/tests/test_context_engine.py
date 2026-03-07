"""Tests for ra2.context_engine"""

import json
import pytest
from ra2 import ledger, sigil, token_gate
from ra2.context_engine import build_context


@pytest.fixture(autouse=True)
def tmp_storage(monkeypatch, tmp_path):
    """Redirect all storage to temp directories."""
    monkeypatch.setattr(ledger, "LEDGER_DIR", str(tmp_path / "ledgers"))
    monkeypatch.setattr(sigil, "SIGIL_DIR", str(tmp_path / "sigils"))
    # Default: sigil hidden from prompt
    monkeypatch.setattr(sigil, "DEBUG_SIGIL", False)


class TestBuildContext:
    def test_basic_output_shape(self):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        result = build_context("test-stream", messages)
        assert "prompt" in result
        assert "token_estimate" in result
        assert isinstance(result["prompt"], str)
        assert isinstance(result["token_estimate"], int)

    def test_prompt_structure_default(self):
        messages = [
            {"role": "user", "content": "Let's build a context engine"},
        ]
        result = build_context("s1", messages)
        prompt = result["prompt"]
        assert "=== LEDGER ===" in prompt
        assert "=== LIVE WINDOW ===" in prompt
        assert "Respond concisely" in prompt
        # Sigil should NOT appear by default
        assert "INTERNAL SIGIL SNAPSHOT" not in prompt

    def test_sigil_hidden_by_default(self):
        messages = [
            {"role": "user", "content": "We forked to context_sov"},
        ]
        result = build_context("s1", messages)
        # Event should be recorded in JSON but not in prompt
        state = sigil.load("s1")
        assert len(state["event"]) > 0
        assert "INTERNAL SIGIL SNAPSHOT" not in result["prompt"]

    def test_sigil_shown_when_debug(self, monkeypatch):
        monkeypatch.setattr(sigil, "DEBUG_SIGIL", True)
        messages = [
            {"role": "user", "content": "We forked to context_sov"},
        ]
        result = build_context("s1", messages)
        assert "=== INTERNAL SIGIL SNAPSHOT ===" in result["prompt"]

    def test_live_window_content(self):
        messages = [
            {"role": "user", "content": "message one"},
            {"role": "assistant", "content": "response one"},
        ]
        result = build_context("s1", messages)
        assert "[user] message one" in result["prompt"]
        assert "[assistant] response one" in result["prompt"]

    def test_redaction_applied(self):
        messages = [
            {"role": "user", "content": "my key is sk-abc123def456ghi789jklmnopqrs"},
        ]
        result = build_context("s1", messages)
        assert "sk-abc" not in result["prompt"]
        assert "[REDACTED_SECRET]" in result["prompt"]

    def test_compression_updates_ledger(self):
        messages = [
            {"role": "user", "content": "we will use deterministic compression"},
            {"role": "assistant", "content": "decided to skip AI summarization"},
        ]
        build_context("s1", messages)
        data = ledger.load("s1")
        assert data["delta"] != ""

    def test_compression_detects_blockers(self):
        messages = [
            {"role": "user", "content": "I'm blocked on rate limit issues"},
        ]
        build_context("s1", messages)
        data = ledger.load("s1")
        assert len(data["blockers"]) > 0

    def test_compression_detects_open_questions(self):
        messages = [
            {"role": "user", "content": "should we use tiktoken for counting?"},
        ]
        build_context("s1", messages)
        data = ledger.load("s1")
        assert len(data["open"]) > 0

    def test_sigil_event_generation(self):
        messages = [
            {"role": "user", "content": "We forked to context_sov"},
        ]
        build_context("s1", messages)
        state = sigil.load("s1")
        assert len(state["event"]) > 0
        assert state["event"][0]["operator"] == "fork"

    def test_sigil_dedup_across_calls(self):
        messages = [
            {"role": "user", "content": "We forked to context_sov"},
        ]
        build_context("s1", messages)
        build_context("s1", messages)
        state = sigil.load("s1")
        # Same triple should not be duplicated
        assert len(state["event"]) == 1

    def test_token_estimate_positive(self):
        messages = [{"role": "user", "content": "hello"}]
        result = build_context("s1", messages)
        assert result["token_estimate"] > 0

    def test_window_shrinks_on_large_input(self, monkeypatch):
        monkeypatch.setattr(token_gate, "MAX_TOKENS", 200)
        monkeypatch.setattr(token_gate, "LIVE_WINDOW", 16)
        messages = [
            {"role": "user", "content": f"This is message number {i} with some content"}
            for i in range(20)
        ]
        result = build_context("s1", messages)
        assert result["token_estimate"] <= 200

    def test_hard_fail_on_impossible_budget(self, monkeypatch):
        monkeypatch.setattr(token_gate, "MAX_TOKENS", 5)
        monkeypatch.setattr(token_gate, "LIVE_WINDOW", 4)
        messages = [
            {"role": "user", "content": "x" * 1000},
        ]
        with pytest.raises(token_gate.TokenBudgetExceeded):
            build_context("s1", messages)

    def test_structured_content_blocks(self):
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Hello from structured content"},
                ],
            },
        ]
        result = build_context("s1", messages)
        assert "Hello from structured content" in result["prompt"]

    def test_no_md_history_injection(self):
        messages = [{"role": "user", "content": "just this"}]
        result = build_context("s1", messages)
        assert "just this" in result["prompt"]
        assert ".md" not in result["prompt"]

    def test_debug_sigil_snapshot_is_valid_json(self, monkeypatch):
        monkeypatch.setattr(sigil, "DEBUG_SIGIL", True)
        messages = [
            {"role": "user", "content": "We forked to context_sov"},
        ]
        result = build_context("s1", messages)
        # Extract the sigil JSON from the prompt
        prompt = result["prompt"]
        marker = "=== INTERNAL SIGIL SNAPSHOT ==="
        assert marker in prompt
        start = prompt.index(marker) + len(marker)
        end = prompt.index("=== LEDGER ===")
        sigil_json = prompt[start:end].strip()
        data = json.loads(sigil_json)
        assert "event" in data
        assert "state" in data
