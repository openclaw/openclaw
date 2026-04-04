# Wig Forge Asset Library Plan

Last updated: April 4, 2026

This note answers one practical question for `wig-forge`:

Can we build a reusable drop-library foundation for future 2D/3D asset generation?

Yes. We should.

But it needs two separate layers:

- `production library`
  Licensed, editable, remixable building blocks that can safely feed random drop generation.
- `reference library`
  Moodboards, trend references, styling language, and visual tags used for direction only.

Do not mix the two.

## Short answer

We should absolutely build a foundation library for:

- white models / base meshes
- rigs / skeletons
- base garments and accessories
- PBR materials
- brush and alpha packs
- HDRI / backdrop environments
- palette sets
- FX overlays and reveal templates

We should not treat Pinterest or Xiaohongshu as a raw production asset source.

They are useful as:

- taste maps
- silhouette references
- rarity cues
- color trend harvesting
- prompt/tag vocabulary

They are not a clean source of assets to download, mutate, and redistribute in a generative drop pipeline.

## Why we should build a library now

Our current forge loop is capture-first:

`page object -> cutout -> rarity roll -> Veil`

That is the correct first step.

The next step is not full custom 3D generation from scratch for every drop.
The next step is controlled recombination:

- pick a base family
- pick a slot-compatible white model
- pick a rig
- apply one or more materials
- apply trim / brush / FX passes
- choose a backdrop / presentation card
- bind the result to the captured object or silhouette

This gives us:

- stronger visual consistency
- more legible rarity expression
- easier variation at scale
- faster generation than full bespoke modeling
- a clean bridge from 2D cutout rewards to future 3D drops

## Safe source policy

### Production-approved sources

These are good candidates for the editable asset foundation.

1. Poly Haven
   - Official site says assets are `CC0` and usable "for absolutely any purpose without restrictions."
   - It also exposes an API with metadata and download URLs.
   - Best use: materials, HDRIs, some environment models.
   - Sources:
     - [Poly Haven](https://polyhaven.com/)
     - [Poly Haven API](https://polyhaven.com/af/our-api)

2. MakeHuman Community
   - Official FAQ says exported models can be copied, modified, distributed, and used commercially without permission.
   - Best use: white humanoid base meshes and starter body variants.
   - Sources:
     - [MakeHuman FAQ: Can I sell models created with MakeHuman?](https://static.makehumancommunity.org/makehuman/faq/can_i_sell_models_created_with_makehuman.html)
     - [MakeHuman asset packs](https://static.makehumancommunity.org/assets/assetpacks.html)

3. Mixamo
   - Adobe FAQ says characters and animations are royalty free for personal, commercial, and nonprofit projects.
   - Best use: internal rigging / animation stage for humanoid assets.
   - Caution: use as an internal pipeline step, not as a raw downloadable pack we resell as-is.
   - Source:
     - [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)

4. Blender Studio character library
   - Blender Studio generally releases content under `CC-BY`.
   - Best use: curated starter rigs and stylized reference-grade characters.
   - Caution: attribution needs to follow use.
   - Sources:
     - [Blender Studio remixing](https://studio.blender.org/remixing/)
     - [Blender Studio character library post](https://studio.blender.org/blog/new-the-character-library/)

5. Sketchfab Creative Commons downloads
   - Official download guidelines say many models are downloadable under Creative Commons licenses.
   - Best use: manually curated accessories, props, or skeleton references.
   - Caution: attribution must remain visible to end users, and each asset must be checked license-by-license.
   - Source:
     - [Sketchfab Download API Guidelines](https://sketchfab.com/developers/download-api/guidelines)

6. Adobe Substance 3D Assets
   - Adobe says assets can be modified and included in larger works or modified works.
   - Best use: material authoring and texture lookdev.
   - Caution: do not treat downloaded raw assets as our own resellable marketplace stock.
   - Sources:
     - [Substance 3D Assets](https://www.adobe.com/products/substance3d/3d-assets)
     - [Substance 3D Assets product-specific terms](https://www.adobe.com/go/substance3dassets)

### Reference-only sources

These are useful for styling and tagging, not for direct asset ingestion.

1. Pinterest
   - Pinterest developer guidelines explicitly say apps publishing Pinterest content must link back and must not create new distributed content from Pins.
   - This makes it a bad fit as a raw asset source for recomposition.
   - Good use: saved boards, silhouette buckets, trend and palette references.
   - Source:
     - [Pinterest developer guidelines](https://policy.pinterest.com/en/developer-guidelines)

2. Xiaohongshu
   - The official open platform agreement is restrictive around data use, user data scope, and platform use boundaries.
   - I did not find a clean official basis for using it as a production asset ingestion pool.
   - Good use: human-curated reference boards and manually tagged styling inspiration.
   - Source:
     - [小红书开放平台开发者协议](https://s.apifox.cn/apidoc/docs-site/1103512/doc-2811022)

## Recommended library composition

Start with five pack families.

### 1. Base Mesh Packs

Purpose:

- white humanoid bodies
- blob pets
- companion silhouettes
- neutral accessories that can accept materials

Good seed sources:

- MakeHuman exports
- in-house stylized Blender white models

### 2. Rig Packs

Purpose:

- humanoid base rig
- pet quadruped / crawler rig
- floating companion rig
- aura / trailing cloth helper rigs

Good seed sources:

- Mixamo for humanoid compatibility
- Blender Studio rigs for reference
- in-house custom simplified rigs for pet motion

### 3. Material Packs

Purpose:

- metal
- enamel
- soft vinyl
- brushed silk
- velvet
- holographic foil
- pearlescent plastics

Good seed sources:

- Poly Haven
- Substance 3D authoring
- in-house gradient / stylized variants

### 4. Brush and FX Packs

Purpose:

- trim masks
- glitter
- edge wear
- embroidery
- aura streaks
- rarity bloom overlays

Good seed sources:

- in-house brush bundles
- licensed brush packs with compatible terms
- procedurally generated alpha sets

### 5. Backdrop Packs

Purpose:

- reveal cards
- showroom pedestals
- museum-soft HDRIs
- rarity-specific display environments

Good seed sources:

- Poly Haven HDRIs
- in-house poster backdrops

## What should never enter the production library

- Pinterest images downloaded as if they were textures
- Xiaohongshu post images used as remixable asset parts
- unclear-license 3D downloads
- raw user-generated assets without attribution metadata
- brand logos or trademark-heavy fashion items unless separately licensed

## Ingestion rules

Every production asset should carry this metadata:

- source URL
- source platform
- license type
- attribution requirement
- commercial use status
- editable status
- redistribution risk
- slot compatibility
- rig compatibility
- tags
- local checksum / fingerprint

If any of the first five are unknown, the asset stays out of the production pool.

## Proposed pipeline

1. Human curator adds or imports a candidate asset.
2. Asset gets classified as `production` or `reference`.
3. License metadata is recorded.
4. Asset is normalized:
   - mesh scale
   - axis convention
   - texture naming
   - rig validation
   - thumbnail generation
5. Asset is tagged by:
   - slot
   - rarity family
   - silhouette family
   - style family
6. The forge uses the library to synthesize variants.

## How this plugs into wig-forge

Near term:

- continue capture-first 2D forging
- use the library for reveal backgrounds, materials, trims, and companion silhouettes

Mid term:

- add a `white model + rig + material + trim` synthesis path
- use capture results as prompts, masks, decals, or texture references

Long term:

- full 3D wearable assembly
- pet companion generation
- social showroom rendering
- market-ready derived asset bundles

## Recommendation

Build the library now, but build it as:

- a lawful production library
- a separate inspiration/reference library
- a manifest-driven asset system with provenance metadata

Do not build the production pipeline on scraped Pinterest or Xiaohongshu imagery.
