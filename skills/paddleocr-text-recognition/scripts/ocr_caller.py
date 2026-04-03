"""
PaddleOCR Text Recognition Caller

Simple CLI wrapper for the PaddleOCR text recognition library.

Usage:
    uv run scripts/ocr_caller.py --file-url "URL"
    uv run scripts/ocr_caller.py --file-path "image.png" --pretty
"""

# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "httpx>=0.24.0",
# ]
# ///

import argparse
import io
import json
import sys
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# Add scripts dir to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from lib import ocr


def get_default_output_path() -> Path:
    """Build a unique result path under the OS temp directory."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    short_id = uuid.uuid4().hex[:8]
    return (
        Path(tempfile.gettempdir())
        / "paddleocr"
        / "text-recognition"
        / "results"
        / f"result_{timestamp}_{short_id}.json"
    )


def resolve_output_path(output_arg: Optional[str]) -> Path:
    if output_arg:
        return Path(output_arg).expanduser().resolve()
    return get_default_output_path().resolve()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="PaddleOCR Text Recognition - OCR images/PDFs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # OCR from URL (result is auto-saved to the system temp directory)
  uv run scripts/ocr_caller.py --file-url "https://example.com/image.png"

  # OCR local file (result is auto-saved to the system temp directory)
  uv run scripts/ocr_caller.py --file-path "./document.pdf" --pretty

  # OCR with explicit file type override
  uv run scripts/ocr_caller.py --file-url "URL" --file-type 1 --pretty

  # Save result to a custom file path
  uv run scripts/ocr_caller.py --file-url "URL" --output "./result.json" --pretty

  # Print JSON to stdout without saving a file
  uv run scripts/ocr_caller.py --file-url "URL" --stdout --pretty

Exit codes:
  0   Success (ok=true in JSON output)
  1   OCR or API error (ok=false in JSON output; see error.code and error.message)
  5   Cannot write result to output file

Configuration:
  Set environment variables: PADDLEOCR_OCR_API_URL, PADDLEOCR_ACCESS_TOKEN
  Optional: PADDLEOCR_OCR_TIMEOUT
        """,
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--file-url", help="URL to image or PDF")
    input_group.add_argument("--file-path", help="Local path to image or PDF")

    # Output options
    parser.add_argument(
        "--file-type",
        type=int,
        choices=[0, 1],
        help="Optional file type override (0=PDF, 1=Image)",
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Pretty-print JSON output"
    )
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument(
        "--output",
        "-o",
        metavar="FILE",
        help="Save result to JSON file (default: auto-save to system temp directory)",
    )
    output_group.add_argument(
        "--stdout",
        action="store_true",
        help="Print JSON to stdout instead of saving to a file",
    )

    args = parser.parse_args()

    # Unwarping and orientation classification are off to cover common scenarios
    # with faster response times.
    result = ocr(
        file_path=args.file_path,
        file_url=args.file_url,
        file_type=args.file_type,
        useDocUnwarping=False,
        useDocOrientationClassify=False,
    )

    indent = 2 if args.pretty else None
    json_output = json.dumps(result, indent=indent, ensure_ascii=False)

    if args.stdout:
        print(json_output)
    else:
        output_path = resolve_output_path(args.output)

        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json_output, encoding="utf-8")
            print(f"Result saved to: {output_path}", file=sys.stderr)
        except (PermissionError, OSError) as e:
            print(f"Error: Cannot write to {output_path}: {e}", file=sys.stderr)
            sys.exit(5)

    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
