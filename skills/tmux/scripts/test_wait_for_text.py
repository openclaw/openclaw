"""Regression tests for the bundled tmux text-wait helper."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is required")
def test_wait_reports_failed_pane_capture(tmp_path):
    env = {**os.environ, "LC_ALL": "C", "SHELL": "/bin/sh", "TMUX_TMPDIR": str(tmp_path)}
    env.pop("TMUX", None)
    script = Path(__file__).with_name("wait-for-text.sh")
    subprocess.run(
        ["tmux", "-f", "/dev/null", "new-session", "-d", "-s", "probe", "sleep 60"],
        env=env,
        check=True,
        timeout=10,
    )
    try:
        result = subprocess.run(
            ["bash", str(script), "-t", "probe:0.9", "-F", "-p", "ready", "-T", "0"],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 1
        assert "probe:0.9" in result.stderr
        assert "can't find pane: 9" in result.stderr
    finally:
        subprocess.run(["tmux", "kill-server"], env=env, check=True, timeout=10)
