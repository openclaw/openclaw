#!/usr/bin/env python3
"""Tests for init_skill.py behavior."""

import tempfile
from pathlib import Path
from unittest import TestCase, main

import init_skill


class TestInitSkill(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_init_skill_"))

    def tearDown(self):
        import shutil

        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def test_init_skill_uses_custom_description_when_provided(self):
        result = init_skill.init_skill(
            skill_name="my-skill",
            path=str(self.temp_dir),
            resources=[],
            include_examples=False,
            description="Helper for validating project changelogs.",
        )

        self.assertIsNotNone(result)
        content = (self.temp_dir / "my-skill" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("description: Helper for validating project changelogs.", content)

    def test_init_skill_keeps_default_description_todo_when_empty_description(self):
        result = init_skill.init_skill(
            skill_name="my-skill-todo",
            path=str(self.temp_dir),
            resources=[],
            include_examples=False,
            description="   ",
        )

        self.assertIsNotNone(result)
        content = (self.temp_dir / "my-skill-todo" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("description: [TODO: Complete and informative explanation", content)


if __name__ == "__main__":
    main()
