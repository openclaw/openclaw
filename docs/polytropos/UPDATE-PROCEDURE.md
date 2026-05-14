# Polytropos Core Update Procedure (Upstream → Fork)

**Definition:** An **update** means merging in a newer upstream OpenClaw release tag into `openclaw-polytropos`, then performing the standard **release** procedure.

See also:

- Release mechanism: [`docs/polytropos/CORE-RELEASES.md`](./CORE-RELEASES.md)

## Inputs

- Upstream OpenClaw tag: `<upstreamTag>` (example: `v2026.5.10`)

## Procedure

### 1) Sync upstream

- Fetch upstream tags.
- Identify the upstream tag to update to.

### 2) Integrate upstream tag into the fork

Always integrate upstream via a **recursive merge** (no rebases).

**Requirement:** the merge must complete successfully and leave the repo in a clean state (no conflicts, no half-merged index).

Output of this step: `openclaw-polytropos` `main` contains upstream `<upstreamTag>` plus fork commits.

### 3) Release

After the merge is successfully completed, run the standard release script (this stages the new code by tagging, building prepared artifacts, producing a `.tgz` via `npm pack`, updating `current.tgz`/`previous.tgz`, installing globally, and running the bundled deps helper):

- [`docs/polytropos/CORE-RELEASES.md`](./CORE-RELEASES.md)

Then activate the staged release by restarting the gateway (separate step):

```bash
systemctl --user restart openclaw-gateway
```

## Notes

- Updates are infrequent and should be deliberate.
- Releases may be more frequent (e.g. multiple `-poly.N` tags) even when upstream doesn’t move.
