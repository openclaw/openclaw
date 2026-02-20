---
name: visual-agent
description: >
  Routes visual tasks (screenshots, images, UI analysis, image-to-code) to
  Kimi K2.5 for native multimodal processing. Kimi's MoonViT encoder (400M params)
  trained on 15T mixed visual-text tokens provides superior vision capabilities.
metadata: { "openclaw": { "emoji": "👁️" } }
---

# Visual Agent

Native multimodal routing to Kimi K2.5 for vision-intensive tasks.

## When to Use

- Screenshot analysis or UI inspection
- Image-to-code conversion (website reconstruction)
- Visual debugging (identify CSS/layout issues from screenshots)
- Data extraction from images (tables, charts, diagrams)
- Document OCR and visual content understanding
- Video frame analysis

## Activation

- **Automatic:** Input contains image attachment or visual keywords
- **Manual:** "analyse this screenshot", "convert this image to code", "visual debug"

## Procedure

### Step 1: Route to Kimi K2.5

```bash
sessions_spawn(
  model="kimi/kimi-k2.5",
  task="[VISUAL_TASK_PROMPT with image reference]",
  label="visual-agent"
)
```

### Step 2: Task-Specific Prompting

**For data extraction:**

```
Analyse this image and extract all data in structured JSON format.
Preserve table structure, numerical values, and labels.
Rate confidence for each extracted value (0.0-1.0).
```

**For image-to-code:**

```
Convert this screenshot/design into production-ready code.
Use: [HTML/CSS/React/specified framework]
Requirements: responsive, semantic HTML, accessible.
Match the visual design as closely as possible.
```

**For visual debugging:**

```
Inspect this UI screenshot for issues:
- Layout/alignment problems
- Responsive design issues
- Accessibility concerns
- CSS inconsistencies
Provide specific fixes with code snippets.
```

### Step 3: Optional Verification (Opus)

For `extract_data` and `image_to_code` tasks, Opus verifies Kimi's output:

```
Kimi K2.5 produced the following analysis of an image:
{kimi_response}

Verify for: completeness, accuracy, code correctness.
```

## Fallback Chain

1. **Primary:** Kimi K2.5 (native multimodal, MoonViT encoder)
2. **Fallback:** Opus 4.6 (has image understanding but not native multimodal)
3. **If both fail:** Queue task, notify HH

## Error Handling

- Kimi unavailable: fallback to Opus for image analysis
- Image too large: auto-resize to max 4096px longest edge
- Unsupported format: convert to PNG first
- Low confidence output: flag for human review

## Performance Notes

- Kimi OCRBench: 92.3% (best in class)
- Kimi MathVista: 90.1% (visual math reasoning)
- Native vision-code pipeline eliminates the "describe then code" bottleneck
