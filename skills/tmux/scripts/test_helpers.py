"""Regression coverage for the tmux helpers' argument errors."""

import subprocess
from pathlib import Path
from unittest import TestCase, main


class TestTmuxArgumentErrors(TestCase):
    def test_missing_option_values_name_the_option(self):
        scripts = {
            "find-sessions.sh": "-L --socket -S --socket-path -q --query".split(),
            "wait-for-text.sh": "-t --target -p --pattern -T --timeout -i --interval -l --lines".split(),
        }
        for script, options in scripts.items():
            for option in options:
                with self.subTest(script=script, option=option):
                    result = subprocess.run(
                        ["bash", str(Path(__file__).with_name(script)), option],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertIn(option, result.stderr)


if __name__ == "__main__":
    main()
