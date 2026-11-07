import os
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase, main


class TestFindSessions(TestCase):
    def test_query_matches_literal_session_names_only(self):
        script = Path(__file__).with_name("find-sessions.sh")
        rows = (
            "build[1]\t0\t2026-11-07\nbuild1\t0\t2026-11-07\n"
            "back\\slash\t0\t2026-11-07\nÄpfel\t0\t2026-11-07\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            tmux = Path(directory) / "tmux"
            tmux.write_text("#!/bin/sh\ncat <<'SESSIONS'\n" + rows + "SESSIONS\n")
            tmux.chmod(0o755)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
            cases = [
                ("BUILD[1]", ["build[1]"]),
                ("[", ["build[1]"]),
                (r"back\slash", [r"back\slash"]),
                ("äPFEL", ["Äpfel"]),
                ("2026", []),
                ("0", []),
                ("uil", ["build[1]", "build1"]),
                ("", ["build[1]", "build1", r"back\slash", "Äpfel"]),
            ]
            for query, expected in cases:
                with self.subTest(query=query):
                    result = subprocess.run(
                        ["bash", str(script), "-q", query],
                        env=env,
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, "")
                    names = [
                        line[4:].split(" (", 1)[0]
                        for line in result.stdout.splitlines()
                        if line.startswith("  - ")
                    ]
                    self.assertEqual(names, expected)
                    if not expected:
                        self.assertIn("No sessions found on default socket", result.stdout)


if __name__ == "__main__":
    main()
