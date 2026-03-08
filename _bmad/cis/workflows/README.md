# CIS Workflows

Five interactive workflows facilitating creative and strategic processes through curated technique libraries and structured facilitation.

## Table of Contents

- [Workflow Overview](#workflow-overview)
- [Common Features](#common-features)
- [Usage](#usage)
- [Configuration](#configuration)

## Workflow Overview

### [Brainstorming](./brainstorming)

**Purpose:** Interactive ideation using 36 techniques across 7 categories

**Approach:** Master facilitation with "Yes, and..." methodology

**Techniques:** Collaborative, structured, creative, deep, theatrical, wild, introspective

**Selection Modes:** User-selected, AI-recommended, random, or progressive

### [Design Thinking](./design-thinking)

**Purpose:** Human-centered design through five phases

**Process:** Empathize → Define → Ideate → Prototype → Test

**Focus:** Divergent thinking before convergent action

**Output:** User empathy insights and rapid prototypes

### [Innovation Strategy](./innovation-strategy)

**Purpose:** Identify disruption opportunities and business model innovation

**Frameworks:** Jobs-to-be-Done, Blue Ocean Strategy, Value Chain Analysis

**Focus:** Sustainable competitive advantage over features

**Output:** Strategic innovation roadmap

### [Problem Solving](./problem-solving)

**Purpose:** Systematic challenge resolution

**Methods:** TRIZ, Theory of Constraints, Systems Thinking, Root Cause Analysis

**Approach:** Detective-style puzzle solving

**Output:** Root cause identification and solution strategies

### [Storytelling](./storytelling)

**Purpose:** Craft compelling narratives

**Frameworks:** Hero's Journey, Three-Act Structure, Story Brand (25 total)

**Customization:** Platform and audience-specific adaptation

**Style:** Whimsical master storyteller facilitation

## Common Features

All workflows share:

- **Interactive Facilitation** - AI guides through questions, not generation
- **Technique Libraries** - CSV databases of proven methods
- **Context Integration** - Optional document input for domain relevance
- **Structured Output** - Comprehensive reports with insights and actions
- **Energy Monitoring** - Adaptive pacing based on engagement

## Usage

### Basic Invocation

```bash
workflow brainstorming
workflow design-thinking
workflow innovation-strategy
workflow problem-solving
workflow storytelling
```

### With Context

```bash
workflow [workflow-name] --data /path/to/context.md
```

### Via Agent

```bash
agent cis/brainstorming-coach
> *brainstorm
```

## Configuration

Edit `/_bmad/cis/config.yaml`:

| Setting                | Purpose                 | Default            |
| ---------------------- | ----------------------- | ------------------ |
| output_folder          | Result storage location | ./creative-outputs |
| user_name              | Session participant     | User               |
| communication_language | Facilitation language   | english            |

## Workflow Structure

Each workflow contains:

```
workflow-name/
├── workflow.yaml      # Configuration
├── instructions.md    # Facilitation guide
├── techniques.csv     # Method library
└── README.md         # Documentation
```

## Best Practices

1. **Prepare context** - Provide background documents for better results
2. **Set clear objectives** - Define goals before starting
3. **Trust the process** - Let facilitation guide discovery
4. **Capture everything** - Document insights as they emerge
5. **Take breaks** - Pause when energy drops

## Integration

CIS workflows integrate with:

- **BMM** - Project brainstorming and ideation
- **BMB** - Creative module design
- **Custom Modules** - Shared creative resource

---

For detailed workflow instructions, see individual workflow directories.
