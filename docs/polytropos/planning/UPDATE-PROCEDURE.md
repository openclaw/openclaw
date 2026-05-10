# Polytropos Core Update Procedure (Upstream → Fork)

**Definition:** An **update** means merging in a newer upstream OpenClaw release tag into `openclaw-polytropos`, then performing the standard **release** procedure.

See also:

- Release mechanism: `docs/polytropos/CORE-RELEASES.md`

## Inputs

- Upstream OpenClaw tag: `<upstreamTag>` (example: `2026.4.1`)

## Procedure

### 1) Sync upstream

- Fetch upstream tags.
- Identify the upstream tag to update to.

### 2) Integrate upstream tag into the fork

Preferred: merge or rebase the fork onto the upstream tag (choose one strategy and keep it consistent).

Output of this step: `openclaw-polytropos` `main` (or a release branch) contains upstream `<upstreamTag>` plus fork commits.

### 3) Tag the fork release

Create a fork tag that is explicitly tied to the upstream tag (naming convention TBD, but must include the upstream version).

Examples:

- `2026.4.1-poly.0`
- `2026.4.1-poly.1`

### 4) Run the standard release procedure

Follow `docs/polytropos/CORE-RELEASES.md` to:

- build `dist/`
- copy `dist/` into `~/polytropos/releases/<forkTag>/`
- update `previous` then `current`
- restart gateway
- verify

## Notes

- Updates are infrequent and should be deliberate.
- Releases may be more frequent (e.g. multiple `-poly.N` tags) even when upstream doesn’t move.
