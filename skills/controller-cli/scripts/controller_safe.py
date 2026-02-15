#!/usr/bin/env python3
"""
controller_safe.py

Wrapper around `controller` (controller-cli) that enforces:
- JSON output
- explicit network selection for networked commands
- structured error handling

Stdlib-only so it can run in CI and constrained environments.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys


NETWORK_REQUIRED = {"call", "execute", "register", "transaction"}
DEFAULT_TIMEOUT_SECONDS = 900
TIMEOUT_ENV_VAR = "CONTROLLER_SAFE_TIMEOUT_SECONDS"


def _has_flag(args: list[str], flag: str) -> bool:
    return flag in args


def _timeout_seconds() -> int:
    raw = os.environ.get(TIMEOUT_ENV_VAR)
    if raw is None or raw == "":
        return DEFAULT_TIMEOUT_SECONDS
    try:
        return int(raw)
    except ValueError:
        print(
            f"error: {TIMEOUT_ENV_VAR} must be an integer number of seconds (got {raw!r})",
            file=sys.stderr,
        )
        raise


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: controller_safe.py <subcommand> [args...]", file=sys.stderr)
        return 2

    if shutil.which("controller") is None:
        print("error: 'controller' not found in PATH (install controller-cli first)", file=sys.stderr)
        return 127

    subcmd = argv[1]
    args = argv[2:]

    if subcmd in NETWORK_REQUIRED and not (_has_flag(args, "--chain-id") or _has_flag(args, "--rpc-url")):
        print(
            f"error: controller '{subcmd}' requires explicit network: pass --chain-id SN_MAIN|SN_SEPOLIA or --rpc-url <url>",
            file=sys.stderr,
        )
        return 2

    if not _has_flag(args, "--json"):
        args = [*args, "--json"]

    try:
        timeout_s = _timeout_seconds()
    except ValueError:
        return 2

    try:
        proc = subprocess.run(
            ["controller", subcmd, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            # Avoid hanging forever if the underlying CLI stalls.
            timeout=None if timeout_s <= 0 else timeout_s,
        )
    except subprocess.TimeoutExpired as e:
        print(
            f"error: controller '{subcmd}' timed out after {timeout_s}s "
            f"(set {TIMEOUT_ENV_VAR}=0 to disable, or increase it)",
            file=sys.stderr,
        )
        if e.stderr:
            print(str(e.stderr).rstrip("\n"), file=sys.stderr)
        if e.stdout:
            print(str(e.stdout).rstrip("\n"), file=sys.stderr)
        return 124

    if proc.stderr.strip():
        print(proc.stderr.rstrip("\n"), file=sys.stderr)

    stdout = proc.stdout.strip()
    try:
        payload = json.loads(stdout)
    except Exception:
        print(f"error: controller output is not valid JSON (exit {proc.returncode})", file=sys.stderr)
        if stdout:
            print(stdout, file=sys.stderr)
        return 1

    if payload.get("status") == "error":
        code = payload.get("error_code") or "unknown"
        msg = payload.get("message") or ""
        hint = payload.get("recovery_hint") or ""

        print(f"controller error: {code}", file=sys.stderr)
        if msg:
            print(f"message: {msg}", file=sys.stderr)
        if hint:
            print(f"recovery_hint: {hint}", file=sys.stderr)
        return 1

    # If controller returned a non-zero status but didn't include an error payload,
    # treat it as failure (don't silently succeed).
    if proc.returncode != 0:
        print(f"error: controller exited with {proc.returncode} without a JSON error payload", file=sys.stderr)
        json.dump(payload, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return proc.returncode

    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
