#!/usr/bin/env python3
"""Convert 29 SEC EDGAR contracts to professional PDF using reportlab."""
import json, os, re
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, HRFlowable
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT

BASE = Path(os.path.expanduser("~/Documents/SEC_Contracts_Dataset"))
TEXT_DIR = BASE / "extracted_text"
PDF_DIR = BASE / "pdf_contracts"
DATASET = BASE / "training_dataset.jsonl"


def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name)[:60].strip().replace(' ', '_')


def escape_xml(s):
    """Escape text for reportlab Paragraph (uses XML)."""
    s = s.replace('&', '&amp;')
    s = s.replace('<', '&lt;')
    s = s.replace('>', '&gt;')
    return s


def get_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name='ContractTitle',
        fontName='Helvetica-Bold',
        fontSize=16,
        leading=20,
        textColor=HexColor('#1E1E50'),
        alignment=TA_CENTER,
        spaceAfter=10,
    ))
    styles.add(ParagraphStyle(
        name='Metadata',
        fontName='Helvetica-Oblique',
        fontSize=9,
        textColor=HexColor('#666666'),
        alignment=TA_CENTER,
        spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        name='SourceURL',
        fontName='Helvetica',
        fontSize=7,
        textColor=HexColor('#888888'),
        alignment=TA_CENTER,
        spaceAfter=12,
    ))
    styles.add(ParagraphStyle(
        name='ArticleHeading',
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=16,
        textColor=HexColor('#14145A'),
        spaceBefore=14,
        spaceAfter=6,
    ))
    styles.add(ParagraphStyle(
        name='SectionHeading',
        fontName='Helvetica-Bold',
        fontSize=10,
        leading=14,
        textColor=HexColor('#28285A'),
        spaceBefore=10,
        spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        name='AllCapsHeading',
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=14,
        textColor=HexColor('#1E1E50'),
        spaceBefore=12,
        spaceAfter=5,
    ))
    styles.add(ParagraphStyle(
        name='ContractBody',
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=HexColor('#000000'),
        spaceAfter=3,
    ))
    return styles


def make_pdf(text, meta, output_path):
    styles = get_styles()
    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        topMargin=0.75*inch,
        bottomMargin=0.75*inch,
        leftMargin=0.75*inch,
        rightMargin=0.75*inch,
    )

    story = []

    # Title
    story.append(Paragraph(escape_xml(meta["description"]), styles['ContractTitle']))
    story.append(Spacer(1, 4))

    # Metadata
    story.append(Paragraph(
        escape_xml(f"Agreement Type: {meta['agreement_type']}"),
        styles['Metadata']
    ))
    story.append(Paragraph(
        escape_xml(f"Source: SEC EDGAR"),
        styles['Metadata']
    ))
    story.append(Paragraph(
        escape_xml(meta["source_url"]),
        styles['SourceURL']
    ))

    # Separator
    story.append(HRFlowable(
        width="100%", thickness=1,
        color=HexColor('#28285A'),
        spaceAfter=12, spaceBefore=4
    ))

    # Contract body
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            story.append(Spacer(1, 4))
            continue

        safe = escape_xml(stripped)

        if re.match(r'^(ARTICLE|Article)\s+[IVXLCDM\d]+', stripped):
            story.append(Paragraph(safe, styles['ArticleHeading']))
        elif re.match(r'^(SECTION|Section)\s+[\d]+', stripped):
            story.append(Paragraph(safe[:300], styles['SectionHeading']))
        elif re.match(r'^[A-Z][A-Z\s]{10,60}$', stripped) and not any(c.isdigit() for c in stripped):
            story.append(Paragraph(safe.title(), styles['AllCapsHeading']))
        else:
            story.append(Paragraph(safe, styles['ContractBody']))

    doc.build(story)


def main():
    records = {}
    with open(DATASET) as f:
        for line in f:
            r = json.loads(line)
            records[r["id"]] = r

    PDF_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Converting {len(records)} contracts to PDF (reportlab)...")

    converted = 0
    by_type = {}
    for cid, meta in sorted(records.items()):
        txt_path = TEXT_DIR / f"{cid}.txt"
        if not txt_path.exists():
            continue

        type_folder = PDF_DIR / sanitize(meta["agreement_type"])
        type_folder.mkdir(parents=True, exist_ok=True)
        output_path = type_folder / f"{cid}_{sanitize(meta['description'])}.pdf"

        text = txt_path.read_text(encoding='utf-8')
        try:
            make_pdf(text, meta, output_path)
            size_kb = output_path.stat().st_size / 1024
            print(f"  OK {cid}: {meta['agreement_type'][:25]:25s} | {size_kb:.0f} KB")
            converted += 1
            t = meta["agreement_type"]
            by_type[t] = by_type.get(t, 0) + 1
        except Exception as e:
            print(f"  FAIL {cid}: {e}")

    print(f"\nConverted: {converted}/{len(records)}")
    print(f"\nBy type:")
    for t, c in sorted(by_type.items()):
        print(f"  {t}: {c}")
    total_size = sum(
        f.stat().st_size for f in PDF_DIR.rglob("*.pdf")
    ) / 1024 / 1024
    print(f"\nTotal size: {total_size:.1f} MB")
    print(f"PDFs in: {PDF_DIR}")


if __name__ == "__main__":
    main()
