# Marketing Studio Modes

Canonical mode values for `marketing_studio_video` `--mode`. Mirrored from the MCP server (`fnf-mcp-server/src/provider/fnf-client/generation/marketing-studio-video.ts`). All slugs below are accepted by the API.

| `--mode` slug | Human-readable label | Best for |
|---|---|---|
| `ugc` | UGC | Default. Casual, organic-feel content from a presenter. |
| `tutorial` | Tutorial | "Here's how to use this." Tutorial / explainer. |
| `ugc_unboxing` | Unboxing | "Just got this in the mail." Unboxing reveal. |
| `hyper_motion` | Hyper Motion | Clean product highlight, polished. |
| `product_review` | Product Review | Presenter giving an opinion on the product. |
| `tv_spot` | TV Spot | Broadcast-style commercial. Higher production. |
| `wild_card` | Wild Card | Experimental, model picks the vibe. |
| `ugc_virtual_try_on` | UGC Virtual Try On | Person trying on clothing/accessories — UGC vibe. |
| `virtual_try_on` | Pro Virtual Try On | Same but more polished, model-driven. |

**Default when the user doesn't specify:** `ugc`.

## Picking flow

- "Looks like a real person filmed on phone" → `ugc` family (`ugc`, `ugc_unboxing`, `ugc_virtual_try_on`, `tutorial`)
- "Polished broadcast commercial" → `tv_spot`
- "Show the product itself, less presenter" → `hyper_motion`
- "Presenter giving an opinion" → `product_review`
- "Try clothing on someone" → `virtual_try_on` (polished) or `ugc_virtual_try_on` (organic feel)
- "Surprise me / something different" → `wild_card`

## Other parameters

For `marketing_studio_video`, the API accepts:

- `aspect_ratio`: `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` (default `16:9`).
- `duration`: integer ≥ 4 seconds. No fixed cap; check `higgsfield model get marketing_studio_video` for the current upper bound.
- `resolution`: `480p` or `720p` (default `720p`).
- `generate_audio`: boolean (default `false`). Generates audio for the video.
- `avatars`: array of `{id, type}` where `type` is `preset` or `custom`. See `marketing-avatars.md`.
- `product_ids`: array of product UUIDs (from `higgsfield marketing-studio products fetch` or `create`). See `marketing-products.md`.
- `medias`: optional reference images with role `image`, `start_image`, or `end_image`.
- `feature: "click_to_ad"`: when generating from a single landing-page URL (Click-to-Ad flow).
- `product: { id?, url? }`: alternative single-product reference; the URL flow auto-fetches.

## URL-driven Click-to-Ad shortcut

For `marketing_studio_video` driven by a product URL (no manual product create / fetch), the MCP-side flow is:

1. Call `higgsfield marketing-studio products fetch --url <url> --wait` (or use `show_marketing_studio` widget action `fetch`).
2. Call `higgsfield generate create marketing_studio_video --url <same url>` — the backend looks up / reuses the entity and submits.

Repeated fetches for the same URL dedupe — the backend reuses any existing non-failed entity.
