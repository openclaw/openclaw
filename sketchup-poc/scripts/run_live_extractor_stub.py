#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from pathlib import Path

from inspect_live_model_header import build_inspect_summary, format_inspect_text

REPO_ROOT = Path(__file__).resolve().parent.parent
LIVE_EXTRACTOR = REPO_ROOT / "windows" / "extractor" / "sketchup-live-extractor.ps1"


def to_powershell_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        converted = subprocess.run(["wslpath", "-w", str(resolved)], capture_output=True, text=True, check=True)
        candidate = converted.stdout.strip()
        if candidate:
            return candidate
    except Exception:
        pass
    return str(resolved)


def from_powershell_path(path: str) -> Path:
    candidate = path.strip()
    if not candidate:
        return Path(candidate)
    try:
        converted = subprocess.run(["wslpath", "-u", candidate], capture_output=True, text=True, check=True)
        unix_path = converted.stdout.strip()
        if unix_path:
            return Path(unix_path)
    except Exception:
        pass
    return Path(candidate)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the live extractor handoff stub against a request JSON."
    )
    parser.add_argument(
        "--request",
        default="samples/live-extractor/live-extractor-request.from-bridge-handoff.json",
        help="Path to a live extractor request JSON, relative to sketchup-poc/ by default.",
    )
    parser.add_argument(
        "--pwsh",
        default="pwsh",
        help="PowerShell executable to use.",
    )
    parser.add_argument(
        "--print-live-model-header",
        action="store_true",
        help="Deprecated alias. Print a compact header inspect summary after a successful run.",
    )
    parser.add_argument(
        "--inspect-live-model-header",
        action="store_true",
        help="After a successful run, print a compact header inspect summary from the response artifact.",
    )
    parser.add_argument(
        "--inspect-format",
        choices=["text", "json"],
        default="text",
        help="Output format for --inspect-live-model-header.",
    )
    args = parser.parse_args()

    request_path = Path(args.request)
    if not request_path.is_absolute():
        request_path = (REPO_ROOT / request_path).resolve()

    with request_path.open("r", encoding="utf-8") as handle:
        request_payload = json.load(handle)

    cmd = [
        args.pwsh,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        to_powershell_path(LIVE_EXTRACTOR),
        "-RequestPath",
        to_powershell_path(request_path),
    ]

    completed = subprocess.run(cmd, capture_output=True, text=True)
    if completed.stdout:
        print(completed.stdout, end="")
    if completed.stderr:
        print(completed.stderr, end="", file=sys.stderr)
    if completed.returncode == 0 and (args.print_live_model_header or args.inspect_live_model_header):
        response_path = request_payload.get("artifacts", {}).get("responseArtifactPath")
        if response_path:
            response_payload = json.loads(from_powershell_path(response_path).read_text(encoding="utf-8"))
            summary = build_inspect_summary(response_payload)
            if args.inspect_format == "json":
                print(json.dumps(summary, indent=2))
            else:
                if summary.get("headerAvailable") or summary.get("metadataAvailable"):
                    print(format_inspect_text(summary))
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
