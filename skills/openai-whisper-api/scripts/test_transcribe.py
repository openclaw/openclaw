"""Check transcription argument errors before credentials or upload are needed."""

import os
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("bash"), "bash is required")
class TestTranscribeArguments(unittest.TestCase):
    def test_missing_values_are_reported_before_upload(self):
        script = Path(__file__).with_name("transcribe.sh")
        for option in ("--model", "--out", "--language", "--prompt"):
            for following in ([], ["--json"], ["--out", "transcript.txt"]):
                with self.subTest(option=option, following=following):
                    result = subprocess.run(
                        ["bash", str(script), "missing-audio.wav", option, *following],
                        env={**os.environ, "OPENAI_API_KEY": ""},
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn(f"{option} requires a value", result.stderr)
                    self.assertEqual(result.stdout, "")

    def test_dash_prefixed_values_reach_input_validation(self):
        script = Path(__file__).with_name("transcribe.sh")
        for option, value in (("--prompt", "--- Meeting transcript ---"), ("--out", "--notes.txt")):
            with self.subTest(option=option):
                result = subprocess.run(
                    ["bash", str(script), "missing-audio.wav", option, value],
                    env={**os.environ, "OPENAI_API_KEY": ""},
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 1)
                self.assertIn("File not found: missing-audio.wav", result.stderr)


if __name__ == "__main__":
    unittest.main()
