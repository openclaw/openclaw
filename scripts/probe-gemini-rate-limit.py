#!/usr/bin/env python3
"""
Probe google-gemini-cli request stability / rate limiting by repeatedly running:

  openclaw models status --probe --probe-provider google-gemini-cli ...

This uses the same auth/profile path as OpenClaw runtime probes, so results are
useful for validating real-world fallback behavior.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time
from collections import Counter
from pathlib import Path
from typing import Any


def extract_json_block(text: str, marker: str = '{\n  "configPath"') -> str | None:
    start = text.find(marker)
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index, char in enumerate(text[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
                continue
            if char == "\\":
                escaped = True
                continue
            if char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def detect_google_profile(auth_store_path: Path) -> str:
    store = json.loads(auth_store_path.read_text(encoding="utf-8"))
    profiles = [
        key
        for key in (store.get("profiles") or {}).keys()
        if isinstance(key, str) and key.startswith("google-gemini-cli:")
    ]
    if not profiles:
        raise RuntimeError(f"No google-gemini-cli profile found in {auth_store_path}")
    return profiles[0]


def run_probe_once(args: argparse.Namespace, profile_id: str) -> dict[str, Any]:
    cmd = [
        args.binary,
        "models",
        "status",
        "--probe",
        "--probe-provider",
        "google-gemini-cli",
        "--probe-profile",
        profile_id,
        "--probe-timeout",
        str(args.probe_timeout_ms),
        "--probe-concurrency",
        "1",
        "--probe-max-tokens",
        str(args.probe_max_tokens),
        "--json",
    ]

    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    elapsed_ms = int((time.time() - started) * 1000)

    payload = extract_json_block(combined)
    if payload is None:
        return {
            "status": "parse_error",
            "latencyMs": None,
            "error": "json_block_not_found",
            "elapsedMs": elapsed_ms,
            "exitCode": proc.returncode,
        }

    try:
        data = json.loads(payload)
        probe_results = (((data.get("auth") or {}).get("probes") or {}).get("results") or [])
        row = next((entry for entry in probe_results if entry.get("profileId") == profile_id), None)
        if row is None:
            return {
                "status": "missing_result",
                "latencyMs": None,
                "error": "probe_result_not_found",
                "elapsedMs": elapsed_ms,
                "exitCode": proc.returncode,
            }
        return {
            "status": row.get("status") or "unknown",
            "latencyMs": row.get("latencyMs"),
            "error": row.get("error"),
            "elapsedMs": elapsed_ms,
            "exitCode": proc.returncode,
        }
    except Exception as exc:  # pragma: no cover - diagnostic path
        return {
            "status": "parse_error",
            "latencyMs": None,
            "error": f"json_decode_error: {exc}",
            "elapsedMs": elapsed_ms,
            "exitCode": proc.returncode,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe google-gemini-cli request limit behavior")
    parser.add_argument("--binary", default="openclaw", help="OpenClaw CLI binary path")
    parser.add_argument("--iterations", type=int, default=8, help="Number of probe attempts")
    parser.add_argument(
        "--interval-sec",
        type=float,
        default=2.0,
        help="Sleep interval between attempts (seconds)",
    )
    parser.add_argument(
        "--probe-timeout-ms",
        type=int,
        default=10_000,
        help="Per-attempt model probe timeout in ms",
    )
    parser.add_argument(
        "--probe-max-tokens",
        type=int,
        default=8,
        help="Probe generation max tokens",
    )
    parser.add_argument(
        "--profile-id",
        default="",
        help="google-gemini-cli profile id (auto-detects first if omitted)",
    )
    parser.add_argument(
        "--auth-store",
        default=str(Path.home() / ".openclaw" / "agents" / "main" / "agent" / "auth-profiles.json"),
        help="Auth profile store path (used for profile auto-detection)",
    )

    args = parser.parse_args()
    if args.iterations <= 0:
        raise SystemExit("--iterations must be > 0")
    if args.probe_timeout_ms <= 0:
        raise SystemExit("--probe-timeout-ms must be > 0")
    if args.probe_max_tokens <= 0:
        raise SystemExit("--probe-max-tokens must be > 0")
    if args.interval_sec < 0:
        raise SystemExit("--interval-sec must be >= 0")

    profile_id = args.profile_id.strip()
    if not profile_id:
        profile_id = detect_google_profile(Path(args.auth_store))

    print(f"profile={profile_id}")
    print(
        f"iterations={args.iterations} intervalSec={args.interval_sec} "
        f"probeTimeoutMs={args.probe_timeout_ms} probeMaxTokens={args.probe_max_tokens}"
    )
    print()

    records: list[dict[str, Any]] = []
    for index in range(1, args.iterations + 1):
        row = run_probe_once(args, profile_id)
        records.append(row)
        now = dt.datetime.now().strftime("%H:%M:%S")
        err_short = str(row.get("error") or "").replace("\n", " ")[:160]
        print(
            f"[{now}] #{index} status={row.get('status')} "
            f"probeLatencyMs={row.get('latencyMs')} cmdDurationMs={row.get('elapsedMs')} "
            f"exit={row.get('exitCode')} err={err_short}"
        )
        if index < args.iterations and args.interval_sec > 0:
            time.sleep(args.interval_sec)

    print()
    counts = Counter(str(r.get("status")) for r in records)
    print("summary_status_counts=", dict(counts))

    first_rate = next((idx for idx, r in enumerate(records, start=1) if r.get("status") == "rate_limit"), None)
    first_recovery = None
    if first_rate is not None:
        for idx, row in enumerate(records[first_rate:], start=first_rate + 1):
            if row.get("status") == "ok":
                first_recovery = idx
                break

    print(
        "rate_limit_observation=",
        {
            "firstRateLimitAttempt": first_rate,
            "firstOkAfterRateLimitAttempt": first_recovery,
        },
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
