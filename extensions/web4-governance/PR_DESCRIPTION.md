# PR: Agent Governance Extension

## The Problem

As agents scale, when something goes wrong:

- "What did it do?" → No audit trail
- "Can we prove the log wasn't tampered with?" → No chain
- "Can we block `rm -rf` before it runs?" → No pre-execution gates

You're flying blind.

## The Solution

Governance extension using your existing `before_tool_call` / `after_tool_call` hooks. Zero core changes.

**What you get:**

- Audit trail with structured records (tool, target, result, timing)
- Hash-linked chain (SHA-256, tamper-evident)
- Policy engine: allow/deny/warn before execution
- CLI: `moltbot audit summary`, `moltbot policy test Bash "rm -rf /"`

**Example policy:**

```json
{
  "rules": [
    {
      "id": "deny-destructive",
      "decision": "deny",
      "match": { "tools": ["Bash"], "targetPatterns": ["rm\\s+-rf"] }
    }
  ]
}
```

## Scope

Makes agents **inspectable, accountable, governable** — not "safe." We can only gate what hooks expose.

## Evidence

- Tier 1 + 1.5 complete (audit + policy)
- Same framework running in Claude Code plugin
- Opt-in, observational by default

---

See [README.md](README.md) for full config. See [ARCHITECTURE.md](ARCHITECTURE.md) for internals.
