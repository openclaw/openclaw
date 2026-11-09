import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class WaitForTextTests(unittest.TestCase):
    def test_deadline_and_immediate_probe(self):
        script = Path(__file__).with_name("wait-for-text.sh")
        # Fix external clock, sleep and pane I/O; execute the unmodified shell entry point.
        fixture = """#!/usr/bin/env bash
case "${0##*/}" in
  date) awk '{print int($0)}' "$CLOCK" ;;
  sleep)
    printf '%s\\n' "$1" >> "$SLEEPS"
    awk -v delay="$1" -v extra="$WAKE_DELAY" '{print $0 + delay + extra}' "$CLOCK" > "$CLOCK.next"
    mv "$CLOCK.next" "$CLOCK"
    ;;
  tmux) awk -v ready="$READY_AT" '$0 >= ready {print "READY"}' "$CLOCK" ;;
esac
"""
        cases = [
            ("1", "3", "2", "0", 1, ["1"]),
            ("1", "2.5", "99", "0", 1, ["1"]),
            ("1", ".25", "2", "2", 1, [".25"]),
            ("1", ".25", "99", "0", 1, [".25"] * 4),
            ("3", ".25", ".5", "0", 0, [".25"] * 2),
            ("0", "3", "0", "0", 0, []),
            ("0", ".5", "99", "0", 1, []),
        ]
        for timeout, interval, ready, wake_delay, expected_exit, expected_sleeps in cases:
            with self.subTest(timeout=timeout, interval=interval, ready=ready):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    for name in ("date", "sleep", "tmux"):
                        command = root / name
                        command.write_text(fixture)
                        command.chmod(0o755)
                    clock, sleeps = root / "clock", root / "sleeps"
                    clock.write_text("0\n")
                    sleeps.touch()
                    result = subprocess.run(
                        [
                            "bash",
                            str(script),
                            "-t",
                            "test",
                            "-F",
                            "-p",
                            "READY",
                            "-T",
                            timeout,
                            "-i",
                            interval,
                        ],
                        env={
                            **os.environ,
                            "PATH": directory + os.pathsep + os.environ["PATH"],
                            "CLOCK": str(clock),
                            "SLEEPS": str(sleeps),
                            "READY_AT": ready,
                            "WAKE_DELAY": wake_delay,
                        },
                        text=True,
                        capture_output=True,
                        timeout=10,
                    )
                    self.assertEqual(result.returncode, expected_exit, result.stderr)
                    self.assertEqual(sleeps.read_text().splitlines(), expected_sleeps)
                    if expected_exit:
                        self.assertIn("Timed out after", result.stderr)


if __name__ == "__main__":
    unittest.main()
