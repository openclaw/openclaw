---
summary: "Pluggable pre-tool-call authorization via GuardrailProvider"
read_when:
  - Adding policy-based tool authorization
  - Configuring AllowlistProvider or external guardrail providers
  - Writing a custom GuardrailProvider
title: "Guardrails"
---

# Guardrails

> **Context:** [Issue #46441](https://github.com/openclaw/openclaw/issues/46441) — OpenClaw has exec approvals for shell commands, but no general-purpose authorization for other tools — file writes, browser actions, messaging, MCP tools, git operations. Guardrails add a core service that evaluates every tool call against a policy **before** execution.

## Why guardrails

```
Without guardrails:                      With guardrails:

  Agent                                    Agent
    │                                        │
    ▼                                        ▼
  ┌──────────┐                             ┌──────────┐
  │ exec     │──▶ executes immediately     │ exec     │──▶ GuardrailService
  │ rm -rf / │                             │ rm -rf / │        │
  └──────────┘                             └──────────┘        ▼
                                                         ┌──────────────┐
                                                         │  Provider    │
                                                         │  evaluates   │
                                                         │  against     │
                                                         │  policy      │
                                                         └──────┬───────┘
                                                                │
                                                          ┌─────┴─────┐
                                                          │           │
                                                        ALLOW       DENY
                                                          │           │
                                                          ▼           ▼
                                                      Tool runs   Agent sees:
                                                      normally    "Guardrail denied:
                                                                   rm -rf blocked"
```

- **Exec approvals** require a human in the loop and only cover shell commands.
- **Guardrails** provide deterministic, policy-driven authorization for **any tool**, without human intervention.

## Architecture

```
                  ┌──────────────────────────────┐
                  │     before_tool_call flow     │
                  │                               │
                  │  1. Loop detection             │
                  │  2. GuardrailService ◄── NEW  │
                  │  3. Plugin hooks               │
                  └──────────────┬────────────────┘
                                 │
                   ┌─────────────┴──────────────┐
                   │    GuardrailProvider        │  ◄── pluggable: any class
                   │    (configured in YAML)     │      with evaluate()
                   └─────────────┬──────────────┘
                                 │
                       ┌─────────┼──────────┐
                       │         │          │
                       ▼         ▼          ▼
                  Built-in    External    Custom
                  Allowlist   Provider   Provider
                  (zero dep)  (npm/file) (your code)
```

The `GuardrailService` is a core service (not a plugin). It runs **before** plugin `before_tool_call` hooks, ensuring guardrails cannot be bypassed by disabling a plugin.

Zero impact when not configured — the service is only initialized when `guardrails.enabled: true`.

## What ships in core

OpenClaw intentionally keeps the core layer neutral:

- Core ships the `GuardrailProvider` interface and a minimal built-in `AllowlistProvider`
- Vendor-specific policy engines stay outside core and plug in through the same interface
- That keeps the contract open to OAP providers such as APort, adapter-based integrations such as Microsoft Agent Governance Toolkit, and any custom provider teams want to build

## Three provider options

### Option 1: Built-in AllowlistProvider (zero dependencies)

The simplest option. Ships with OpenClaw. Block or allow tools by name.

This is the **only** provider built into OpenClaw core. It is intentionally small and dependency-free. Everything more opinionated plugs in through `GuardrailProvider`.

**config.yaml:**

```yaml
guardrails:
  enabled: true
  provider:
    use: "builtin:allowlist"
    config:
      deniedTools:
        - "exec"
        - "browser"
```

You can also use an allowlist (only these tools are permitted):

```yaml
guardrails:
  enabled: true
  provider:
    use: "builtin:allowlist"
    config:
      allowedTools:
        - "write"
        - "read"
        - "glob"
```

**Try it:**

1. Add the `deniedTools` config above to your `config.yaml`
2. Start OpenClaw
3. Ask the agent: "Run echo hello using exec"
4. The agent sees: `Guardrail (allowlist): 'exec' is in the denied list`

### Option 2: OAP passport providers (policy-based)

For policy enforcement based on the [Open Agent Passport (OAP)](https://github.com/aporthq/aport-spec) open standard. An OAP passport is a JSON document that declares an agent's identity, capabilities, and operational limits. Any provider that reads an OAP passport and returns OAP-compliant decisions works with OpenClaw.

```
┌─────────────────────────────────────────────────────────────┐
│                    OAP Passport (JSON)                       │
│                  (open standard, any provider)               │
│  {                                                           │
│    "spec_version": "oap/1.0",                                │
│    "status": "active",                                       │
│    "capabilities": [                                         │
│      {"id": "system.command.execute"},                       │
│      {"id": "data.file.read"},                               │
│      {"id": "data.file.write"},                              │
│      {"id": "web.fetch"}                                     │
│    ],                                                        │
│    "limits": {                                               │
│      "system.command.execute": {                             │
│        "allowed_commands": ["git", "npm", "node"],           │
│        "blocked_patterns": ["rm -rf", "sudo", "chmod 777"]  │
│      }                                                       │
│    }                                                         │
│  }                                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
               Any OAP-compliant provider
          ┌────────────────┼────────────────┐
          │                │                │
     Your own         APort (ref.      Other future
     evaluator        implementation)  implementations
```

**Creating a passport manually:**

An OAP passport is a JSON file. Create one following the [OAP specification](https://github.com/aporthq/aport-spec/blob/main/oap/oap-spec.md) and validate against the [JSON schema](https://github.com/aporthq/aport-spec/blob/main/oap/passport-schema.json). See the [examples](https://github.com/aporthq/aport-spec/tree/main/oap/examples) for templates.

**Example: APort Agent Guardrails (direct provider, recommended reference implementation):**

[APort Agent Guardrails](https://github.com/aporthq/aport-agent-guardrails) is an open-source (Apache 2.0) OAP implementation. Its repo supports both a direct provider path (`OAPGuardrailProvider` from `@aporthq/aport-agent-guardrails-core`) and an older OpenClaw plugin/setup flow. For OpenClaw's native `guardrails:` interface, the direct provider path is the cleaner fit.

```bash
npm install @aporthq/aport-agent-guardrails-core
npx @aporthq/aport-agent-guardrails
```

The first command installs the provider. The second runs the passport wizard — it creates a local passport file with your agent's capabilities and limits.

**config.yaml:**

```yaml
guardrails:
  enabled: true
  provider:
    use: "@aporthq/aport-agent-guardrails-core"
    config:
      framework: "openclaw"
```

This is the most direct OpenClaw integration path today, and the reference OAP example for this interface:

- The provider plugs into `guardrails.provider.use` with no adapter code
- The wizard creates a local OAP passport for offline evaluation
- The same package also supports hosted passports and centralized audit flows when you provide the environment variables it documents (`APORT_AGENT_ID`, optional `APORT_API_URL`, and `APORT_API_KEY` if required)
- The repo still includes an OpenClaw plugin path for legacy deployments, but native `guardrails:` config is the preferred match for this interface

**Hosted passport mode (optional):**

```bash
APORT_AGENT_ID=agent_123 \
APORT_API_KEY=... \
openclaw
```

**Using your own OAP provider:**

```yaml
guardrails:
  enabled: true
  provider:
    use: "./my-oap-provider.js"
    config:
      passportPath: "./my-passport.json"
```

Any provider that implements `GuardrailProvider` and reads OAP passports works. The standard defines the passport format and decision codes; OpenClaw doesn't care which provider reads them.

**What the passport controls:**

| Passport field              | What it does                            | Example                                     |
| --------------------------- | --------------------------------------- | ------------------------------------------- |
| `capabilities[].id`         | Which tool categories the agent can use | `system.command.execute`, `data.file.write` |
| `limits.*.allowed_commands` | Which commands are allowed              | `["git", "npm", "node"]` or `["*"]` for all |
| `limits.*.blocked_patterns` | Patterns always denied                  | `["rm -rf", "sudo", "chmod 777"]`           |
| `status`                    | Kill switch                             | `active`, `suspended`, `revoked`            |

**Try it:**

1. `npm install @aporthq/aport-agent-guardrails-core`
2. `npx @aporthq/aport-agent-guardrails` — create a passport
3. Add the OpenClaw config above to `config.yaml`
4. Start OpenClaw and ask: "Run rm -rf / using exec"
5. The provider blocks it: `oap.blocked_pattern: Command contains blocked pattern: rm -rf`

### Option 3: Custom providers and adapters

Any class with a `name` property and an `evaluate()` method works.
The runtime uses structural typing here, so your provider does not need to import a special OpenClaw base class.

```typescript
// my-guardrail.ts
type GuardrailRequest = {
  toolName: string;
  toolInput: Record<string, unknown>;
};

type GuardrailDecision = {
  allow: boolean;
  reasons?: Array<{ code: string; message?: string }>;
};

export default class MyProvider {
  name = "my-company";

  constructor(private config: Record<string, unknown>) {}

  async evaluate(request: GuardrailRequest): Promise<GuardrailDecision> {
    if (request.toolName === "exec" && String(request.toolInput.command).includes("delete")) {
      return {
        allow: false,
        reasons: [{ code: "custom.blocked", message: "delete not allowed" }],
      };
    }
    return { allow: true, reasons: [{ code: "allowed" }] };
  }
}
```

**config.yaml:**

```yaml
guardrails:
  enabled: true
  provider:
    use: "./my-guardrail.js"
```

**Try it:**

1. Create `my-guardrail.ts` and compile to `.js`
2. Add the config above
3. Start OpenClaw and ask: "Use exec to delete test.txt"
4. Your provider blocks it

**Example: Microsoft Agent Governance Toolkit adapter**

[Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) is broader runtime governance infrastructure, not a native OpenClaw `GuardrailProvider` package. The repo exposes in-process building blocks such as the TypeScript `@agentmesh/sdk` package (`PolicyEngine`, `AgentMeshClient`) and also documents an OpenClaw sidecar deployment for AKS.

For OpenClaw's `guardrails:` interface, the closest fit is a thin adapter that implements `GuardrailProvider` and delegates to the toolkit's policy engine. The sidecar path is a separate deployment pattern for infrastructure-level governance outside the OpenClaw process.

This is included here as an interoperability example: OpenClaw exposes a neutral provider seam, so teams can use Microsoft tooling alongside OAP providers or their own internal policy runtimes.

The toolkit's TypeScript package is `@agentmesh/sdk`, and its README shows a `PolicyEngine` evaluating actions such as `web_search` and `shell_exec`. In OpenClaw, map those actions to OpenClaw tool names such as `exec`, `read`, `write`, `browser`, or `mcp.*`.

```typescript
// microsoft-agentmesh-adapter.ts
import { PolicyEngine } from "@agentmesh/sdk";

type GuardrailRequest = {
  toolName: string;
};

type GuardrailDecision = {
  allow: boolean;
  reasons?: Array<{ code: string; message?: string }>;
};

type Rule = { action: string; effect: "allow" | "deny" };

export default class MicrosoftAgentMeshAdapter {
  name = "microsoft-agentmesh";
  private engine: PolicyEngine;

  constructor(config: { rules?: Rule[] } = {}) {
    this.engine = new PolicyEngine(
      config.rules ?? [
        { action: "read", effect: "allow" },
        { action: "write", effect: "allow" },
        { action: "exec", effect: "deny" },
      ],
    );
  }

  async evaluate(request: GuardrailRequest): Promise<GuardrailDecision> {
    const effect = this.engine.evaluate(request.toolName);
    if (effect === "deny") {
      return {
        allow: false,
        reasons: [
          { code: "policy_violation", message: `${request.toolName} denied by Microsoft policy` },
        ],
      };
    }
    return { allow: true, reasons: [{ code: "allowed" }] };
  }
}
```

**config.yaml:**

```yaml
guardrails:
  enabled: true
  provider:
    use: "./microsoft-agentmesh-adapter.js"
    config:
      rules:
        - action: "read"
          effect: "allow"
        - action: "write"
          effect: "allow"
        - action: "exec"
          effect: "deny"
```

If you want richer policy semantics, keep the same adapter shell and swap the internals to the toolkit's other policy backends such as OPA/Rego or Cedar.
If you want the toolkit's broader trust and audit surface, adapt `AgentMeshClient.executeWithGovernance()` instead of `PolicyEngine` directly. If you want infrastructure-level governance around a containerized OpenClaw deployment, use the toolkit's documented OpenClaw sidecar; that is complementary to, not the same thing as, OpenClaw's in-process `GuardrailProvider` seam.

## Configuration reference

```yaml
guardrails:
  # Enable guardrail evaluation. Default: false.
  # Zero impact when false — no service initialized, no overhead.
  enabled: true

  # Block tool calls when the provider throws an error. Default: true.
  failClosed: true

  provider:
    # Module specifier. Required when enabled is true.
    # Supported forms:
    #   "builtin:allowlist"      — built-in AllowlistProvider
    #   "@scope/package"         — npm package
    #   "./path/to/provider.js"  — local file
    use: "builtin:allowlist"

    # Provider-specific configuration (passed to constructor).
    config:
      deniedTools: ["exec"]
```

## OpenClaw tool names

These are the tool names your provider will see in `request.toolName`:

| Tool      | What it does                          |
| --------- | ------------------------------------- |
| `exec`    | Shell command execution               |
| `write`   | Create/overwrite a file               |
| `read`    | Read file content                     |
| `edit`    | Edit a file                           |
| `glob`    | List files by pattern                 |
| `grep`    | Search file contents                  |
| `browser` | Web browser interaction               |
| `mcp.*`   | MCP tool calls (prefixed with `mcp.`) |

## Fail-closed vs fail-open

| `failClosed`     | Provider error behavior                                            |
| ---------------- | ------------------------------------------------------------------ |
| `true` (default) | Tool call is **blocked**. Safer for security-critical deployments. |
| `false`          | Tool call is **allowed**. Use when guardrails are advisory.        |

## Reason codes

Providers should use descriptive reason codes. Suggested patterns:

| Code               | Meaning                                |
| ------------------ | -------------------------------------- |
| `allowed`          | Tool call permitted                    |
| `tool_not_allowed` | Tool not in allowlist                  |
| `tool_denied`      | Tool explicitly denied                 |
| `policy_violation` | Provider-specific policy check failed  |
| `evaluator_error`  | Provider encountered an internal error |

## Relationship to exec approvals

Guardrails and exec approvals are complementary:

- **Exec approvals** — human-in-the-loop confirmation for shell commands (interactive)
- **Guardrails** — automated policy evaluation for any tool (programmatic)

Guardrails run first. If a guardrail denies a tool call, exec approvals are never reached.

## Relationship to plugins

Plugins can register `before_tool_call` hooks for their own authorization logic. The guardrail service runs before all plugin hooks, providing a baseline policy layer that plugins cannot override.

Existing plugin-based guardrails continue to work unchanged. The `GuardrailProvider` interface gives those same capabilities a standard contract and first-class config support.
