# vtl-image-analysis

**Visual Thinking Lens compositional analysis for AI-generated images.**

Measures structural coordinates, detects default-mode bias, and generates
targeted re-prompts via configurable operators.

## What It Does

Runs a five-metric structural health check on a generated image:

| Metric | What It Detects |
|--------|----------------|
| **Δx,y** | Placement offset from frame center |
| **rᵥ** | Void ratio (gradient field sparsity) |
| **ρᵣ** | Packing density (convex hull fill) |
| **k_var / infl_density** | Curvature torque (directional tension along contours) |
| **dRC** | Radial compliance delta (frame-lock vs. mass-anchor) |

Flags default-mode patterns. Generates re-prompts via rule-based operators
in `operators.yaml` — deterministic, not AI-invented.

**Hard stop:** If measurement fails (insufficient structure, bad mask), the
skill refuses to report coordinates or generate re-prompts. No fabricated
diagnosis.

## Install

```bash
clawhub install vtl-image-analysis
```

Or drop the folder into `~/.openclaw/skills/`.

**Dependencies:** python3, numpy, opencv-python-headless, scikit-image, scipy, pyyaml

## Usage

Talk to your agent:

- "Analyze this image's composition"
- "Why does this generated image look generic?"
- "Diagnose and re-prompt this image"

Or run directly:

```bash
# Measure
python3 scripts/vtl_probe.py image.png

# Batch measure a folder
python3 scripts/vtl_probe.py path/to/folder/

# Generate re-prompts
python3 scripts/vtl_regen.py \
  --prompt "YOUR ORIGINAL PROMPT" \
  --metrics metrics.jsonl \
  --out prompts.json
```

## Customizing Operators

Re-prompt behavior lives in `operators.yaml`. Triggers are simple expressions
evaluated against metric values. Patch text is appended to the original prompt.

Edit `operators.yaml` to tune thresholds, change patch language, or add new
operators. The measurement code is separate and unchanged.

## Files

```
vtl-image-analysis/
├── SKILL.md                  — agent instructions
├── operators.yaml            — re-prompt operators (edit to customize)
├── scripts/
│   ├── vtl_probe.py          — measurement (deterministic, version-locked)
│   └── vtl_regen.py          — operator selection + prompt patching
└── references/
    └── vtl-metrics.md        — full metric definitions and math
```

## Background

Built on the **Visual Thinking Lens (VTL)** framework — empirical measurement
of compositional structure in AI-generated images across Sora, MidJourney,
OpenArt, and other platforms.

Core finding: AI models exhibit measurable compositional priors — attractor
coordinates that persist regardless of prompt content. Semantically diverse
prompts map to structurally identical coordinates.

**Full framework:** https://github.com/rusparrish/Visual-Thinking-Lens  
**Author:** Russell Parrish — https://artistinfluencer.com
