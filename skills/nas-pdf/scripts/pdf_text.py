#!/usr/bin/env python3
from pathlib import Path
import sys

VENDOR_DIR = Path(__file__).resolve().parents[1] / "vendor"
if str(VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(VENDOR_DIR))

from pypdf import PdfReader


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pdf_text.py /absolute/path/to/file.pdf", file=sys.stderr)
        return 2

    path = sys.argv[1]
    reader = PdfReader(path)
    chunks = []
    for page in reader.pages:
        text = page.extract_text() or ""
        text = text.strip()
        if text:
            chunks.append(text)
    print("\n\n".join(chunks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
