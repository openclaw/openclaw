#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from inspect_live_model_header import (
    build_bridge_consumer_summary,
    build_inspect_summary,
    format_bridge_consumer_text,
    format_inspect_text,
    validate_inspect_summary,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
RUN_BRIDGE_REQUEST = REPO_ROOT.parent / "windows-bridge-bootstrap" / "scripts" / "run-bridge-request.py"


def load_payload(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dump_temp_payload(payload: dict) -> str:
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False)
    with handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    return handle.name


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the SketchUp PoC through the existing Windows bridge request/response flow.")
    parser.add_argument("action", choices=["sketchup-ping", "get-minimal-live-metadata", "extract-model-snapshot"])
    parser.add_argument("--payload-file", help="Optional payload JSON. If omitted, the sample payload for the selected action is used.")
    parser.add_argument("--fallback-mode", choices=["mock-sample", "live-only"])
    parser.add_argument("--probe-mode", choices=["probe-first", "skip-probe"])
    parser.add_argument("--live-extractor-mode", choices=["handoff-plan", "execute-bootstrap-ack"])
    parser.add_argument("--snapshot-output-path")
    parser.add_argument("--response-artifact-path")
    parser.add_argument("--inspect-live-model-header", action="store_true")
    parser.add_argument(
        "--inspect-bridge-consumer",
        action="store_true",
        help="Validate and print the contract-aware bridge consumer surface derived from diagnosticSummary + safeQueryProof.",
    )
    parser.add_argument("--inspect-format", choices=["text", "json"], default="text")
    parser.add_argument("--timeout-seconds", type=int, default=120)
    args = parser.parse_args()

    sample_payload = REPO_ROOT / "samples" / "bridge-payloads" / f"{args.action}.json"
    payload = load_payload(Path(args.payload_file).resolve()) if args.payload_file else load_payload(sample_payload)

    if args.fallback_mode:
        payload["fallbackMode"] = args.fallback_mode
    if args.probe_mode:
        payload["probeMode"] = args.probe_mode
    if args.live_extractor_mode:
        payload["liveExtractorMode"] = args.live_extractor_mode
    if args.snapshot_output_path:
        payload["snapshotOutputPath"] = args.snapshot_output_path
    if args.response_artifact_path:
        payload["responseArtifactPath"] = args.response_artifact_path

    payload_file = dump_temp_payload(payload)
    cmd = [
        sys.executable,
        str(RUN_BRIDGE_REQUEST),
        "sketchup-poc-action",
        "--payload-file",
        payload_file,
        "--timeout-seconds",
        str(args.timeout_seconds),
    ]

    completed = subprocess.run(cmd, capture_output=True, text=True)
    if completed.stdout:
        print(completed.stdout, end="")
    if completed.stderr:
        print(completed.stderr, end="", file=sys.stderr)
    if completed.returncode == 0 and (args.inspect_live_model_header or args.inspect_bridge_consumer) and completed.stdout:
        try:
            payload = json.loads(completed.stdout)
            output_payload = payload.get("output") if isinstance(payload, dict) else None
            if isinstance(output_payload, dict):
                summary = build_inspect_summary(output_payload)
                if args.inspect_bridge_consumer:
                    validate_inspect_summary(summary)
                    consumer = build_bridge_consumer_summary(summary)
                    if args.inspect_format == "json":
                        print(json.dumps(consumer, indent=2))
                    else:
                        print(format_bridge_consumer_text(summary))
                elif args.inspect_format == "json":
                    print(json.dumps(summary, indent=2))
                elif summary.get("headerAvailable") or summary.get("metadataAvailable"):
                    print(format_inspect_text(summary))
        except json.JSONDecodeError:
            print("header inspect skipped: bridge stdout was not valid JSON.", file=sys.stderr)
        except Exception as exc:
            print(f"bridge consumer inspect failed: {exc}", file=sys.stderr)
            return 2
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
