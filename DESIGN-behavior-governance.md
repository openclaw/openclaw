# Agent Behavior Governance Policy

## Problem

OpenClaw agents operate with broad autonomy — they read files, call tools, generate content, and interact
with external systems. The existing security model covers _who_ can run an agent (authn/authz) and _what_
skills it can load, but there's no structured way to constrain _how_ an agent behaves during a session.

Common operator needs that aren't addressed today:

- "Never allow the agent to delete files, even if a skill enables it."
- "The agent must always include a disclaimer when discussing financial topics."
- "Validate that all generated code passes `eslint` before it's written to disk."
- "In this environment, the agent should refuse any network tool invocation."

## Solution

A **behavior policy** is a config-driven set of rules applied at two independent enforcement layers:

### Layer 2 — Prompt Injection (guidance)

Rules are rendered as structured XML blocks injected into the system prompt alongside skill contracts.
The model sees these as hard behavioral constraints, phrased as directives rather than suggestions.

Example prompt injection:

```xml
<behavior-policy>
  <enforce>
    <rule id="no-delete">You must never delete files. Refuse any tool call that would delete data.</rule>
    <rule id="disclaimers">Prepend a disclaimer to any output containing financial advice.</rule>
  </enforce>
  <guide>
    <rule id="tone">Prefer concise technical language. Avoid marketing fluff.</rule>
  </guide>
</behavior-policy>
```

### Layer 3 — Output Validation (gate)

After the agent produces a response, `validateBehaviorOutput()` runs built-in heuristics (regex for
disallowed patterns, refusal detection) and optionally an external validator command. If validation
fails, the response can be blocked, flagged, or retried depending on the configured `mode`.

### Configuration

All behavior policy configuration lives under an optional `behaviorPolicy` block in `SecurityConfig`:

```ts
security: {
  behaviorPolicy: {
    rules: [
      { id: "no-delete", description: "Never delete files", layer: "enforce", pattern: "rm|del|unlink" },
      { id: "compliant-code", description: "Generated code must pass lint", layer: "validate", exec: "eslint --stdin" },
    ],
    validation: {
      mode: "block",      // "block" | "flag" | "log"
      retry: true,
    },
    externalExec: {
      timeout: 5000,
      allowedPaths: ["/usr/bin/eslint", "/usr/bin/shellcheck"],
    },
  },
}
```

### Why two layers?

**Prompt injection (Layer 2)** is cooperative — it asks the model to follow rules. This is fast, cheap,
and works for most cases, but is not enforceable.

**Output validation (Layer 3)** is adversarial — it checks what the model actually produced. This catches
violations even when the model ignores prompt directives. The `exec` hook allows operators to plug in
arbitrary validators (linters, policy-as-code engines, custom scripts).

Using both provides defense in depth: guidance prevents most violations, validation catches the rest.

### Security considerations for external exec

- `externalExec` is **opt-in** — no default validator is configured
- `allowedPaths` restricts which executables can be invoked
- `timeout` prevents runaway processes
- Validators receive input via stdin and return a zero/non-zero exit code

### Alternatives considered

1. **Post-hoc audit logging only** — cheaper to implement, but doesn't prevent violations in real time
2. **Proxy/tool interceptor** — more powerful but requires tool-level changes across all skills
3. **Separate policy service** — cleaner separation but adds operational complexity; future work could
   extract the engine into a standalone service

## Files

| File                                   | Role                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| `src/security/behavior-policy.ts`      | Policy engine: resolve, prompt builder, output validation, types |
| `src/security/behavior-policy.test.ts` | 12 unit tests covering all core paths                            |
| `src/config/types.openclaw.ts`         | `behaviorPolicy` block on `SecurityConfig`                       |
| `src/skills/loading/skill-contract.ts` | `formatSkillsForPrompt` accepts optional behavior prompt         |
| `src/skills/loading/session.ts`        | Wrapper passes config through pipeline                           |
| `src/agents/sessions/system-prompt.ts` | Callers pass config                                              |
| `src/skills/loading/workspace.ts`      | Catalog builder includes behavior rules                          |
