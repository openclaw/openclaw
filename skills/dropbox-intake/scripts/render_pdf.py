#!/usr/bin/env python3
"""Render PDF pages to PNG images for vision-based extraction."""
import sys
import fitz  # pymupdf

def render(pdf_path, out_prefix="/tmp/dropbox_intake", dpi=200):
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi)
        out = f"{out_prefix}_p{i+1}.png"
        pix.save(out)
        pages.append(out)
    print(f"{len(doc)} pages rendered to {out_prefix}_p*.png")
    return pages

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: render_pdf.py <path.pdf> [out_prefix] [dpi]")
        sys.exit(1)
    pdf = sys.argv[1]
    prefix = sys.argv[2] if len(sys.argv) > 2 else "/tmp/dropbox_intake"
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 200
    render(pdf, prefix, dpi)
