"""Tests for the brain.db todo system with templates."""
import json
import os
import tempfile

import pytest

os.environ["CORTEX_DATA_DIR"] = tempfile.mkdtemp()

from brain import UnifiedBrain


@pytest.fixture
def brain():
    """Fresh brain instance per test."""
    import tempfile
    d = tempfile.mkdtemp()
    return UnifiedBrain(db_path=os.path.join(d, "test.db"))


class TestTodoBasics:
    def test_add_and_list(self, brain):
        todo = brain.todo_add("Buy milk", priority="low", tags=["shopping"])
        assert todo["id"].startswith("todo_")
        assert todo["title"] == "Buy milk"
        assert todo["status"] == "open"
        assert todo["priority"] == "low"
        assert todo["tags"] == ["shopping"]

        items = brain.todo_list()
        assert len(items) == 1
        assert items[0]["title"] == "Buy milk"

    def test_add_with_all_fields(self, brain):
        todo = brain.todo_add(
            title="Deploy v4",
            description="Full deploy with rollback",
            priority="critical",
            assigned_to="helios",
            tags=["deploy", "augur"],
            due_at="2026-02-15T18:00:00",
        )
        assert todo["priority"] == "critical"
        assert todo["assigned_to"] == "helios"
        assert todo["due_at"] == "2026-02-15T18:00:00"
        assert "deploy" in todo["tags"]

    def test_mark_done(self, brain):
        todo = brain.todo_add("Test task")
        ok = brain.todo_done(todo["id"])
        assert ok

        items = brain.todo_list(include_done=True)
        assert len(items) == 1
        assert items[0]["status"] == "done"
        assert items[0]["completed_at"] is not None

    def test_mark_done_with_result(self, brain):
        todo = brain.todo_add("Fix bug", description="Original desc")
        brain.todo_done(todo["id"], result="Fixed in commit abc123")

        items = brain.todo_list(include_done=True)
        assert "Result:" in items[0]["description"]
        assert "abc123" in items[0]["description"]

    def test_done_excluded_by_default(self, brain):
        t1 = brain.todo_add("Open task")
        t2 = brain.todo_add("Done task")
        brain.todo_done(t2["id"])

        items = brain.todo_list()
        assert len(items) == 1
        assert items[0]["title"] == "Open task"

    def test_delete(self, brain):
        todo = brain.todo_add("Delete me")
        ok = brain.todo_delete(todo["id"])
        assert ok
        assert len(brain.todo_list()) == 0

    def test_delete_nonexistent(self, brain):
        ok = brain.todo_delete("todo_nonexistent")
        assert not ok

    def test_update(self, brain):
        todo = brain.todo_add("Original", priority="low")
        ok = brain.todo_update(todo["id"], title="Updated", priority="high")
        assert ok

        items = brain.todo_list()
        assert items[0]["title"] == "Updated"
        assert items[0]["priority"] == "high"

    def test_update_status(self, brain):
        todo = brain.todo_add("Task")
        brain.todo_update(todo["id"], status="in_progress")
        items = brain.todo_list()
        assert items[0]["status"] == "in_progress"

    def test_update_to_done_sets_completed_at(self, brain):
        todo = brain.todo_add("Task")
        brain.todo_update(todo["id"], status="done")
        items = brain.todo_list(include_done=True)
        assert items[0]["completed_at"] is not None


class TestTodoFiltering:
    def test_filter_by_status(self, brain):
        brain.todo_add("Open", priority="medium")
        t2 = brain.todo_add("Blocked", priority="medium")
        brain.todo_update(t2["id"], status="blocked")

        items = brain.todo_list(status="blocked")
        assert len(items) == 1
        assert items[0]["title"] == "Blocked"

    def test_filter_by_assigned(self, brain):
        brain.todo_add("For helios", assigned_to="helios")
        brain.todo_add("For nova", assigned_to="nova")

        items = brain.todo_list(assigned_to="helios")
        assert len(items) == 1
        assert items[0]["assigned_to"] == "helios"

    def test_filter_by_tag(self, brain):
        brain.todo_add("Bug", tags=["bug", "augur"])
        brain.todo_add("Feature", tags=["feature"])

        items = brain.todo_list(tag="bug")
        assert len(items) == 1
        assert items[0]["title"] == "Bug"

    def test_priority_sort_order(self, brain):
        brain.todo_add("Low", priority="low")
        brain.todo_add("Critical", priority="critical")
        brain.todo_add("High", priority="high")
        brain.todo_add("Medium", priority="medium")

        items = brain.todo_list()
        priorities = [i["priority"] for i in items]
        assert priorities == ["critical", "high", "medium", "low"]


class TestTodoTemplates:
    def test_default_templates_seeded(self, brain):
        templates = brain.todo_templates()
        names = [t["name"] for t in templates]
        assert "bug-fix" in names
        assert "feature" in names
        assert "research" in names
        assert "deploy" in names
        assert "spike" in names

    def test_templates_have_examples(self, brain):
        templates = brain.todo_templates()
        for t in templates:
            assert t["example"], f"Template '{t['name']}' missing example"

    def test_from_template_bug_fix(self, brain):
        todo = brain.todo_from_template("bug-fix", {
            "summary": "Exit timing",
            "problem": "Positions held too long",
            "steps": "1. Open position",
            "expected": "Close at lookahead",
        })
        assert todo["title"] == "Fix: Exit timing"
        assert todo["priority"] == "high"
        assert "bug" in todo["tags"]
        assert "Positions held too long" in todo["description"]

    def test_from_template_feature(self, brain):
        todo = brain.todo_from_template("feature", {
            "summary": "Maker orders",
            "goal": "Avoid taker fees",
            "criteria": "All entries use limits",
            "notes": "Save 0.20% RT",
        })
        assert todo["title"] == "Feature: Maker orders"
        assert "feature" in todo["tags"]

    def test_from_template_with_overrides(self, brain):
        todo = brain.todo_from_template("research", {
            "topic": "GHST clustering",
            "question": "Do signals cluster?",
            "hypothesis": "Yes, around vol spikes",
            "method": "Plot timestamps",
        }, priority="critical", assigned_to="nova")
        assert todo["priority"] == "critical"
        assert todo["assigned_to"] == "nova"

    def test_from_template_missing_fields_graceful(self, brain):
        """Missing template fields should show {field} placeholder, not crash."""
        todo = brain.todo_from_template("bug-fix", {"summary": "Test"})
        assert todo["title"] == "Fix: Test"
        assert "{problem}" in todo["description"]

    def test_from_template_nonexistent_raises(self, brain):
        with pytest.raises(ValueError, match="not found"):
            brain.todo_from_template("nonexistent", {})

    def test_add_custom_template(self, brain):
        tmpl = brain.todo_add_template(
            name="review",
            title_pattern="Review: {what}",
            description_pattern="**Reviewer:** {reviewer}\n**Deadline:** {deadline}",
            default_priority="medium",
            default_tags=["review"],
            example='brain todo from-template review what="PR #42" reviewer="helios" deadline="tomorrow"',
        )
        assert tmpl["name"] == "review"

        todo = brain.todo_from_template("review", {
            "what": "PR #42",
            "reviewer": "helios",
            "deadline": "tomorrow",
        })
        assert todo["title"] == "Review: PR #42"
        assert "helios" in todo["description"]


class TestTodoStats:
    def test_stats_counts(self, brain):
        brain.todo_add("A")
        t2 = brain.todo_add("B")
        brain.todo_done(t2["id"])
        t3 = brain.todo_add("C")
        brain.todo_update(t3["id"], status="blocked")

        s = brain.todo_stats()
        assert s["total"] == 3
        assert s["by_status"]["open"] == 1
        assert s["by_status"]["done"] == 1
        assert s["by_status"]["blocked"] == 1
        assert s["templates"] >= 5

    def test_overdue_count(self, brain):
        brain.todo_add("Past due", due_at="2020-01-01T00:00:00")
        brain.todo_add("Future", due_at="2030-01-01T00:00:00")
        brain.todo_add("No due")

        s = brain.todo_stats()
        assert s["overdue"] == 1
