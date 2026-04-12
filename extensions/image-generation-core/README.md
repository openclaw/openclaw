# image-generation-core MVP pixel placeholder

This package now includes a tiny local pixel-art placeholder generator for quick demos and fixtures.

## What it does

- Generates deterministic `image/png` output from a prompt plus optional seed
- Produces simple Stardew-like placeholder scenes such as crops, trees, houses, ponds, and rocks
- Stays fully local, with no model calls or remote services
- Keeps the seam small so richer styles can be added later

## Example command

From repo root:

```bash
node --experimental-strip-types extensions/image-generation-core/generate-pixel-art-placeholder.mjs \
  --prompt "forest tree tile" \
  --seed oak-1 \
  --out tmp/forest-tree.png
```

Expected result:

- Writes a PNG file to `tmp/forest-tree.png`
- Prints JSON metadata including `style`, `biome`, `subject`, and `seed`

## Extension points

The generator lives in `src/pixel-art-placeholder.ts`.

Good next steps if we want to expand it later:

1. Add more styles beyond `stardew-placeholder`
2. Swap keyword heuristics for a tiny scene grammar
3. Wrap it as a first-class local image-generation provider if we want runtime model selection
