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

Output of this step: `openclaw-polytropos` `main` (or a release branch) contains upstream `<upstreamTag>` plus fork commits.

### 3) Tag the fork release

Create a fork tag that is explicitly tied to the upstream tag (naming convention TBD, but must include the upstream version).

Examples:

- `2026.4.1-poly.0`
- `2026.4.1-poly.1`

### 4) Build (produce dist/)

Build is the act of producing a `dist/` directory from the core repo at a specific ref/tag.

Canonical build sequence (deterministic):

- `pnpm install`
- `pnpm ui:build`
- `pnpm build`

Output: `<repo>/dist/`.

### 5) Release (create/switch runnable release directory)

Release is the act of taking a built `dist/` and creating a runnable versioned directory under `~/polytropos/releases/<forkTag>/` (and optionally switching `current`).

Follow [`docs/polytropos/CORE-RELEASES.md`](../CORE-RELEASES.md) to:

- copy `<repo>/dist/` into `~/polytropos/releases/<forkTag>/`
- update `previous` then `current`
- restart gateway
- verify

## Notes

- Updates are infrequent and should be deliberate.
- Releases may be more frequent (e.g. multiple `-poly.N` tags) even when upstream doesn’t move.
