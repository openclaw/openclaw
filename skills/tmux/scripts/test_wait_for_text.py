import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class WaitForTextTests(unittest.TestCase):
    def test_zero_padded_timeout_waits_for_next_capture(self):
        script = Path(__file__).with_name("wait-for-text.sh")
        for timeout, now in [("08", 107), ("09", 107), ("010", 109)]:
            with self.subTest(timeout=timeout), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                # Advance the clock before the second capture, without real sleeps.
                fixtures = {
                    "date": f"if [ -f started ]; then echo {now}; else touch started; echo 100; fi",
                    "tmux": "if [ -f captured ]; then echo READY; else touch captured; fi",
                    "sleep": "exit 0",
                }
                for name, body in fixtures.items():
                    executable = root / name
                    executable.write_text(f"#!/bin/sh\n{body}\n")
                    executable.chmod(0o755)
                result = subprocess.run(
                    ["bash", str(script.resolve()), "-t", "test:0.0", "-p", "READY", "-T", timeout],
                    cwd=root,
                    env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}"},
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
