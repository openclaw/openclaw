import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class FindSessionsTests(unittest.TestCase):
    def test_attached_label_accepts_multiple_clients(self):
        script = Path(__file__).with_name("find-sessions.sh")
        with tempfile.TemporaryDirectory() as directory:
            tmux = Path(directory) / "tmux"
            tmux.write_text(
                "#!/bin/sh\n"
                "printf 'idle\\t0\\tcreated\\nsolo\\t1\\tcreated\\nshared\\t2\\tcreated\\n'\n"
            )
            tmux.chmod(0o755)
            result = subprocess.run(
                ["bash", str(script)],
                env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                capture_output=True,
                text=True,
                timeout=5,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertIn("  - idle (detached,", result.stdout)
        self.assertIn("  - solo (attached,", result.stdout)
        self.assertIn("  - shared (attached,", result.stdout)


if __name__ == "__main__":
    unittest.main()
