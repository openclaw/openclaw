#!/usr/bin/env python3
"""Regression tests for init_skill.py tool generation."""

import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, main

SCRIPT_PATH = Path(__file__).with_name("init_skill.py")


class TestInitSkill(TestCase):
    def test_tool_args_starting_with_dashes_generate_tool_file(self):
        with tempfile.TemporaryDirectory(prefix="test_init_skill_") as tmp:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "demo-skill",
                    "--path",
                    tmp,
                    "--tool",
                    "compress",
                    "--type",
                    "python",
                    "--tool-desc",
                    "Compress files",
                    "--tool-args",
                    "--input:str:Input",
                    "--output:str:Output",
                ],
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertTrue(
                Path(tmp, "demo-skill", "scripts", "compress.py").exists(),
                result.stderr + result.stdout,
            )

    def test_unknown_args_still_fail_without_tool_args(self):
        with tempfile.TemporaryDirectory(prefix="test_init_skill_unknown_") as tmp:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "demo-skill",
                    "--path",
                    tmp,
                    "--bogus",
                ],
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unrecognized arguments: --bogus", result.stderr)


if __name__ == "__main__":
    main()
