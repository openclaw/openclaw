---
name: king_skill_report_generator
description: Generate structured scientific papers, reports, and OpenClaw submissions from verified results. Outputs arXiv-ready Markdown + LaTeX.
metadata:
  openclaw:
    emoji: 📝
    requires:
      bins: ["python3", "pandoc"]
    install:
      - type: pip
        packages: ["jinja2"]
      - type: apt
        packages: ["pandoc"]
    os: ["darwin", "linux", "win32"]
---

# Report Generator

Generate structured scientific papers, reports, and OpenClaw submissions from verified results.

## When to Use

**USE this skill when:**
- Generating scientific papers
- Creating reports
- arXiv submission preparation
- Drafting manuscripts
- Summarizing results into papers

**DON'T use when:**
- Simple text output suffices
- No structured template needed

## Commands

### OpenClaw Paper Template

```python
def generate_openclaw_paper(results: dict, config: dict) -> str:
    template = """# {title}

**Authors:** {authors}
**Date:** {date}
**arXiv:** cs.AI, cs.MA, cs.DC

## Abstract

{abstract}

## Claims-Boundary Matrix (CBM)

| Claim | Status | Verification |
|-------|--------|-------------|
{cbm_rows}

## Results

| Metric | Value |
|--------|-------|
{result_rows}

## Verification

- Lean 4 formal verification: {lean4_status}
- LLM judges: {n_judges} independent evaluators
- Consensus score: {consensus:.3f} ± {std:.3f}

## References

{references}
"""
    cbm_rows = "\n".join(
        f"| {c['claim']} | {c['status']} | {c['method']} |"
        for c in results.get("claims", [])
    )
    result_rows = "\n".join(
        f"| {k} | {v} |" for k, v in results.get("metrics", {}).items()
    )
    return template.format(
        cbm_rows=cbm_rows,
        result_rows=result_rows,
        **config
    )
```

### Compile to PDF

```python
import subprocess

def compile_paper(md_content: str, output_pdf: str):
    with open("/tmp/paper.md", "w") as f:
        f.write(md_content)
    subprocess.run([
        "pandoc", "/tmp/paper.md",
        "-o", output_pdf,
        "--pdf-engine=xelatex",
    ], check=True)
```

## Notes

- Outputs arXiv-ready Markdown + LaTeX
- Token savings: 3/5
- Status: ✅ Verified
