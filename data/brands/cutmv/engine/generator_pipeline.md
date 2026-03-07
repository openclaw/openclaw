# CUTMV Creative Engine — Generator Pipeline

## Overview

The CUTMV Creative Engine produces final-ready PNG/MP4/SVG assets by combining:
- **Brand rules** (creative_rules.json) — hard constraints
- **Copy dataset** (JSONL) — approved text blocks
- **Templates** (template_registry.json) — deterministic layout structures
- **MotionSpec** (motion_spec_schema.json) — render instructions for Remotion
- **Validators** — automated QA gates before export

The engine guarantees "zero post-edit" output by never allowing freeform generation. Every visual is assembled from validated components through deterministic rendering.

---

## Pipeline Stages

### Stage 1: Brief Intake

**Input:** Creative brief (JSON or natural language)
**Output:** Structured brief object

```json
{
  "brand": "cutmv",
  "type": "motion_ad",
  "goal": "drive signups",
  "audience": "music marketers",
  "aspect_ratio": "9:16",
  "platform": "instagram_reels",
  "key_message": "speed + automation",
  "cta": "TRY CUTMV"
}
```

The planner (Claude) parses unstructured briefs into this format. All fields are validated against creative_rules.json before proceeding.

---

### Stage 2: Copy Selection

**Input:** Structured brief
**Output:** Selected copy blocks (headline, body, CTA, bullets)

Process:
1. Query the copy dataset (brands/cutmv/datasets/copy/) for entries matching the brief's intent and audience.
2. Filter by `status: "approved"` or `status: "approved_seed"` only.
3. Validate selected copy against:
   - `banned_phrases` list
   - `no_dollar_pricing` rule
   - `ALL_CAPS` constraint
   - `retention_accuracy` (upload = 24h, export = 29d)
4. If no approved copy matches, generate new copy constrained by voice.tone and copy_rules, then validate before use.

Copy blocks returned:
- `headline` — primary text (from hooks.jsonl or hero.jsonl)
- `subheadline` — supporting text (from body.jsonl)
- `cta` — call to action (from ctas.jsonl, default: "TRY CUTMV")
- `bullets` — feature/benefit list (from bullets.jsonl)
- `metric` — social proof number (from hooks.jsonl, angle: social_proof)

---

### Stage 3: Template Selection

**Input:** Structured brief + selected copy
**Output:** Template ID from template_registry.json

Process:
1. Match brief.type to template.type
2. Match brief.goal/key_message to template.use_case
3. Verify brief.aspect_ratio is in template.aspect_ratios
4. Verify selected copy satisfies template.required_blocks
5. Return best-matching template ID

If multiple templates match, rank by:
1. Exact use_case match
2. Required blocks coverage
3. Duration range fit

---

### Stage 4: MotionSpec Generation

**Input:** Template + copy blocks + brief
**Output:** Complete MotionSpec JSON (validated against motion_spec_schema.json)

Process:
1. Load template structure (required_blocks + optional_blocks)
2. Map copy blocks to structure positions
3. Assign timing:
   - Headline enters first (0.3s–1.0s)
   - Supporting elements stagger at 0.06s intervals
   - CTA enters at `duration - cta_last_seconds` (last 2 seconds)
4. Assign animations from template defaults
5. Set resolution from aspect_ratio mapping:
   - 1:1 → 1080×1080
   - 4:5 → 1080×1350
   - 9:16 → 1080×1920
   - 16:9 → 1920×1080
6. Validate against motion_spec_schema.json

---

### Stage 5: Pre-Render Validation

**Input:** MotionSpec
**Output:** Pass/fail with error list

Validators run (from creative_rules.json):
- `palette` — all colors in allowed list
- `typography_caps` — all text blocks are ALL_CAPS
- `cta_present` — CTA block exists in structure
- `banned_phrases` — no text contains banned phrases
- `no_dollar_pricing` — no dollar amounts in any text
- `retention_accuracy` — any retention claims match canonical (uploads=24h, exports=29d)
- `safe_margins` — no elements within 7% of edges

**Gate:** If any validator fails with severity "block", the spec is rejected and sent back to Stage 4 for correction. The pipeline does NOT proceed to rendering.

---

### Stage 6: Remotion Render

**Input:** Validated MotionSpec + assets
**Output:** MP4/GIF file

Process:
1. Load the Remotion template matching template_id
2. Pass MotionSpec as props
3. Remotion renders deterministically — same spec = same output every time
4. Export at specified resolution and fps
5. For static outputs: render frame 0 as PNG, or render SVG from template

Render command:
```
npx remotion render <CompositionId> out/<brand>__motion__<template>__<platform>__<WxH>__dur-<sec>__v###.mp4
```

---

### Stage 7: Post-Render Validation

**Input:** Rendered file
**Output:** Pass/fail with QA report

Post-render checks:
- `contrast` — WCAG AA minimum (4.5:1 for normal text, 3:1 for large text)
- `safe_margins` — visual verification that no text touches edges
- File size within platform limits
- Duration matches spec
- Resolution matches spec

---

### Stage 8: Export

**Input:** Validated render
**Output:** Final asset + build report

Process:
1. Move to `brands/cutmv/exports/approved/` (or `rejected/` if failed)
2. Generate build report:
   ```json
   {
     "asset_id": "cutmv__motion__hook-metrics__reels__1080x1920__dur-12__v001",
     "template": "hook_metrics_v1",
     "brief_id": "brief_001",
     "copy_ids_used": ["cmv_hook_1002", "cmv_body_0001", "cmv_cta_0001"],
     "validators_passed": ["palette", "contrast", "typography_caps", "cta_present", "safe_margins", "banned_phrases"],
     "render_time_sec": 4.2,
     "file_size_mb": 1.8,
     "approved": true
   }
   ```
3. Append to manifest (manifests/cutmv.motion.jsonl)
4. Asset is ready to post — zero edits needed

---

## Architecture Diagram

```
Brief → [Planner/Claude] → Structured Brief
                              ↓
                    [Copy Selector] ← copy dataset (JSONL)
                              ↓
                    [Template Matcher] ← template_registry.json
                              ↓
                    [MotionSpec Generator] → MotionSpec JSON
                              ↓
                    [Pre-Render Validator] ← creative_rules.json
                              ↓ (pass only)
                    [Remotion Renderer] → MP4/PNG/SVG
                              ↓
                    [Post-Render Validator]
                              ↓ (pass only)
                    [Exporter] → approved/ + build report
```

---

## Key Guarantees

1. **No freeform layout** — every visual uses a registered template
2. **No unvalidated copy** — all text passes through banned phrase + caps + contradiction checks
3. **No color drift** — palette validator blocks off-brand colors
4. **No pricing errors** — dollar amounts are banned, only credit-based language
5. **No retention confusion** — uploads (24h) and exports (29d) always distinguished
6. **Deterministic output** — same MotionSpec = same render, every time
7. **Full audit trail** — build report traces every decision back to source data
