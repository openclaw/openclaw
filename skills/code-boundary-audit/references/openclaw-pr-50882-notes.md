# OpenClaw PR #50882 Boundary Audit Notes

## Problem Pattern

- Policy isolation existed at one layer (`skills.policy`) but was not consistently propagated to physical and export boundaries.
- Critical variable: `agentId`.
- Typical failure mode: callers omitted `agentId` while invoking sink/gateway functions, causing policy bypass in sandbox sync or context/export views.

## Audit Focus

- `syncSkillsToWorkspace(...)` callsites in sandbox setup paths.
- `buildWorkspaceSkillSnapshot(...)` callsites in `/context` and export system-prompt paths.
- Value source quality: prefer `sessionAgentId` or runtime-resolved agent scope over raw unscoped IDs.

## Example Commands

```bash
node skills/code-boundary-audit/scripts/boundary-audit.mjs callers \
  --symbol syncSkillsToWorkspace \
  --root src
```

```bash
node skills/code-boundary-audit/scripts/boundary-audit.mjs contracts \
  --config skills/code-boundary-audit/references/openclaw-pr-50882-example.contracts.json \
  --root src
```

## Interpretation

- A failure means boundary parameters are missing, weakly sourced, or hidden by non-literal call arguments.
- A pass does not replace runtime tests; it proves structural propagation contracts at callsites.
