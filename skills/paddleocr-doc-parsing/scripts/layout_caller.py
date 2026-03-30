"""
PaddleOCR Document Parser

Simple CLI wrapper for the PaddleOCR document parsing library.

Usage:
    python scripts/layout_caller.py --file-url "URL"
    python scripts/layout_caller.py --file-path "document.pdf"
    python scripts/layout_caller.py --file-path "doc.pdf" --pretty
"""

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

from lib import parse_document


def get_default_output_path() -> Path:
    """Build a unique result path under the OS temp directory."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    short_id = uuid.uuid4().hex[:8]
    return (
        Path(tempfile.gettempdir())
        / "paddleocr"
        / "doc-parsing"
        / "results"
        / f"result_{timestamp}_{short_id}.json"
    )


def resolve_output_path(output_arg: Optional[str]) -> Path:
    if output_arg:
        return Path(output_arg).expanduser().resolve()
    return get_default_output_path().resolve()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="PaddleOCR Document Parsing - with layout analysis",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Parse document from URL (result is auto-saved to the system temp directory)
  python scripts/layout_caller.py --file-url "https://example.com/document.pdf"

  # Parse local file (result is auto-saved to the system temp directory)
  python scripts/layout_caller.py --file-path "./invoice.pdf"

  # Save result to a custom file path
  python scripts/layout_caller.py --file-url "URL" --output "./result.json" --pretty

  # Print JSON to stdout without saving a file
  python scripts/layout_caller.py --file-url "URL" --stdout --pretty
Configuration:
  Set environment variables: PADDLEOCR_DOC_PARSING_API_URL, PADDLEOCR_ACCESS_TOKEN
  Optional: PADDLEOCR_DOC_PARSING_TIMEOUT
        """,
    )

    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--file-url", help="URL to document (PDF, PNG, JPG, etc.)")
    input_group.add_argument("--file-path", help="Local file path")

    # Optional input options
    parser.add_argument(
        "--file-type",
        type=int,
        choices=[0, 1],
        help="Optional file type override (0=PDF, 1=Image)",
    )

    # Output options
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
    # with faster response times; visualize is off to reduce response payload.
    result = parse_document(
        file_path=args.file_path,
        file_url=args.file_url,
        file_type=args.file_type,
        useDocUnwarping=False,
        useDocOrientationClassify=False,
        visualize=False,
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
