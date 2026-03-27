"""
Split a PDF by page ranges.

Usage:
    python scripts/split_pdf.py input.pdf output.pdf --pages "1-5,8,10-12"
"""

import argparse
import sys
from pathlib import Path


def parse_pages(pages_spec: str, total_pages: int) -> list[int]:
    """Parse 1-based page ranges into 0-based unique page indices."""
    if not pages_spec or not pages_spec.strip():
        raise ValueError("Page ranges are required. Example: 1-5,8,10-12")

    selected_pages = []
    seen_pages = set()

    def add_page(page_number: int):
        if page_number < 1 or page_number > total_pages:
            raise ValueError(
                f"Page {page_number} is out of range. Valid range: 1-{total_pages}"
            )
        page_index = page_number - 1
        if page_index not in seen_pages:
            seen_pages.add(page_index)
            selected_pages.append(page_index)

    for token in [part.strip() for part in pages_spec.split(",") if part.strip()]:
        if "-" in token:
            start_str, end_str = token.split("-", 1)
            if not start_str.isdigit() or not end_str.isdigit():
                raise ValueError(f"Invalid page range: {token}")
            start_page, end_page = int(start_str), int(end_str)
            if start_page > end_page:
                raise ValueError(
                    f"Invalid page range: {token} (start cannot be greater than end)"
                )
            for page_number in range(start_page, end_page + 1):
                add_page(page_number)
        else:
            if not token.isdigit():
                raise ValueError(f"Invalid page value: {token}")
            add_page(int(token))

    if not selected_pages:
        raise ValueError("No valid pages selected")

    return selected_pages


def split_pdf(input_path: Path, output_path: Path, pages_spec: str) -> tuple[int, int]:
    """Create a new PDF containing selected pages from the input PDF."""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise RuntimeError("pypdfium2 is required. Install with: pip install pypdfium2")

    source_pdf = pdfium.PdfDocument(str(input_path))
    try:
        total_pages = len(source_pdf)
        page_indices = parse_pages(pages_spec, total_pages)

        output_pdf = pdfium.PdfDocument.new()
        try:
            output_pdf.import_pages(source_pdf, page_indices)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_pdf.save(str(output_path))
        finally:
            output_pdf.close()
    finally:
        source_pdf.close()

    return total_pages, len(page_indices)


def main() -> int:
    parser = argparse.ArgumentParser(description="Split PDF by page ranges")
    parser.add_argument("input_pdf", help="Input PDF file")
    parser.add_argument("output_pdf", help="Output PDF file")
    parser.add_argument(
        "--pages",
        required=True,
        help='Page ranges, e.g. "1-5,8,10-12"',
    )
    args = parser.parse_args()

    input_path = Path(args.input_pdf)
    output_path = Path(args.output_pdf)

    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        return 1
    if input_path.suffix.lower() != ".pdf":
        print(f"ERROR: Input must be a PDF file: {input_path}")
        return 1
    if output_path.suffix.lower() != ".pdf":
        print(f"ERROR: Output must be a PDF file: {output_path}")
        return 1

    try:
        total_pages, kept_pages = split_pdf(input_path, output_path, args.pages)
    except (ValueError, RuntimeError) as e:
        print(f"ERROR: {e}")
        return 1

    print(f"Split complete: {output_path}")
    print(f"Selected {kept_pages} page(s) from {total_pages} total page(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
