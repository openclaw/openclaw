#!/usr/bin/env python3
"""
Creates a filled quarterly report .docx from scratch using only stdlib.
A .docx is a ZIP archive containing XML files.
"""
import zipfile
import os

OUTPUT_DIR = "/Users/denizburcayhaberal/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/07087d0e-14d6-4635-ac59-cb7a1426a26a/0180c3cf-14ac-4364-b704-5c6dc6dbc8e8/skills/openclaw-template-filler-workspace/iteration-1/eval-2-english-report-with-file/without_skill/outputs"
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "quarterly_report_filled.docx")

# Minimal docx XML templates
CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

WORD_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
</w:styles>'''


def para(text, style=None, bold=False, size=None):
    """Generate a paragraph XML block."""
    pPr = ""
    if style:
        pPr = f"<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>"
    rPr_parts = []
    if bold:
        rPr_parts.append("<w:b/>")
    if size:
        rPr_parts.append(f"<w:sz w:val=\"{size}\"/>")
        rPr_parts.append(f"<w:szCs w:val=\"{size}\"/>")
    rPr = f"<w:rPr>{''.join(rPr_parts)}</w:rPr>" if rPr_parts else ""
    # Escape XML special chars
    safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<w:p>{pPr}<w:r>{rPr}<w:t xml:space=\"preserve\">{safe}</w:t></w:r></w:p>"


def empty_para():
    return "<w:p/>"


def build_document():
    paragraphs = []

    # Title
    paragraphs.append(para("Q1 2024 Quarterly Business Report", style="Heading1"))
    paragraphs.append(para("Prepared by: Finance & Strategy Team  |  Date: March 31, 2024", bold=False))
    paragraphs.append(empty_para())

    # Executive Summary
    paragraphs.append(para("Executive Summary", style="Heading2"))
    paragraphs.append(para(
        "Q1 2024 was a strong quarter for our organization. We exceeded revenue targets, "
        "expanded our customer base, and launched two major product initiatives. Despite "
        "macroeconomic headwinds, the business demonstrated resilience and continued "
        "momentum heading into Q2."
    ))
    paragraphs.append(empty_para())

    # Key Metrics
    paragraphs.append(para("Key Metrics", style="Heading2"))
    metrics = [
        ("Total Revenue", "$4.2M", "+18% YoY"),
        ("New Customers Acquired", "320", "+12% vs Q4 2023"),
        ("Customer Retention Rate", "94%", "Above 90% target"),
        ("Operating Expenses", "$2.8M", "Within budget"),
        ("Net Profit Margin", "28%", "Up from 24% in Q4 2023"),
        ("Monthly Recurring Revenue (MRR)", "$1.05M", "Record high"),
    ]
    for metric, value, note in metrics:
        paragraphs.append(para(f"{metric}: {value}  ({note})", bold=False))
    paragraphs.append(empty_para())

    # Highlights
    paragraphs.append(para("Highlights", style="Heading2"))
    highlights = [
        "Launched Project Aurora — new enterprise dashboard shipped 2 weeks ahead of schedule.",
        "Signed 3 new enterprise contracts totaling $620K in annual recurring revenue.",
        "Customer satisfaction (CSAT) score reached 4.7/5.0, highest in company history.",
        "Grew the engineering team by 8 new hires; onboarding complete ahead of plan.",
        "Expanded into 2 new regional markets: Southeast Asia and Eastern Europe.",
    ]
    for h in highlights:
        paragraphs.append(para(f"- {h}"))
    paragraphs.append(empty_para())

    # Challenges & Risks
    paragraphs.append(para("Challenges & Risks", style="Heading2"))
    paragraphs.append(para(
        "Supply chain disruptions continue to affect hardware delivery timelines, "
        "impacting a subset of enterprise deployments. We have mitigated this by "
        "securing alternative suppliers. Additionally, increased competition in the "
        "mid-market segment is putting pressure on pricing. We are investing in "
        "differentiation through product depth and superior support."
    ))
    paragraphs.append(empty_para())
    risks = [
        "Hardware supply delays — mitigated via dual-sourcing strategy.",
        "Mid-market pricing pressure — addressing with value-add features roadmap.",
        "Key talent retention — expanded equity refresh program approved in Q1.",
        "Regulatory changes in EU — legal team actively monitoring; no material impact expected.",
    ]
    for r in risks:
        paragraphs.append(para(f"- {r}"))
    paragraphs.append(empty_para())

    # Next Steps
    paragraphs.append(para("Next Steps", style="Heading2"))
    next_steps = [
        "Q2 Goal: Achieve $4.8M in revenue; target 15% growth over Q1.",
        "Complete Phase 2 of Project Aurora — mobile companion app launch planned for May.",
        "Hire 5 additional sales reps to accelerate mid-market expansion.",
        "Close pipeline deals valued at $1.1M — 70% probability-weighted.",
        "Initiate Series B funding discussions with 3 pre-identified investors.",
        "Launch customer advisory board to deepen product feedback loops.",
    ]
    for s in next_steps:
        paragraphs.append(para(f"- {s}"))
    paragraphs.append(empty_para())

    # Footer note
    paragraphs.append(para(
        "This report is intended for internal use only. Distribution outside the organization "
        "requires approval from the CFO.",
        bold=False
    ))

    body_content = "\n".join(paragraphs)
    document_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
{body_content}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>'''
    return document_xml


os.makedirs(OUTPUT_DIR, exist_ok=True)

document_xml = build_document()

with zipfile.ZipFile(OUTPUT_FILE, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("[Content_Types].xml", CONTENT_TYPES)
    zf.writestr("_rels/.rels", RELS)
    zf.writestr("word/_rels/document.xml.rels", WORD_RELS)
    zf.writestr("word/styles.xml", STYLES)
    zf.writestr("word/document.xml", document_xml)

print(f"Created: {OUTPUT_FILE}")
