# Media Inputs

How to pass reference images, videos, and audio. Mirrored from MCP server media-handling logic.

## Path or UUID — both work

Each media flag accepts either a local file path or a UUID. The CLI auto-uploads paths before submission and auto-detects whether a UUID is an upload id (from `higgsfield upload create`) or a previous job id.

```bash
# Local path — CLI uploads automatically
higgsfield generate create nano_banana_2 --prompt "stylize in watercolor" --image ./photo.png --wait

# Upload id (from higgsfield upload create)
higgsfield generate create nano_banana_2 --prompt "..." --image <upload_id> --wait

# Job id from a previous generation
higgsfield generate create seedance_2_0 --prompt "anim" --start-image <previous_job_id> --wait
```

Type auto-detected from extension:

- Image: `png`, `jpg`/`jpeg`, `webp`, `gif`
- Video: `mp4`, `mov`, `webm`
- Audio: `mp3`, `wav`, `m4a`, `ogg`

## Roles by model family

Each model declares a closed set of accepted roles via `MEDIA_ROLES`. Pass the right role; the CLI rejects unknown ones locally before submission.

| Model | Accepted roles | Notes |
|---|---|---|
| Most image models (`nano_banana_2`, `flux_2`, `seedream_v4_5`, `gpt_image_2`, …) | `image` | 1+ references, often up to 8. |
| `seedance_2_0` | `image`, `start_image`, `end_image`, `video`, `audio` | Audio is via `medias` (role `audio`), NOT via `--generate-audio`. |
| `kling3_0` | `start_image`, `end_image` | Image-to-video with optional last-frame transition. |
| `kling2_6` | `start_image` | Single frame anchor. |
| `veo3_1` | `start_image` | Max 1 reference. |
| `veo3` | `image` | Single image-to-video. |
| `marketing_studio_video` | `image`, `start_image`, `end_image` | Plus `avatars`, `product_ids`, `assets` as separate fields. |
| `z_image`, `soul_cast`, `soul_location` | (none) | Text-only. Reject media inputs. |

For simple image-to-video on a video model that only declares `image` (e.g. `veo3`), plain `--image` is auto-remapped to `start_image` by the CLI when unambiguous. When in doubt:

```bash
higgsfield model get <model_id>   # shows the accepted media roles for this model
```

## Multiple images

Most image models accept multiple references — repeat the `--image` flag:

```bash
higgsfield generate create nano_banana_2 --prompt "..." \
  --image ./a.png --image ./b.png --image <upload_id> \
  --wait
```

Single-reference video models (`veo3`, `veo3_1`, `kling2_6`) reject extra images — the CLI errors locally before submission with `Model accepts only one image reference`.

## Audio reference (Seedance)

`seedance_2_0` is the one model that takes an audio reference for lipsync / soundtrack matching. Pass via `medias` with role `audio`:

```bash
higgsfield generate create seedance_2_0 \
  --prompt "person speaking" \
  --start-image ./headshot.png \
  --audio ./voice.mp3 \
  --duration 8 \
  --wait
```

**Do NOT pass `--generate-audio` to `seedance_2_0`** — the model schema doesn't declare it. Use the audio media role instead.

## Schema mismatches

The CLI returns specific error messages for known shape mismatches:

- `Model accepts only --image (no roles)` — the model uses the legacy `input_images` shape, not `medias` with roles. Drop role-prefixed flags and use plain `--image`.
- `Model does not accept media inputs` — the model is text-only (`z_image`, `soul_location`, `soul_cast`, `wan2_6` for some configs). Drop all media flags.
- `Unknown media role "<role>"` — the role isn't in this model's `MEDIA_ROLES`. Run `higgsfield model get <model>` and check `medias[].roles`.

## Seeing what a model accepts

```bash
higgsfield model get <model_id> --json | jq '{aspect_ratios, durations, parameters, medias}'
```

Returns the full schema: aspect ratios (closed enum or open), durations (closed list or `min/max` range), parameters (with descriptions and defaults), and media roles per slot.
