"""Tests for the binary self-update kill + warm-up (#1222 S4).

Two surfaces:

  1. ``Dockerfile.multitenant`` bakes ``DISABLE_AUTOUPDATER=1`` and
     ``CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`` so claude/codex never
     self-update per machine — version is owned centrally via the image.
  2. ``warm_subscription_binary()`` in ``overlay/multitenant/entrypoint.sh``
     warms the chosen binary at machine start so the first user-facing
     call isn't a cold start. It must:
       - run in the background (never block broker startup),
       - export the autoupdater-off env so the warm ``--version`` cannot
         itself trigger a self-update,
       - be best-effort (a failing/missing binary never fails the
         container),
       - pick ``$BINARY`` (claude|codex), defaulting to claude.

Like the sibling render-settings test, we do NOT build the image — we
extract the function body and run it in a bash subprocess against a fake
binary on PATH.

Run from the repo root with:

    uv run --with pytest pytest \
      overlay/multitenant/tests/test_entrypoint_warm_binary.py -v
"""

from __future__ import annotations

import re
import shutil
import subprocess
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
OVERLAY = REPO_ROOT / "overlay" / "multitenant"
ENTRYPOINT = OVERLAY / "entrypoint.sh"
DOCKERFILE = REPO_ROOT / "Dockerfile.multitenant"


def _bash_supporting_wait_n() -> str:
    """Return a bash interpreter that supports the ``wait -n`` builtin.

    The production image runs a modern bash (>= 4.3); macOS ships the
    ancient 3.2 as ``/bin/bash`` which lacks ``wait -n``. The entrypoint's
    subscription arm uses ``wait -n``, so executing that arm requires a
    capable interpreter. Probe common locations and return an ABSOLUTE
    path, so callers that pass a restricted ``PATH`` env still hit the
    capable interpreter rather than re-resolving to ``/bin/bash`` 3.2.
    """
    candidates = [
        shutil.which("bash"),
        "/opt/homebrew/bin/bash",
        "/usr/local/bin/bash",
        "/bin/bash",
    ]
    for cand in candidates:
        if not cand:
            continue
        try:
            # Background a trivial job and `wait -n` for it. A capable bash
            # (>= 4.3) succeeds silently; bash 3.2 writes
            # "wait: -n: invalid option" to stderr.
            probe = subprocess.run(
                [cand, "-c", "( : ) & wait -n"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if "invalid option" not in probe.stderr:
            return cand
    return "bash"


BASH = _bash_supporting_wait_n()


def _extract_function(name: str) -> str:
    src = ENTRYPOINT.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^{re.escape(name)}\(\)\s*\{{\n(?P<body>.*?)^\}}\n",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(src)
    assert m is not None, f"{name}() not found in entrypoint.sh"
    return m.group("body")


def _run_warm(
    tmp_path: Path,
    *,
    binary: str,
    make_claude: bool = True,
    make_codex: bool = False,
    claude_exits_nonzero: bool = False,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    """Run warm_subscription_binary() with a fake binary on PATH. The fake
    writes the env it observed to ``env_seen`` so we can assert the
    autoupdater-off vars were passed through."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    env_seen = tmp_path / "env_seen.txt"

    def _write_fake(name: str, nonzero: bool) -> None:
        exit_line = "exit 7" if nonzero else 'echo "fake $0 2.1.0"; exit 0'
        (bindir / name).write_text(
            "#!/usr/bin/env bash\n"
            'if [ "$1" = "--version" ]; then\n'
            f'  printf "AUTOUPDATER=%s NONESSENTIAL=%s\\n" '
            f'"$DISABLE_AUTOUPDATER" '
            f'"$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" > "{env_seen}"\n'
            f"  {exit_line}\n"
            "fi\n"
            "exit 1\n",
            encoding="utf-8",
        )
        (bindir / name).chmod(0o755)

    if make_claude:
        _write_fake("claude", claude_exits_nonzero)
    if make_codex:
        _write_fake("codex", False)

    body = _extract_function("warm_subscription_binary")
    harness = (
        'log() { printf "[entrypoint] %s\\n" "$*" >&2; }\n'
        # Re-wrap the extracted body into the named function, then call it.
        f"warm_subscription_binary() {{\n{body}\n}}\n"
        "warm_subscription_binary\n"
        # Wait for the backgrounded warm subshell so the test is
        # deterministic. In production the broker waits, not this script.
        "wait\n"
    )
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin",
        "BINARY": binary,
    }
    proc = subprocess.run(
        ["bash", "-c", harness],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return proc, env_seen


def _run_warm_nonblocking(
    tmp_path: Path,
    *,
    binary: str = "claude",
    warm_sleep_seconds: int = 10,
    boot_deadline_seconds: float = 6.0,
) -> tuple[float, Path, Path, Path]:
    """Run warm_subscription_binary() against a fake binary whose
    ``--version`` is *slow* (``sleep <warm_sleep_seconds>``), and measure
    how long the entrypoint's boot path takes to get *past* the warm call.

    This harness mimics the real entrypoint: it calls warm and then
    proceeds (it does NOT ``wait`` for backgrounded children). Two
    subtleties make the timing honest:

      * The fake binary records a ``warm_started`` marker, sleeps, then a
        ``warm_finished`` marker — so we can prove warm actually fired and
        is still running when boot continues.
      * The boot path writes a ``boot_continued`` marker the instant warm
        returns. We poll that file rather than waiting on
        ``subprocess.run`` to return, because a backgrounded subshell
        inherits the bash pipes and would keep them open until its
        ``sleep`` ends — that is a pipe-drain artifact, not boot blocking.
        Polling the marker measures the real boot-path latency.

    The bash process's own stdout/stderr are redirected to log files
    (not OS pipes) so the launcher never blocks on FD inheritance.

    Returns ``(elapsed_to_boot_continue, started_marker, finished_marker,
    log_file)``.
    """
    bindir = tmp_path / "bin"
    bindir.mkdir()
    started_marker = tmp_path / "warm_started.txt"
    finished_marker = tmp_path / "warm_finished.txt"
    boot_marker = tmp_path / "boot_continued.txt"
    log_file = tmp_path / "entrypoint.log"

    # Fake binary: on --version, record that warm actually fired, sleep to
    # simulate a slow cold start, then record completion. If warm runs in
    # the foreground, the sleep blocks the boot path; in the background it
    # does not.
    (bindir / binary).write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "--version" ]; then\n'
        f'  : > "{started_marker}"\n'
        f"  sleep {warm_sleep_seconds}\n"
        f'  : > "{finished_marker}"\n'
        '  echo "fake $0 2.1.0"\n'
        "  exit 0\n"
        "fi\n"
        "exit 1\n",
        encoding="utf-8",
    )
    (bindir / binary).chmod(0o755)

    body = _extract_function("warm_subscription_binary")
    # No trailing `wait`: this is the boot path. Call warm, then drop the
    # boot-continued marker the instant control returns. Redirect all bash
    # output to a log file so the launching process never inherits a pipe
    # held open by the backgrounded warm subshell.
    harness = (
        'log() { printf "[entrypoint] %s\\n" "$*" >&2; }\n'
        f"warm_subscription_binary() {{\n{body}\n}}\n"
        "warm_subscription_binary\n"
        f': > "{boot_marker}"\n'
        # Keep the foreground process alive briefly so the test can observe
        # that warm is still running in the background (boot did not wait).
        f"sleep {warm_sleep_seconds + 5}\n"
    )
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin",
        "BINARY": binary,
    }
    start = time.monotonic()
    log_fh = log_file.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        [BASH, "-c", harness],
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        env=env,
    )
    try:
        # Poll for the boot-continued marker. With `&` present this appears
        # near-instantly; without it, only after the warm sleep/timeout.
        deadline = start + boot_deadline_seconds
        while not boot_marker.exists() and time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            time.sleep(0.02)
        elapsed = (
            time.monotonic() - start
            if boot_marker.exists()
            else boot_deadline_seconds
        )
        # Let the backgrounded warm subshell actually exec the fake binary
        # so ``warm_started`` lands. This proves warm is running CONCURRENTLY
        # with the (already-continued) boot path — the falsifiable property.
        # Bounded well below the 10s warm sleep so it cannot mask blocking.
        started_deadline = time.monotonic() + 3.0
        while (
            not started_marker.exists()
            and time.monotonic() < started_deadline
            and proc.poll() is None
        ):
            time.sleep(0.02)
    finally:
        proc.kill()
        proc.wait(timeout=10)
        log_fh.close()
    return elapsed, started_marker, finished_marker, log_file


def test_warm_returns_immediately_and_does_not_block_boot(
    tmp_path: Path,
) -> None:
    """Boot-safety property: warming must run in the BACKGROUND, so the
    entrypoint continues immediately and never blocks broker/boot.

    The fake binary's ``--version`` sleeps 10s. With the ``&`` present the
    warm subshell is detached and the boot path returns in well under 2s
    while warm is still mid-sleep. This test FAILS (boot-continue latency
    jumps to ~sleep, or the in-source ``timeout 20``) if the ``&``
    background operator is removed from ``warm_subscription_binary`` —
    that is the whole point of the feature.
    """
    elapsed, started_marker, finished_marker, log_file = _run_warm_nonblocking(
        tmp_path, warm_sleep_seconds=10, boot_deadline_seconds=6.0
    )
    log = log_file.read_text(encoding="utf-8")
    # Sanity: warm actually fired (the fake --version was invoked), so the
    # fast return is genuine backgrounding, not warm being skipped.
    assert started_marker.exists(), (
        "warm never invoked the binary --version; a fast boot would be a "
        f"false pass. log:\n{log}"
    )
    assert "warming claude --version" in log, log
    # The boot path must not have blocked on the 10s warm. Background == fast.
    assert elapsed < 2.0, (
        f"entrypoint blocked {elapsed:.2f}s on the warm call; warm must run "
        "in the background (`&`) so it never blocks boot. Did the `&` get "
        f"removed from warm_subscription_binary()?\nlog:\n{log}"
    )
    # And prove the boot continued WHILE warm was still running: the slow
    # warm had not finished when boot resumed. This is what makes the test
    # falsifiable — a foreground warm could only continue after finishing.
    assert not finished_marker.exists(), (
        "warm completed before boot continued, so we cannot distinguish "
        "background from a fast foreground run; the test is not falsifiable "
        f"as written. elapsed={elapsed:.2f}s log:\n{log}"
    )


def test_warm_runs_claude_and_disables_autoupdater(tmp_path: Path) -> None:
    proc, env_seen = _run_warm(tmp_path, binary="claude")
    assert proc.returncode == 0, proc.stderr
    assert "warming claude --version" in proc.stderr
    assert "claude warmed" in proc.stderr
    # The warm call must have passed the autoupdater-off env to the binary.
    assert env_seen.read_text(encoding="utf-8").strip() == (
        "AUTOUPDATER=1 NONESSENTIAL=1"
    )


def test_warm_respects_binary_codex(tmp_path: Path) -> None:
    proc, env_seen = _run_warm(
        tmp_path, binary="codex", make_claude=False, make_codex=True
    )
    assert proc.returncode == 0, proc.stderr
    assert "warming codex --version" in proc.stderr
    assert env_seen.exists()


def test_warm_defaults_to_claude_for_unknown_binary(tmp_path: Path) -> None:
    proc, _ = _run_warm(tmp_path, binary="totally-bogus")
    assert proc.returncode == 0, proc.stderr
    assert "warming claude --version" in proc.stderr


def test_warm_is_nonfatal_when_binary_missing(tmp_path: Path) -> None:
    # No fake claude/codex on PATH at all.
    proc, _ = _run_warm(
        tmp_path, binary="claude", make_claude=False, make_codex=False
    )
    assert proc.returncode == 0, proc.stderr
    assert "skipping warm-up" in proc.stderr


def test_warm_is_nonfatal_when_binary_errors(tmp_path: Path) -> None:
    proc, _ = _run_warm(tmp_path, binary="claude", claude_exits_nonzero=True)
    # A non-zero `--version` must NOT fail the entrypoint.
    assert proc.returncode == 0, proc.stderr
    assert "warm-up exited non-zero (non-fatal)" in proc.stderr


def _extract_subscription_branch() -> str:
    """Pull the body of the ``subscription)`` case arm out of entrypoint.sh
    so it can be executed in isolation."""
    src = ENTRYPOINT.read_text(encoding="utf-8")
    pattern = re.compile(
        r"^\s*subscription\)\n(?P<body>.*?)^\s*;;\n",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(src)
    assert m is not None, "subscription) case arm not found in entrypoint.sh"
    return m.group("body")


def test_entrypoint_calls_warm_in_subscription_mode(tmp_path: Path) -> None:
    """Actually execute the subscription case arm and prove the real code
    path invokes warm_subscription_binary — not just that the string is
    present. ``warm_subscription_binary`` is stubbed to drop a marker file;
    if the branch were dead or the call commented out, the marker would be
    absent and this test would fail.
    """
    marker = tmp_path / "warm_invoked.txt"
    release = tmp_path / "broker_release.txt"
    body = _extract_subscription_branch()
    harness = (
        'log() { printf "[entrypoint] %s\\n" "$*" >&2; }\n'
        # Stub the warm step: record that the real branch called it, then
        # release the broker so the arm's trailing `wait -n "$BROKER_PID"`
        # returns. The release is the proof-of-invocation signal — if warm
        # were never called (dead branch / commented-out call), the broker is
        # never released and falls through its bounded fallback below, leaving
        # the marker ABSENT so the assertion fails cleanly (no hang).
        f'warm_subscription_binary() {{ : > "{marker}"; : > "{release}"; }}\n'
        # The broker must be a REAL, still-LIVE child when the arm reaches
        # `wait -n "$BROKER_PID"` — otherwise the prior harness raced: a
        # `( exit 0 ) &` job exits and is reaped before the wait, and on
        # Linux bash `wait -n <reaped-pid>` errors "no such job" -> 127,
        # failing the script (passed on macOS bash only by luck of timing).
        # This broker blocks until warm releases it (or a ~5s bounded
        # fallback, well under the 15s subprocess timeout), then exits 0 so
        # the harness returncode stays 0 in both the normal and mutation
        # (warm-not-called) cases.
        f'( for _ in $(seq 1 250); do [ -f "{release}" ] && break; '
        "sleep 0.02; done; exit 0 ) &\n"
        "BROKER_PID=$!\n"
        # `command -v claude/codex` in the branch must not abort under set -e
        # style strictness; the arm tolerates missing binaries already.
        "MODE=subscription\n"
        f"{body}\n"
    )
    proc = subprocess.run(
        [BASH, "-c", harness],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin"},
        timeout=15,
    )
    assert proc.returncode == 0, proc.stderr
    assert marker.exists(), (
        "subscription branch did not invoke warm_subscription_binary; the "
        f"call is missing or in a dead branch.\nstderr:\n{proc.stderr}"
    )


def test_dockerfile_disables_self_updater() -> None:
    src = DOCKERFILE.read_text(encoding="utf-8")
    assert "ENV DISABLE_AUTOUPDATER=1" in src
    assert "ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" in src
