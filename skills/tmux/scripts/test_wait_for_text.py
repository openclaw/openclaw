import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class WaitForTextTests(unittest.TestCase):
    def test_empty_match_requires_successful_capture(self):
        script = Path(__file__).with_name("wait-for-text.sh")
        with tempfile.TemporaryDirectory() as directory:
            tmux = Path(directory) / "tmux"
            tmux.write_text('#!/bin/sh\nexit "$CAPTURE_STATUS"\n')
            tmux.chmod(0o755)
            for capture_status in (0, 1):
                with self.subTest(capture_status=capture_status):
                    result = subprocess.run(
                        ["bash", str(script), "-t", "proof:0.0", "-p", "^$", "-T", "0"],
                        env={
                            **os.environ,
                            "PATH": directory + os.pathsep + os.environ["PATH"],
                            "CAPTURE_STATUS": str(capture_status),
                        },
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    self.assertEqual(result.returncode, capture_status, result.stderr)
                    if capture_status:
                        self.assertIn("Timed out after 0s", result.stderr)
                    else:
                        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
