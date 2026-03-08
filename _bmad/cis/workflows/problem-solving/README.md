---
last-redoc-date: 2025-09-28
---

# Problem Solving Workflow

**Type:** Interactive Document Workflow
**Module:** Creative Intelligence System (CIS)

## Purpose

Applies systematic problem-solving methodologies to crack complex challenges. Guides through problem diagnosis, root cause analysis, creative solution generation, evaluation, and implementation planning using proven analytical frameworks.

## Distinctive Features

- **Root Cause Focus**: Relentlessly drills past symptoms to identify true underlying issues
- **Method Library**: Comprehensive solving methods in `solving-methods.csv` (TRIZ, Theory of Constraints, Systems Thinking, Five Whys)
- **Detective Approach**: Methodical and curious investigation treating challenges as elegant puzzles
- **Framework-Driven**: Combines divergent and convergent thinking systematically

## Usage

```bash
# Basic invocation
workflow problem-solving

# With problem context
workflow problem-solving --data /path/to/problem-brief.md
```

## Inputs

- **problem_description**: Challenge being addressed with symptoms and context
- **previous_attempts**: Prior solution attempts and their outcomes
- **constraints**: Boundaries and limitations for solutions
- **success_criteria**: How solution effectiveness will be measured

## Outputs

**File:** `{output_folder}/problem-solution-{date}.md`

**Structure:**

- Problem diagnosis and symptom analysis
- Root cause identification using analytical frameworks
- Solution ideation across multiple methodologies
- Solution evaluation matrix with pros/cons
- Implementation plan with risk mitigation
- Success metrics and validation approach

## Workflow Components

- `workflow.yaml` - Configuration with solving_methods CSV reference
- `instructions.md` - Systematic problem-solving facilitation guide
- `template.md` - Structured analysis output format
- `solving-methods.csv` - Problem-solving methodology library
