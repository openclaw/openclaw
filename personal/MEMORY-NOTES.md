# Memory Architecture Notes

OpenClaw memory is separated into different tiers.

## Tiers and Layering

1. **Curated Core (Compaction)**:
   - `MEMORY.md` and `USER.md`
   - These are compacted, small files injected into the bootstrap context.
   - Handled via background consolidation (dreaming).

2. **Episodic (Archival)**:
   - `memory/YYYY-MM-DD.md`
   - Large daily notes and observations.
   - Retrieved via Active Memory search, NOT loaded at session start.

## Compression

To reduce the disk footprint (Brotli is for disk footprint, not token usage!), the episodic daily notes in `memory/` can be periodically archived and compressed using `brotli`. A compression script is provided at `personal/scripts/memory-compress.sh`.
