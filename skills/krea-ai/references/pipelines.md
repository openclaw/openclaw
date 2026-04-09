# Pipelines — Multi-Step Workflows

Use `pipeline.py` to chain multiple steps automatically. Each step's output feeds into the next. Write a JSON pipeline and run it in one command.

```bash
uv run {baseDir}/scripts/pipeline.py --pipeline pipeline.json [--api-key KEY]
```

## Pipeline JSON Format

```json
{
  "steps": [
    {
      "action": "generate_image | generate_video | enhance | fan_out",
      "model": "model-id",
      "prompt": "...",
      "filename": "base-name",
      "use_previous": true,
      "...": "any other model-specific params"
    }
  ]
}
```

**Actions:**
- `generate_image` — generate an image
- `generate_video` — generate a video
- `enhance` — upscale/enhance an image
- `fan_out` — run a sub-step for EACH result from the previous step (branching)

**Special fields:**
- `use_previous: true` — use the output URL(s) from the previous step as input
- `fan_out` has a `step` field containing the template to run per source URL
- In fan_out prompts/filenames, `{i}` is replaced with the iteration number (1, 2, 3...)

**Key casing:** Pipeline-own fields use `snake_case` (`use_previous`, `fan_out`, `image_url`). Krea API fields use `camelCase` (`aspectRatio`, `batchSize`, `generateAudio`, `startImage`). Match the casing shown in the examples below.

**Template syntax:** Two kinds of substitution exist and serve different purposes:
- `{i}` — fan_out iteration index (1, 2, 3...). Only replaced inside `fan_out` sub-steps.
- `{{key}}` — user-provided template variables via `--var key=value`. Replaced globally before execution.

## Pipeline Parameters

| Param | Description | Default |
|-------|-------------|---------|
| `--pipeline` | Path to JSON file or inline JSON string (required) | — |
| `--api-key` | Krea API token | env `KREA_API_TOKEN` |
| `--output-dir` | Output directory for all generated files | cwd |
| `--dry-run` | Estimate CU cost without executing | false |
| `--resume` | Skip completed steps (uses `.pipeline-state.json` manifest) | false |
| `--max-parallel` | Max concurrent jobs for parallel fan_out | 3 |
| `--var` | Template variable (repeatable): `--var key=value` | — |
| `--notify` | Desktop notification when pipeline finishes (Linux/macOS) | false |

## Example: Generate → 4 Angles → 4 Videos

Generate a concept image, create 4 angle variations, then animate each one:

```json
{
  "steps": [
    {
      "action": "generate_image",
      "model": "flux",
      "prompt": "a red sports car on an empty highway, golden hour, cinematic",
      "filename": "car-concept"
    },
    {
      "action": "fan_out",
      "use_previous": true,
      "step": {
        "action": "generate_image",
        "model": "gpt-image",
        "prompt": "same red sports car, angle {i} of 4: front three-quarter view at angle {i}, professional automotive photography, studio lighting, white background",
        "filename": "car-angle-{i}"
      }
    },
    {
      "action": "fan_out",
      "use_previous": true,
      "step": {
        "action": "generate_video",
        "model": "kling-2.5",
        "prompt": "the red sports car slowly rotates on a turntable, smooth motion, studio lighting",
        "duration": 5,
        "filename": "car-spin-{i}"
      }
    }
  ]
}
```

Run it:
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline car-pipeline.json
```

## Example: Generate → Upscale → Animate with Audio

```json
{
  "steps": [
    {
      "action": "generate_image",
      "model": "nano-banana-pro",
      "prompt": "a majestic dragon perched on a cliff overlooking a stormy ocean",
      "filename": "dragon"
    },
    {
      "action": "enhance",
      "use_previous": true,
      "enhancer": "topaz-generative",
      "width": 4096,
      "height": 4096,
      "creativity": 3,
      "filename": "dragon-4k"
    },
    {
      "action": "generate_video",
      "use_previous": true,
      "model": "veo-3",
      "prompt": "the dragon spreads its wings and roars, lightning strikes, waves crash below, epic cinematic",
      "duration": 8,
      "generateAudio": true,
      "filename": "dragon-epic"
    }
  ]
}
```

## Example: Product Photography Pipeline

Generate hero shot → 4 style variations → upscale all:

```json
{
  "steps": [
    {
      "action": "generate_image",
      "model": "gpt-image",
      "prompt": "minimalist perfume bottle, frosted glass, on marble surface, soft studio lighting, product photography",
      "quality": "high",
      "filename": "perfume-hero"
    },
    {
      "action": "fan_out",
      "use_previous": true,
      "step": {
        "action": "generate_image",
        "model": "gpt-image",
        "prompt": "same perfume bottle, variation {i}: 1=morning light with flowers, 2=dark moody with smoke, 3=underwater with bubbles, 4=floating in clouds",
        "filename": "perfume-mood-{i}"
      }
    },
    {
      "action": "fan_out",
      "use_previous": true,
      "step": {
        "action": "enhance",
        "enhancer": "topaz",
        "width": 4096,
        "height": 4096,
        "filename": "perfume-final-{i}"
      }
    }
  ]
}
```

## Inline Pipeline (no JSON file needed)

For quick pipelines, pass JSON directly:
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline '{"steps":[{"action":"generate_image","model":"flux","prompt":"a cat astronaut","filename":"cat"},{"action":"enhance","use_previous":true,"enhancer":"topaz","width":4096,"height":4096,"filename":"cat-4k"}]}'
```

## Building Pipelines for Users

When a user asks for something complex like "generate a product shot from 4 angles and make videos of each":

1. Write a pipeline JSON with the right steps
2. Save it to a `.json` file in the current directory
3. Run it with `pipeline.py --pipeline file.json`
4. Show the user the saved file paths when done

**Tips:**
- Use `fan_out` to branch — it runs the sub-step once per result from the previous step
- `use_previous: true` chains steps automatically
- Start cheap (`flux`) for concept, switch to quality (`gpt-image`, `nano-banana-pro`) for finals
- Upscale as the last step before video — cheaper and better quality
- Use `{i}` in prompts and filenames inside `fan_out` to vary per iteration

## Advanced Features

**Template variables** — Use `{{variable}}` in pipeline JSON and pass values at runtime:
```bash
uv run {baseDir}/scripts/pipeline.py --pipeline template.json --var subject="red sports car" --var style="cinematic"
```
Pipeline JSON can then use `{{subject}}` and `{{style}}` anywhere in prompts, filenames, etc. All variables must be provided or the pipeline exits with an error.

**Parallel fan_out** — Add `"parallel": true` to a fan_out step to run all sub-jobs concurrently:
```json
{
  "action": "fan_out",
  "use_previous": true,
  "parallel": true,
  "step": { "action": "enhance", "enhancer": "topaz", "width": 4096, "height": 4096, "filename": "upscaled-{i}" }
}
```
Control concurrency with `--max-parallel N` (default: 3).

**Resume interrupted pipelines** — Use `--resume` to skip already-completed steps. The pipeline saves a `.pipeline-state.json` manifest after each step, recording result URLs. On resume, `use_previous` chains are correctly restored from the manifest.

**Dry-run** — Use `--dry-run` to estimate CU cost without executing.

**Notifications** — Use `--notify` to get a desktop notification when a pipeline finishes (Linux/macOS).
