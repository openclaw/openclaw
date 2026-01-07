# The Builders Podcast Generator v2

Generate Acquired-style podcast episodes with two distinct hosts.

## Two Modes

| Mode | Flag | Duration | Research | Turns | Use Case |
|------|------|----------|----------|-------|----------|
| **Quick Dive** | `--quick` | 15-20 min | 1 pass Gemini | ~110 | Fast turnaround |
| **Deep Dive** | `--deep` | 45-60 min | 5-layer + o3 synthesis | ~250 | True Acquired-style |

## Quick Start

```bash
cd /home/elie/github/clawdis/skills/thebuilders-v2

# Quick dive (15-20 min) - default
node scripts/generate.mjs "Costco" -o /tmp/costco

# Deep dive (45-60 min)
node scripts/generate.mjs "Costco" --deep -o /tmp/costco-deep

# Skip research (use existing)
node scripts/generate.mjs "Costco" --deep -o /tmp/costco --skip-research
```

## Quick Dive Mode

Single research pass, 8 sections:
- INTRO (8 turns)
- HOOK (12 turns)
- ORIGIN (20 turns)
- INFLECTION_1 (18 turns)
- INFLECTION_2 (18 turns)
- MESSY_MIDDLE (14 turns)
- NOW (12 turns)
- TAKEAWAYS (10 turns)

**Total: ~112 turns / 15-20 min**

## Deep Dive Mode

5-layer research + 11 sections:

### Research Layers
1. **Overview** - Gemini Deep Research
2. **Founders** - Interview quotes, early stories
3. **Decisions** - Contemporary WSJ/NYT coverage
4. **Financials** - Revenue, margins, metrics
5. **Contrarian** - Failures, criticism, struggles

### Research Synthesis (o3)
Extracts:
- 50 most surprising facts
- 10 best quotes with attribution
- 5 "Wait, really?" moments
- Key timeline with dates
- Contrarian takes

### Sections
- INTRO (10 turns)
- HOOK (15 turns)
- ORIGIN (35 turns) - deep founder story
- EARLY_PRODUCT (25 turns) - how it actually worked
- INFLECTION_1 (25 turns) - first major decision
- SCALE (25 turns) - operational details
- INFLECTION_2 (25 turns) - second crisis
- COMPETITION (20 turns)
- CULTURE (20 turns)
- NOW (20 turns)
- TAKEAWAYS (15 turns)

**Total: ~235 turns / 45-60 min**

## The Hosts

| Host | Voice | Perspective |
|------|-------|-------------|
| **Maya Chen** (Person1) | alloy | Technical - "How does this actually work?" |
| **James Porter** (Person2) | echo | Strategic - "For context... The lesson here is..." |

## Output Files

```
output/
├── research.md              # Quick mode research
├── research-combined.md     # Deep mode combined research
├── research-synthesis.md    # Deep mode o3 synthesis
├── hooks.md                 # Hook options
├── script.txt               # Full dialogue
├── audio/                   # Individual turns
└── episode.mp3              # Final episode
```

## Time Estimates

| Mode | Research | Script | TTS | Total |
|------|----------|--------|-----|-------|
| Quick | 5 min | 3 min | 1 min | ~10 min |
| Deep | 15 min | 10 min | 3 min | ~30 min |

## Key Differences

| Aspect | Quick | Deep |
|--------|-------|------|
| Research passes | 1 | 5 |
| Research synthesis | None | o3 extracts key facts |
| Sections | 8 | 11 |
| ORIGIN depth | 20 turns | 35 turns |
| Quotes required | Encouraged | Mandatory |
| Context per section | 10KB | 25KB |
