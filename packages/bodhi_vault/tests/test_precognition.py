"""
Tests for bodhi_vault.precognition — the pre-cognition layer.

Test philosophy: these scenarios come directly from the neuroscience foundations
document and the 11-point implementation philosophy. They are not abstract unit
tests — they test the system's ability to correctly infer state in the situations
that matter most clinically.

Key test scenarios (from spec):
- "I'm fine" with RED somatic signals → incongruence=True, tier=YELLOW minimum
- "I'm tired but need to work" → YELLOW, zpd=simplified, somatic_first=True
- Explicit crisis phrase → RED, emergency_flag=True
- 2am message with no prior context → YELLOW, circadian_phase=late_night
- Clean morning message with coherent language → GREEN
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from bodhi_vault.precognition.signals import extract_signals, MessageSignals
from bodhi_vault.precognition.state import (
    SomaticState,
    infer_state,
    _infer_circadian_phase,
    _infer_zpd,
)
from bodhi_vault.precognition.strategy import (
    ResponseStrategy,
    select_strategy,
    ORANGE_SOMATIC_QUESTION,
)
from bodhi_vault.precognition.somatic_store import (
    save_state,
    load_state,
    is_state_fresh,
    append_history,
    load_history,
    _state_from_dict,
)
from bodhi_vault.precognition import run_precognition


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts(hour: int, minute: int = 0) -> datetime:
    """Create a UTC datetime for a given hour today."""
    return datetime(2026, 3, 30, hour, minute, 0, tzinfo=timezone.utc)


def _morning() -> datetime:
    return _ts(9)

def _afternoon() -> datetime:
    return _ts(14)

def _late_night() -> datetime:
    return _ts(2)

def _car_window() -> datetime:
    return _ts(6, 30)


# ---------------------------------------------------------------------------
# Section 1: Signal extraction
# ---------------------------------------------------------------------------

class TestSignalExtraction:

    def test_empty_message(self):
        s = extract_signals("")
        assert s.word_count == 0
        assert s.red_signals == []
        assert s.somatic_mentions == []

    def test_red_signal_detected(self):
        s = extract_signals("I want to kill myself")
        assert "kill myself" in s.red_signals

    def test_red_signal_partial_match(self):
        s = extract_signals("I feel suicidal and don't know what to do")
        assert "suicidal" in s.red_signals

    def test_orange_signal_detected(self):
        s = extract_signals("nothing matters anymore, I give up")
        assert "nothing matters anymore" in s.orange_signals or "i give up" in s.orange_signals

    def test_yellow_signal_detected(self):
        s = extract_signals("I haven't slept in three days")
        assert any("haven't slept" in sig or "havent slept" in sig for sig in s.yellow_signals)

    def test_fatigue_signal_detected(self):
        s = extract_signals("I'm completely exhausted and can't focus")
        assert len(s.fatigue_signals) > 0

    def test_somatic_mention_chest(self):
        s = extract_signals("there's this tightness in my chest")
        assert any("chest" in m or "tight" in m for m in s.somatic_mentions)

    def test_somatic_mention_heavy(self):
        s = extract_signals("everything feels heavy today")
        assert any("heavy" in m for m in s.somatic_mentions)

    def test_somatic_mention_breathing(self):
        s = extract_signals("I can't breathe properly")
        assert any("breathe" in m or "breath" in m for m in s.somatic_mentions)

    def test_reassurance_seeking_detected(self):
        s = extract_signals("is that okay? am I doing this right?")
        assert s.reassurance_seeking is True

    def test_independence_asserting_detected(self):
        s = extract_signals("I've got it, I don't need advice on this")
        assert s.independence_asserting is True

    def test_fine_language_detected(self):
        s = extract_signals("I'm fine, don't worry about me")
        assert s.fine_language_present is True

    def test_fine_language_not_present_in_normal_message(self):
        s = extract_signals("I've been thinking about my sleep patterns lately")
        assert s.fine_language_present is False

    def test_caps_ratio_all_caps(self):
        s = extract_signals("I AM SO TIRED OF EVERYTHING")
        assert s.caps_ratio > 0

    def test_word_count(self):
        s = extract_signals("three words here")
        assert s.word_count == 3

    def test_no_crash_on_unicode(self):
        s = extract_signals("I feel 😔 so heavy today 💔")
        assert s.emoji_count >= 1

    def test_multiple_somatic_mentions_deduplicated(self):
        s = extract_signals("my chest is tight and my chest hurts")
        # Should not have "chest" twice
        chest_mentions = [m for m in s.somatic_mentions if "chest" in m]
        assert len(chest_mentions) == 1

    def test_crisis_phrase_case_insensitive(self):
        s = extract_signals("I Want To Kill Myself")
        assert "kill myself" in s.red_signals


# ---------------------------------------------------------------------------
# Section 2: Circadian phase inference
# ---------------------------------------------------------------------------

class TestCircadianPhase:

    def test_car_window_6am(self):
        assert _infer_circadian_phase(6) == "car"

    def test_car_window_7am(self):
        assert _infer_circadian_phase(7) == "car"

    def test_morning_8am(self):
        assert _infer_circadian_phase(8) == "morning"

    def test_morning_11am(self):
        assert _infer_circadian_phase(11) == "morning"

    def test_afternoon_12pm(self):
        assert _infer_circadian_phase(12) == "afternoon"

    def test_afternoon_4pm(self):
        assert _infer_circadian_phase(16) == "afternoon"

    def test_evening_5pm(self):
        assert _infer_circadian_phase(17) == "evening"

    def test_evening_8pm(self):
        assert _infer_circadian_phase(20) == "evening"

    def test_late_night_9pm(self):
        assert _infer_circadian_phase(21) == "late_night"

    def test_late_night_midnight(self):
        assert _infer_circadian_phase(0) == "late_night"

    def test_late_night_2am(self):
        assert _infer_circadian_phase(2) == "late_night"

    def test_late_night_5am(self):
        assert _infer_circadian_phase(5) == "late_night"


# ---------------------------------------------------------------------------
# Section 3: State inference — the clinical scenarios
# ---------------------------------------------------------------------------

class TestStateInference:

    def test_explicit_crisis_is_red(self):
        """RED phrase → RED tier unconditionally."""
        signals = extract_signals("I want to kill myself")
        state = infer_state(signals, _morning())
        assert state.tier == "red"

    def test_red_tier_with_fine_language_is_red_not_overridden(self):
        """'I'm fine' cannot override explicit crisis signals."""
        signals = extract_signals("I'm fine, I just want to kill myself")
        state = infer_state(signals, _morning())
        assert state.tier == "red"

    def test_fine_language_plus_crisis_signals_is_incongruent(self):
        """'I'm fine' + distress signals → incongruence_detected=True."""
        signals = extract_signals("I'm fine, it's nothing. I want to die though")
        state = infer_state(signals, _morning())
        assert state.incongruence_detected is True

    def test_tired_and_need_to_work_is_yellow(self):
        """Classic 'I'm tired but need to work' → YELLOW tier."""
        signals = extract_signals("I'm so tired but I still need to work, I can't focus")
        state = infer_state(signals, _afternoon())
        assert state.tier in ("yellow", "orange")  # YELLOW minimum

    def test_tired_and_need_to_work_somatic_first(self):
        """'I'm tired' + somatic signals → somatic_first in strategy."""
        signals = extract_signals("everything feels heavy, I can't keep going like this")
        state = infer_state(signals, _afternoon())
        strategy = select_strategy(state)
        assert strategy.somatic_first is True

    def test_2am_message_is_late_night(self):
        """2am message → circadian_phase=late_night."""
        signals = extract_signals("can't sleep, my mind won't stop")
        state = infer_state(signals, _late_night())
        assert state.circadian_phase == "late_night"

    def test_2am_fatigue_upgrades_to_yellow(self):
        """2am + sleep signal → YELLOW minimum."""
        signals = extract_signals("can't sleep, been awake for hours")
        state = infer_state(signals, _late_night())
        assert state.tier in ("yellow", "orange", "red")

    def test_clean_morning_message_is_green(self):
        """Coherent morning message with no distress → GREEN."""
        signals = extract_signals(
            "I've been thinking about how my sleep schedule affects my energy. "
            "I notice I feel better when I wake up naturally. "
            "What patterns do you think are worth tracking?"
        )
        state = infer_state(signals, _morning())
        assert state.tier == "green"

    def test_green_tier_normal_zpd(self):
        """Clean, coherent message → normal or complex ZPD."""
        signals = extract_signals(
            "I've been reflecting on the relationship between my cognitive clarity "
            "and my sleep quality. There seems to be a clear correlation when I examine "
            "the last two weeks of data."
        )
        state = infer_state(signals, _afternoon())
        assert state.zpd_estimate in ("normal", "complex")

    def test_orange_signal_is_orange(self):
        """Hopelessness language → ORANGE tier."""
        signals = extract_signals("nothing matters, I feel completely empty and worthless")
        state = infer_state(signals, _morning())
        assert state.tier == "orange"

    def test_sleep_signal_sets_flag(self):
        """Sleep deprivation language → sleep_signal=True."""
        signals = extract_signals("haven't slept in two days")
        state = infer_state(signals, _car_window())
        assert state.sleep_signal is True

    def test_late_night_plus_yellow_plus_somatic_is_orange(self):
        """Late night + withdrawal language + body signals → ORANGE."""
        signals = extract_signals(
            "it's 2am and I can't sleep. I'm losing myself. "
            "my chest is tight and I just want to disappear"
        )
        state = infer_state(signals, _late_night())
        assert state.tier in ("orange", "red")

    def test_reassurance_seeking_attachment(self):
        """Reassurance questions → attachment_signal=reassurance_seeking."""
        signals = extract_signals("is that okay? am I being too sensitive?")
        state = infer_state(signals, _morning())
        assert state.attachment_signal == "reassurance_seeking"

    def test_independence_asserting_attachment(self):
        """Independence language → attachment_signal=independence_asserting."""
        signals = extract_signals("I've got this, I don't need advice, just thinking out loud")
        state = infer_state(signals, _morning())
        assert state.attachment_signal == "independence_asserting"

    def test_somatic_signals_preserved_in_state(self):
        """Somatic mentions are verbatim-preserved in state."""
        signals = extract_signals("there's tightness in my chest and my shoulders are heavy")
        state = infer_state(signals, _morning())
        assert len(state.somatic_signals) > 0

    def test_crisis_signals_raw_populated(self):
        """crisis_signals_raw contains matched phrases."""
        signals = extract_signals("I feel suicidal and hopeless")
        state = infer_state(signals, _morning())
        assert len(state.crisis_signals_raw) > 0

    def test_timestamp_stored(self):
        """Timestamp is stored in state."""
        signals = extract_signals("hello")
        ts = _morning()
        state = infer_state(signals, ts)
        assert state.message_timestamp != ""

    def test_word_count_stored(self):
        signals = extract_signals("three words here")
        state = infer_state(signals, _morning())
        assert state.message_word_count == 3


# ---------------------------------------------------------------------------
# Section 4: Strategy selection
# ---------------------------------------------------------------------------

class TestStrategySelection:

    def test_red_tier_emergency_flag(self):
        signals = extract_signals("I want to kill myself")
        state = infer_state(signals, _morning())
        strategy = select_strategy(state)
        assert strategy.emergency_flag is True
        assert strategy.approach == "crisis"

    def test_red_tier_no_advising(self):
        signals = extract_signals("I want to end my life")
        state = infer_state(signals, _morning())
        strategy = select_strategy(state)
        assert strategy.ask_before_advising is False

    def test_orange_tier_somatic_only(self):
        signals = extract_signals("I feel completely empty and worthless, nothing matters")
        state = infer_state(signals, _morning())
        strategy = select_strategy(state)
        assert strategy.approach == "somatic_only"
        assert strategy.emergency_flag is False

    def test_yellow_tier_co_regulate_approach(self):
        signals = extract_signals("I'm exhausted and I feel like I'm losing myself")
        state = infer_state(signals, _afternoon())
        strategy = select_strategy(state)
        assert strategy.approach == "co_regulate_then_inquiry"

    def test_yellow_tier_simplified_zpd(self):
        """Late night fatigue → simplified complexity cap."""
        signals = extract_signals("can't sleep, so tired, everything hurts")
        state = infer_state(signals, _late_night())
        strategy = select_strategy(state)
        assert strategy.complexity_cap == "simplified"

    def test_green_tier_inquiry_approach(self):
        signals = extract_signals(
            "I've been thinking about the connection between my sleep and cognition"
        )
        state = infer_state(signals, _morning())
        strategy = select_strategy(state)
        assert strategy.approach == "inquiry"
        assert strategy.emergency_flag is False

    def test_green_tier_ask_before_advising(self):
        signals = extract_signals("I want to improve my sleep routine")
        state = infer_state(signals, _afternoon())
        strategy = select_strategy(state)
        assert strategy.ask_before_advising is True

    def test_presence_statement_not_empty_for_all_tiers(self):
        for text, ts in [
            ("I want to kill myself", _morning()),
            ("nothing matters anymore", _morning()),
            ("I'm exhausted", _late_night()),
            ("what a good day", _afternoon()),
        ]:
            signals = extract_signals(text)
            state = infer_state(signals, ts)
            strategy = select_strategy(state)
            assert strategy.presence_statement != ""

    def test_somatic_first_when_body_signals_present(self):
        signals = extract_signals("my chest is tight and I feel heavy")
        state = infer_state(signals, _morning())
        strategy = select_strategy(state)
        assert strategy.somatic_first is True


# ---------------------------------------------------------------------------
# Section 5: SOMATIC_CONTEXT markdown generation
# ---------------------------------------------------------------------------

class TestContextMarkdown:

    def test_context_contains_tier(self):
        signals = extract_signals("I want to kill myself")
        state = infer_state(signals, _morning())
        md = state.to_context_markdown()
        assert "RED" in md

    def test_context_contains_incongruence_warning(self):
        signals = extract_signals("I'm fine, just want to die is all")
        state = infer_state(signals, _morning())
        if state.incongruence_detected:
            md = state.to_context_markdown()
            assert "INCONGRUENCE" in md

    def test_context_contains_somatic_signals(self):
        signals = extract_signals("my chest is so tight I can barely breathe")
        state = infer_state(signals, _morning())
        md = state.to_context_markdown()
        if state.somatic_signals:
            assert "Body Signals" in md

    def test_context_contains_protocol(self):
        signals = extract_signals("hello")
        state = infer_state(signals, _morning())
        md = state.to_context_markdown()
        assert "Protocol" in md

    def test_context_green_no_emergency_language(self):
        signals = extract_signals("good morning, slept well today")
        state = infer_state(signals, _morning())
        md = state.to_context_markdown()
        assert "EMERGENCY" not in md


# ---------------------------------------------------------------------------
# Section 6: Persistence (somatic_store)
# ---------------------------------------------------------------------------

class TestSomaticStore:

    def _dummy_state(self) -> SomaticState:
        signals = extract_signals("I'm feeling okay today")
        return infer_state(signals, _morning())

    def test_save_and_load_roundtrip(self, tmp_path):
        state = self._dummy_state()
        path = tmp_path / "somatic-state.json"
        save_state(state, path)
        loaded = load_state(path)
        assert loaded is not None
        assert loaded.tier == state.tier
        assert loaded.circadian_phase == state.circadian_phase

    def test_load_nonexistent_returns_none(self, tmp_path):
        result = load_state(tmp_path / "nonexistent.json")
        assert result is None

    def test_load_malformed_returns_none(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json")
        result = load_state(path)
        assert result is None

    def test_state_is_fresh_just_written(self):
        signals = extract_signals("hello")
        state = infer_state(signals, datetime.now(tz=timezone.utc))
        assert is_state_fresh(state) is True

    def test_state_is_stale_old_timestamp(self):
        signals = extract_signals("hello")
        state = infer_state(signals, _ts(hour=2))  # old-ish hour used as proxy for stale
        # Override timestamp to something old
        from dataclasses import replace
        old_state = SomaticState(
            tier="green",
            circadian_phase="morning",
            message_timestamp="2020-01-01T00:00:00+00:00",
        )
        assert is_state_fresh(old_state) is False

    def test_none_state_is_not_fresh(self):
        assert is_state_fresh(None) is False

    def test_append_history_creates_file(self, tmp_path):
        state = self._dummy_state()
        path = tmp_path / "history.jsonl"
        append_history(state, path)
        assert path.exists()
        lines = path.read_text().strip().splitlines()
        assert len(lines) == 1

    def test_append_history_multiple(self, tmp_path):
        path = tmp_path / "history.jsonl"
        for _ in range(3):
            state = self._dummy_state()
            append_history(state, path)
        lines = path.read_text().strip().splitlines()
        assert len(lines) == 3

    def test_load_history_empty_if_no_file(self, tmp_path):
        result = load_history(tmp_path / "none.jsonl", days=7)
        assert result == []

    def test_save_is_atomic(self, tmp_path):
        """Verify no .tmp files are left behind after successful write."""
        state = self._dummy_state()
        path = tmp_path / "somatic-state.json"
        save_state(state, path)
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == []


# ---------------------------------------------------------------------------
# Section 7: Full pipeline (run_precognition)
# ---------------------------------------------------------------------------

class TestRunPrecognition:

    def test_returns_state_and_strategy(self, tmp_path, monkeypatch):
        # Redirect state files to tmp dir
        monkeypatch.setattr(
            "bodhi_vault.precognition.SOMATIC_STATE_PATH",
            tmp_path / "somatic-state.json"
        )
        monkeypatch.setattr(
            "bodhi_vault.precognition.SOMATIC_HISTORY_PATH",
            tmp_path / "somatic-history.jsonl"
        )
        state, strategy = run_precognition("I'm thinking about my sleep", _morning())
        assert isinstance(state, SomaticState)
        assert isinstance(strategy, ResponseStrategy)

    def test_crisis_text_returns_red(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "bodhi_vault.precognition.SOMATIC_STATE_PATH",
            tmp_path / "somatic-state.json"
        )
        monkeypatch.setattr(
            "bodhi_vault.precognition.SOMATIC_HISTORY_PATH",
            tmp_path / "somatic-history.jsonl"
        )
        state, strategy = run_precognition("I want to kill myself", _morning())
        assert state.tier == "red"
        assert strategy.emergency_flag is True

    def test_writes_state_file(self, tmp_path, monkeypatch):
        state_path = tmp_path / "somatic-state.json"
        history_path = tmp_path / "somatic-history.jsonl"
        monkeypatch.setattr("bodhi_vault.precognition.SOMATIC_STATE_PATH", state_path)
        monkeypatch.setattr("bodhi_vault.precognition.SOMATIC_HISTORY_PATH", history_path)
        run_precognition("hello world", _morning())
        assert state_path.exists()

    def test_appends_to_history(self, tmp_path, monkeypatch):
        state_path = tmp_path / "somatic-state.json"
        history_path = tmp_path / "somatic-history.jsonl"
        monkeypatch.setattr("bodhi_vault.precognition.SOMATIC_STATE_PATH", state_path)
        monkeypatch.setattr("bodhi_vault.precognition.SOMATIC_HISTORY_PATH", history_path)
        run_precognition("hello", _morning())
        run_precognition("world", _afternoon())
        lines = history_path.read_text().strip().splitlines()
        assert len(lines) == 2

    def test_empty_message_does_not_crash(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "bodhi_vault.precognition.SOMATIC_STATE_PATH",
            tmp_path / "somatic-state.json"
        )
        monkeypatch.setattr(
            "bodhi_vault.precognition.SOMATIC_HISTORY_PATH",
            tmp_path / "somatic-history.jsonl"
        )
        state, strategy = run_precognition("", _morning())
        assert state.tier == "green"  # empty = no signals = green


# ---------------------------------------------------------------------------
# Section 8: Safety invariants (the things that must NEVER happen)
# ---------------------------------------------------------------------------

class TestSafetyInvariants:

    def test_red_phrase_always_produces_emergency_flag(self):
        """No matter what else is in the message, RED phrase → emergency_flag."""
        red_messages = [
            "I want to kill myself",
            "I want to end my life",
            "I'm suicidal",
            "want to die",
            "better off dead",
        ]
        for msg in red_messages:
            signals = extract_signals(msg)
            state = infer_state(signals, _morning())
            strategy = select_strategy(state)
            assert strategy.emergency_flag is True, f"Failed for: {msg}"

    def test_fine_language_cannot_override_crisis(self):
        """'I'm fine' does not move tier away from RED when crisis signals present."""
        signals = extract_signals("I'm totally fine, just want to kill myself")
        state = infer_state(signals, _morning())
        assert state.tier == "red"

    def test_orange_approach_is_never_inquiry(self):
        """ORANGE tier never uses full inquiry approach."""
        signals = extract_signals("nothing matters, I feel empty and worthless")
        state = infer_state(signals, _morning())
        state_orange = SomaticState(
            tier="orange",
            circadian_phase="morning",
            message_timestamp="2026-03-30T09:00:00+00:00",
        )
        strategy = select_strategy(state_orange)
        assert strategy.approach != "inquiry"

    def test_red_approach_is_never_inquiry(self):
        """RED tier never uses inquiry approach."""
        state_red = SomaticState(
            tier="red",
            circadian_phase="morning",
            message_timestamp="2026-03-30T09:00:00+00:00",
        )
        strategy = select_strategy(state_red)
        assert strategy.approach == "crisis"
        assert strategy.approach != "inquiry"

    def test_somatic_store_no_crashes_on_bad_input(self, tmp_path):
        """Store functions never crash on bad/missing data."""
        assert load_state(tmp_path / "nonexistent.json") is None
        bad = tmp_path / "bad.json"
        bad.write_text("{}")
        assert load_state(bad) is None  # missing required keys → None
