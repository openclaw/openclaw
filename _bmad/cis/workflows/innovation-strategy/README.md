---
last-redoc-date: 2025-09-28
---

# Innovation Strategy Workflow

**Type:** Interactive Document Workflow
**Module:** Creative Intelligence System (CIS)

## Purpose

Identifies disruption opportunities and architects business model innovation through strategic analysis of markets, competitive dynamics, and value chain transformation. Uncovers sustainable competitive advantages and breakthrough opportunities using proven innovation frameworks.

## Distinctive Features

- **Strategic Focus**: Emphasizes business model innovation over feature innovation
- **Framework Library**: Comprehensive innovation frameworks in `innovation-frameworks.csv` (Jobs-to-be-Done, Blue Ocean, Disruptive Innovation)
- **Market Analysis**: Systematic evaluation of disruption potential and competitive positioning
- **Pragmatic Lens**: Ruthlessly focused on sustainable competitive advantage

## Usage

```bash
# Basic invocation
workflow innovation-strategy

# With market context
workflow innovation-strategy --data /path/to/industry-analysis.md
```

## Inputs

- **market_context**: Industry landscape and competitive intelligence
- **innovation_challenge**: Strategic opportunity or threat being addressed
- **constraints**: Resource limitations and strategic boundaries
- **recommended_inputs**: Existing competitive analysis or market research

## Outputs

**File:** `{output_folder}/innovation-strategy-{date}.md`

**Structure:**

- Market landscape and disruption analysis
- Jobs-to-be-Done identification
- Business model innovation opportunities
- Blue ocean strategy mapping
- Competitive advantage assessment
- Implementation roadmap and strategic priorities

## Workflow Components

- `workflow.yaml` - Configuration with innovation_frameworks CSV reference
- `instructions.md` - Strategic innovation facilitation guide
- `template.md` - Strategic output format
- `innovation-frameworks.csv` - Business model innovation frameworks library
