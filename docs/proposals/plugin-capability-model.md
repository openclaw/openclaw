# [RFC] Plugin Capability Model and Budget Enforcement

## Problem

All OpenClaw plugins run in a single Node.js process with full access to the trusted `PluginRuntime` surface ([#12517](https://github.com/openclaw/openclaw/issues/12517), CVSS 9.8). A compromised or malicious plugin can:

- Read other plugins' credentials via `runtime.modelAuth`
- Write config files via `runtime.config.writeConfigFile`
- Execute arbitrary commands via `runtime.system.runCommandWithTimeout`
- Access the full agent session store
- Register HTTP routes, gateway methods, and hooks without restriction

The existing `plugins.allow` allowlist controls which plugins _load_, but provides no runtime isolation once loaded.

## Proposal: Capability Declarations + Runtime Enforcement

### Phase 1: Capability Declarations (this RFC)

Extend `openclaw.plugin.json` manifest with a `capabilities` field:

```json
{
  "id": "my-plugin",
  "capabilities": {
    "tools": ["my_custom_tool"],
    "hooks": ["message:received", "message:sent"],
    "httpRoutes": true,
    "gatewayMethods": ["myPlugin.status"],
    "runtime": {
      "config.read": true,
      "config.write": false,
      "system.exec": false,
      "modelAuth": ["openai"],
      "subagent": true,
      "media": false,
      "state": true
    }
  }
}
```

**Design principles:**

- Declarative, not imperative — capabilities are stated in the manifest
- Deny by default — undeclared capabilities are denied
- Backward compatible — plugins without `capabilities` run with full access (legacy mode)
- Audit-visible — `openclaw security audit` reports plugins running in legacy (unrestricted) mode

### Phase 2: Runtime Enforcement (future PR)

Wrap `PluginRuntime` in a `Proxy` that checks declared capabilities at call time:

```typescript
function createCapabilityBoundRuntime(
  runtime: PluginRuntime,
  capabilities: PluginCapabilities,
): PluginRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === "config" && !capabilities.runtime?.["config.read"]) {
        return createDeniedProxy("config");
      }
      // ... gate each runtime surface
    },
  });
}
```

### Phase 3: Budget Enforcement (future)

Inspired by EVM gas limits:

- Per-plugin rate limiting on `subagent.run` calls
- Per-plugin token budget caps
- Budget configuration in `plugins.budgets` config section
- Audit findings for budget overruns

### Phase 4: Audit Trail (future)

- Log all plugin API calls with tamper-evident chaining (inspired by blockchain execution receipts)
- Queryable via `openclaw security audit --plugins`

## Architectural Fit

The existing `PluginManifest.contracts` field declares tool names and provider IDs for discovery. The proposed `capabilities` field extends this pattern to runtime permissions. The enforcement layer intercepts at the `createApi` boundary in `src/plugins/registry.ts` where `PluginRuntime` is already wrapped per-plugin.

## Backward Compatibility

- Plugins without `capabilities` field → full access (legacy mode)
- Plugins with `capabilities` field → enforce declared boundaries
- New audit finding: `plugins.capabilities.legacy_unrestricted` (warn) for plugins without declarations
- New audit finding: `plugins.capabilities.undeclared_access` (critical) when enforcement detects an undeclared access attempt

## Implementation Plan

1. **PR 1 (this scope):** Add `capabilities` to `PluginManifest` type + validation schema. Add audit findings for plugins in legacy mode.
2. **PR 2:** Runtime enforcement via Proxy wrapping in `registry.ts`.
3. **PR 3:** Budget enforcement + rate limiting.
4. **PR 4:** Audit trail with chain-hashed logs.

## Design References

- **SmartAgentKit** (ERC-7579): Module-level capability hooks that enforce declared permissions at execution time
- **IRSB** (EIP-7702): Whitelist/blacklist enforcer pattern for transaction guardrails
- **ai-democratic-constitution**: Optimistic execution with revocation — agents can use capabilities until flagged
- **Android Manifest permissions**: Declarative permission model that gates API access

## Scope of This RFC

This RFC covers **Phase 1 only**: capability declarations in manifests + audit findings. Enforcement (Phase 2+) will be separate PRs after community feedback on the declaration schema.

---

cc @vincentkoc @joshavant @rwaslander (Security maintainers per CONTRIBUTING.md)
