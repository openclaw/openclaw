# Project Plan: Neo Pixel Art Animation Integration

## Objective

Convert the current static PNG model of 'Neo' in the `ui-next` Matrix visualization canvas into a fully functional, animated Character instance that moves seamlessly across the grid, respects depth-sorting, and retains the specialized sizing and transparency rules, eventually setting the foundational stage to port Trinity and Morpheus.

## Background Context

Currently, Neo is imported directly as a large, static, hard-coded image via `createMaskedCharacter()` and pasted using a flat render call (`drawHero()`) over the canvas at a strict X/Y position (`col: 13, row: 8`). He does not have animations, pathfinding, or proper Z-sorting (depth-sorting rendering order relative to other agents or furniture). The native engine dynamically maps animated generic office agents on a grid via `Character` models, executing an `updateCharacter()` state-machine and utilizing `SpriteData` mapped out per-directional frame.

## Breakdown & Milestones

### Phase 1: Setup & Initial Prep

- [ ] Review current character data arrays matching `SpriteData` implementations in `sprite-data.ts`.
- [ ] Evaluate the existing `matrix_neo.png` static image and plan how to synthesize/parse directional sprite frames.
  - _Note: Typically require 4 directional arrays consisting of 3-4 Walk cycle snapshots each (Left, Right, Up, Down), plus type/reading idle poses if applicable._
- [ ] Convert `matrix_neo.png` image data dynamically into the standardized `LoadedCharacterData[]` array formatting used by `.setCharacterTemplates()` — OR structure a lightweight custom override if `setCharacterTemplates` interacts purely with normal small generic palettes.

### Phase 2: Building Neo's Sprite Adapter Mechanism

- [ ] Add parsing logic to `sprite-data.ts` (or `pixel-engine/engine/characters.ts`) to manage our massive scaled PNG hero sprites properly.
- [ ] Write logic that essentially cuts out 8-12 distinct frames from a sprite sheet. If a Neo sprite sheet doesn't exist, build/extrapolate a temporary 16-bit array grid template explicitly shaped for Neo for testing.
  - _Dependencies:_ Need to generate an actual Neo 4-pack walk cycle sheet.
- [ ] Update `getCharacterSprites` within `/lib/pixel-engine/sprites/sprite-data.ts` to seamlessly intercept and retrieve Matrix Hero sprites based on a specific `paletteIndex` flag (e.g., ID >= 100 maps to Matrix custom models).

### Phase 3: Spawning Neo as a Native `Character` Entity

- [ ] Alter the character bootstrapping process `createCharacter()` so we can specifically inject Neo directly into "The Matrix" core zone (`col:13, row:8`).
- [ ] Ensure Neo registers accurately within the generic world tick systems:
  - Movement pathfinding array mapping.
  - Z-Sorting collision (`charZY`).
  - Native `TileSize` mapping.

### Phase 4: Sizing & Adjustments

- [ ] Modify `renderer.ts`.
- [ ] Remove hardcoded `drawHero()` for Neo in the `renderScene` and orchestrator functions. Keep Morpheus and Trinity as-is for now to test stability.
- [ ] Enforce the `2.5 * TILE_SIZE * zoom` up-scaling explicitly on the newly animated Neo character within the native `updateCharacter / renderer.ts` loop without ruining small generic agents.
- [ ] Fix matrix alpha channel masking over the newly animated layout if background ghosting persists.

### Phase 5: Verification & Cleanup

- [ ] Run dev server testing to confirm Neo wanders appropriately around The Matrix Core zone.
- [ ] Confirm proper character occlusion/Z-Sorting (Neo walking behind Morpheus, or desks).
- [ ] Mark off Neo as complete and set template for Morpheus & Trinity application next.
