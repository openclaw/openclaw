---
name: king_skill_doc_transform
description: Convert documents between formats (PDF, DOCX, MD, LaTeX, HTML) using pandoc. Parse PDFs and extract text.
metadata:
  openclaw:
    emoji: 📄
    requires:
      bins: ["pandoc", "python3"]
    install:
      - type: apt
        packages: ["pandoc"]
      - type: pip
        packages: ["pdfminer.six", "python-docx"]
    os: ["darwin", "linux", "win32"]
---

# Document Transform

Convert documents between formats (PDF, DOCX, MD, LaTeX, HTML) using pandoc.

## When to Use

**USE this skill when:**
- Converting PDF to text
- Transforming DOCX to Markdown
- Generating PDF from Markdown
- Compiling LaTeX documents
- Extracting text from documents

**DON'T use when:**
- Document format is already correct
- Direct file reading suffices

## Commands

### Install

```bash
sudo apt-get install pandoc -y
pip install pdfminer.six python-docx
```

### Pandoc Conversions

```bash
# MD → PDF (requires LaTeX)
pandoc paper.md -o paper.pdf --pdf-engine=xelatex

# MD → DOCX
pandoc paper.md -o paper.docx

# PDF → text
python3 -c "
from pdfminer.high_level import extract_text
text = extract_text('paper.pdf')
print(text[:2000])
"

# DOCX → markdown
pandoc paper.docx -t markdown -o paper.md

# LaTeX → PDF
pdflatex paper.tex
```

### Paper Pipeline

```bash
# Full pipeline: markdown → peer-review-ready PDF
pandoc openclaw_paper.md \
  --bibliography=refs.bib \
  --csl=ieee.csl \
  -o openclaw_paper.pdf \
  --pdf-engine=xelatex
```

## Notes

- Never manually transcribe document content
- Token savings: 5/5
- Status: ✅ Verified
