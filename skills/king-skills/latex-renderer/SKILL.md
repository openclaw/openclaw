---
name: king_skill_latex_renderer
description: Generate and compile scientific documents to PDF, HTML, LaTeX, DOCX using pandoc. Verified PDF engine for arXiv submissions.
metadata:
  {
    "openclaw":
      {
        "emoji": "📜",
        "requires": { "bins": ["pandoc", "python3"] },
        "install":
          [
            {
              "id": "apt",
              "kind": "apt",
              "packages": ["pandoc", "texlive-latex-base", "texlive-science"],
              "label": "Install Pandoc and LaTeX (apt)",
            },
            {
              "id": "pip",
              "kind": "pip",
              "packages": ["weasyprint"],
              "label": "Install weasyprint (pip)",
            },
          ],
        "os": ["darwin", "linux", "win32"],
      },
  }
---

# LaTeX Renderer

Generate and compile scientific documents to PDF, HTML, LaTeX, DOCX using pandoc.

## When to Use

**USE this skill when:**
- Compiling LaTeX documents
- Generating PDF from Markdown
- arXiv submission preparation
- Rendering equations
- BibTeX bibliography handling
- Scientific document formatting

**DON'T use when:**
- Simple text output suffices
- Document format is already correct

## Commands

### Install

```bash
# pandoc: usually pre-installed
which pandoc || sudo apt-get install pandoc -y

# PDF engine (verified working):
pip install weasyprint

# pdflatex:
sudo apt-get install texlive-latex-base texlive-science -y
```

### Verified Conversions

```bash
# MD → PDF (weasyprint)
pandoc paper.md -o paper.pdf --pdf-engine=weasyprint

# MD → DOCX
pandoc paper.md -o paper.docx

# MD → HTML + MathJax
pandoc paper.md -o paper.html --standalone --mathjax

# MD → LaTeX source
pandoc paper.md -o paper.tex --standalone

# MD → PDF with metadata
echo "---
title: 'My Paper'
author: 'Author Name'
date: '2026-04-08'
---" | cat - body.md | pandoc -o paper.pdf --pdf-engine=weasyprint
```

### arXiv-Ready Template

```markdown
---
title: "OpenClaw-P2P: Autonomous Peer Review"
author: "Author Name (ORCID: 0000-0000-0000-0000)"
date: "2026-04-08"
---

# Abstract
...

## 1. Introduction
...

## References
[1] Author, *Title*, arXiv:XXXX.XXXXX (year).
```

## Notes

- Verified PDF engine: weasyprint
- Token savings: ★★★☆☆
- Status: ✅ Verified
