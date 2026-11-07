import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class TranscribeTests(unittest.TestCase):
    def test_download_must_succeed_before_replacing_output(self):
        script = Path(__file__).with_name("transcribe.sh")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "audio.wav"
            audio.write_bytes(b"audio fixture")
            output = root / "transcript.txt"
            temporary = root / "temporary"
            temporary.mkdir()
            curl = root / "curl"
            curl.write_text(
                '#!/bin/sh\n[ "$CURL_EXIT" = 22 ] || printf "new response"\nexit "$CURL_EXIT"\n'
            )
            curl.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                "OPENAI_API_KEY": "test-key",
                "TMPDIR": str(temporary),
            }
            for flags in (["--model", "whisper-1"], ["--json"]):
                for status in (22, 18, 0):
                    with self.subTest(flags=flags, status=status):
                        output.write_text("previous transcript")
                        result = subprocess.run(
                            ["bash", str(script), str(audio), "--out", str(output), *flags],
                            env={**env, "CURL_EXIT": str(status)},
                            capture_output=True,
                            text=True,
                            timeout=5,
                        )
                        self.assertEqual(result.returncode, status, result.stderr)
                        self.assertEqual(
                            output.read_text(), "previous transcript" if status else "new response"
                        )
                        self.assertEqual(list(temporary.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
