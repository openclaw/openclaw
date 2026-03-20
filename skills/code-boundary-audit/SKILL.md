---
name: code-boundary-audit
description: AST-based cross-file boundary audit for critical variable propagation and isolation-policy consistency. Use when reviewing security-sensitive refactors, validating that identifiers such as agentId/tenantId/userId/orgId/sessionId are threaded through policy -> API -> service -> runtime -> sandbox -> export boundaries, or before merging PRs that change permission, policy, or context assembly paths.
---

# Code Boundary Audit

## Overview

Audit code as a boundary system, not as isolated files. Trace one critical variable from policy decision points to physical/output sinks and detect dropped parameters, alias bypasses, and inconsistent filtering.

Use this skill to prove structural propagation contracts at callsites before relying on runtime tests alone.

## Quick Start

1. Discover all callsites for a boundary function.

```bash
node skills/code-boundary-audit/scripts/boundary-audit.mjs callers \
  --symbol syncSkillsToWorkspace \
  --root src
```

2. Run contract checks.

```bash
node skills/code-boundary-audit/scripts/boundary-audit.mjs contracts \
  --config skills/code-boundary-audit/references/contract-template.json \
  --root src
```

3. Replace starter contracts with boundary-specific rules before sign-off.

## Workflow

1. Define the boundary chain.

- Write expected order, for example: `policy -> runtime context -> sandbox sync -> export/context`.
- Pick one `critical_var` (for example `agentId`, `tenantId`, `orgId`, `userId`, `sessionId`).

2. Enumerate sinks and gateways.

- List sink functions that materialize state or expose output (filesystem sync, exports, context snapshots, network responses).
- List gateway functions that must carry `critical_var` into those sinks.

3. Discover call graph slices.

- Run `callers` mode for each sink/gateway target.
- Use results to identify where contracts must be enforced.

4. Encode boundary contracts.

- Add one contract per sink or gateway target.
- Require object-argument keys that carry policy scope.
- Add value source token checks to reject wrong wiring.

5. Execute contract checks.

- Run `contracts` mode over the selected source root.
- Treat `ERROR` as hard failure.
- Treat `WARN` as manual review required (usually object spread uncertainty).

6. Publish a boundary-audit report.

- Include `critical_var`, contract IDs, failing callsites, and fix directions.
- State residual uncertainty explicitly.

## Contract File Format

Use JSON:

```json
{
  "contracts": [
    {
      "id": "sandbox-sync-carries-agent-id",
      "target": "syncSkillsToWorkspace",
      "argumentIndex": 0,
      "requiredKeys": ["agentId"],
      "valueMustContain": {
        "agentId": ["agentId", "sessionAgentId", "runtime.agentId"]
      },
      "includePathRegex": ["^agents/"],
      "excludePathRegex": ["\\.test\\."],
      "strictSpread": false
    }
  ]
}
```

Rule semantics:

- `target`: Callee identifier or property name to match.
- `argumentIndex`: Which argument must be an object literal.
- `requiredKeys`: Keys that must exist on that object.
- `valueMustContain`: Per-key substring allowlist for value expression text.
- `includePathRegex` / `excludePathRegex`: Path filters over repo-relative paths (relative to `--root`).
- `strictSpread`: When `true`, missing explicit keys are errors even if object spread exists.

## Output Interpretation

- `ERROR`: Boundary contract violation at a concrete callsite.
- `WARN`: Possible violation hidden by object spread; inspect manually.

Use this reporting shape:

- `Boundary`: `<critical_var>`
- `Contract`: `<id>`
- `Finding`: `<ERROR|WARN>`
- `Callsite`: `<path:line>`
- `Reason`: `<missing key | wrong value source | non-object argument>`
- `Fix`: `<what to pass and from where>`

## References

- Generic starter contracts: `references/contract-template.json`
- Real case study from PR #50882:
  - `references/openclaw-pr-50882-example.contracts.json`
  - `references/openclaw-pr-50882-notes.md`
