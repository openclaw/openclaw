---
last-redoc-date: 2025-09-28
---

# Storytelling Workflow

**Type:** Interactive Document Workflow
**Module:** Creative Intelligence System (CIS)

## Purpose

Crafts compelling narratives using proven story frameworks and techniques. Guides structured narrative development, applying appropriate story frameworks to create emotionally resonant and engaging stories for any purpose—brand narratives, user stories, change communications, or creative fiction.

## Distinctive Features

- **Framework Library**: Comprehensive story frameworks in `story-types.csv` (Hero's Journey, Three-Act Structure, Story Brand, etc.)
- **Emotional Psychology**: Leverages deep understanding of universal human themes and emotional connection
- **Platform Adaptation**: Tailors narrative structure to medium and audience
- **Whimsical Facilitation**: Flowery, enrapturing communication style that embodies master storytelling

## Usage

```bash
# Basic invocation
workflow storytelling

# With brand or project context
workflow storytelling --data /path/to/brand-info.md
```

## Inputs

- **story_purpose**: Why the story is being told (persuade, educate, entertain, inspire)
- **target_audience**: Who will experience the narrative
- **story_subject**: What or whom the story is about
- **platform_medium**: Where the story will be told
- **desired_impact**: What audience should feel/think/do after

## Outputs

**File:** `{output_folder}/story-{date}.md`

**Structure:**

- Story framework selection and rationale
- Character development and voice
- Narrative arc with tension and resolution
- Emotional beats and human truths
- Vivid sensory details and concrete moments
- Platform-specific adaptations
- Impact measurement approach

## Workflow Components

- `workflow.yaml` - Configuration with story_frameworks CSV reference
- `instructions.md` - Narrative development facilitation guide
- `template.md` - Story output format
- `story-types.csv` - Narrative framework library
