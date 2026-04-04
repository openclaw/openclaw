# Wig Forge Asset Library

This folder is the starter skeleton for the future `wig-forge` drop library.

It is designed for two different asset classes:

- `production`
  Safe, licensed building blocks used in runtime generation and remixing.
- `reference`
  Moodboards, inspiration boards, palette captures, silhouette notes, and prompt tags.

Do not place direct platform-sourced inspiration images into `production`.

## Structure

```text
asset-library/
  library.manifest.json
  pack.schema.json
  packs/
    core-foundation/
      pack.json
```

## Pack categories

Each asset pack can expose any combination of:

- `base_mesh`
- `rig`
- `material`
- `brush`
- `backdrop`
- `fx`
- `palette`
- `reference_board`

## Pack roles

- `production`
  Used by synthesis, random drop generation, reveal rendering, or future 3D assembly.
- `reference`
  Used by curators, prompting, and tagging only.

## Metadata rules

Every imported item should eventually carry:

- `id`
- `title`
- `kind`
- `license`
- `license_url`
- `source_url`
- `commercial_use`
- `attribution_required`
- `editable`
- `redistribution`
- `slot_tags`
- `style_tags`
- `rarity_bias`
- `files`

## Initial recommendation

The first production packs should be:

1. white-model / base mesh pack
2. humanoid rig pack
3. pet / companion rig pack
4. starter material pack
5. reveal backdrop pack
6. rarity FX pack

The first reference packs should be:

1. silhouette board
2. palette board
3. rarity moodboard
4. accessory trend board
