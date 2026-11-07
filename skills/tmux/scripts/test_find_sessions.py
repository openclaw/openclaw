import os
import socket
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path


class FindSessionsTests(unittest.TestCase):
    def test_all_includes_hidden_socket_paths(self):
        script = Path(__file__).with_name("find-sessions.sh")
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            sockets = root / "sockets"
            sockets.mkdir()
            tmux = root / "tmux"
            tmux.write_text("#!/bin/sh\nprintf '%s\\t0\\tcreated\\n' \"$2\"\n")
            tmux.chmod(0o755)
            (sockets / ".DS_Store").write_text("not a socket")
            expected = []
            for name in (None, ".hidden.sock", "visible.sock"):
                if name is not None:
                    endpoint = stack.enter_context(socket.socket(socket.AF_UNIX))
                    endpoint.bind(str(sockets / name))
                    expected.append(str(sockets / name))
                with self.subTest(sockets=expected[:]):
                    result = subprocess.run(
                        ["bash", str(script), "--all"],
                        env={
                            **os.environ,
                            "PATH": directory + os.pathsep + os.environ["PATH"],
                            "OPENCLAW_TMUX_SOCKET_DIR": str(sockets),
                        },
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    if expected:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stderr, "")
                    else:
                        self.assertEqual(result.returncode, 1)
                        self.assertIn("No sockets found under", result.stderr)
                    found = [
                        line[4:].split(" (", 1)[0]
                        for line in result.stdout.splitlines()
                        if line.startswith("  - ")
                    ]
                    self.assertCountEqual(found, expected)


if __name__ == "__main__":
    unittest.main()
