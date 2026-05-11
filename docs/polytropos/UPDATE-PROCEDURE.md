# Polytropos Core Update Procedure (Upstream → Fork)

**Definition:** An **update** means merging in a newer upstream OpenClaw release tag into `openclaw-polytropos`, then performing the standard **release** procedure.

See also:

- Release mechanism: [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md)

## Inputs

- Upstream OpenClaw tag: `<upstreamTag>` (example: `2026.4.1`)

## Procedure

### 1) Sync upstream

- Fetch upstream tags.
- Identify the upstream tag to update to.

### 2) Integrate upstream tag into the fork

Always integrate upstream via a **recursive merge** (no rebases).

**Requirement:** the merge must complete successfully and leave the repo in a clean state (no conflicts, no half-merged index).

Output of this step: `openclaw-polytropos` `main` contains upstream `<upstreamTag>` plus fork commits.

### 3) Release

After the merge is successfully completed, run the standard release script/procedure (this step includes tagging, building, publishing, switching `previous/current`, restarting, and verification):

- [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md)

## Notes

- Updates are infrequent and should be deliberate.
- Releases may be more frequent (e.g. multiple `-poly.N` tags) even when upstream doesn’t move.
