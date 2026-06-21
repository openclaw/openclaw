#!/usr/bin/env python3
"""
Regression tests for skill initialization.
"""

import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import TestCase, main

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import init_skill


class TestInitSkill(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_init_skill_"))

    def tearDown(self):
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def test_generated_description_placeholder_is_yaml_string(self):
        with redirect_stdout(StringIO()):
            skill_dir = init_skill.init_skill("yaml-description-skill", self.temp_dir, [], False)

        self.assertIsNotNone(skill_dir)
        content = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        frontmatter = content.split("---", 2)[1]

        self.assertIn("description: '[TODO:", frontmatter)

        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML is not installed")

        parsed = yaml.safe_load(frontmatter)

        self.assertIsInstance(parsed["description"], str)
        self.assertTrue(parsed["description"].startswith("[TODO: Complete"))


if __name__ == "__main__":
    main()
