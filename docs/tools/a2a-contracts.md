---
summary: "Typed message contracts for structured agent-to-agent communication"
read_when:
  - Setting up structured messaging between agents
  - Declaring input/output schemas for cross-agent requests
  - Validating A2A message payloads before delivery
  - Requiring agents to use formal contracts instead of free-form text
title: "A2A Contracts"
---

# A2A contracts

A2A contracts let agents declare **typed message schemas** that describe the structured
interactions they support. When one agent sends a message to another, the payload is validated
against the target agent's declared contract before delivery.

This builds on top of the existing [agent send](/tools/agent-send) and
[multi-agent sandbox tools](/tools/multi-agent-sandbox-tools) system.

## Declaring contracts

Contracts are declared per-agent in the `a2a` section of the agent config:

```json5
{
  agents: {
    list: [
      {
        id: "research-bot",
        a2a: {
          // Set to false to reject plain-text messages (only accept structured)
          allowFreeform: true,

          contracts: {
            "research.request": {
              description: "Submit a research query",
              input: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Research query" },
                  depth: { type: "string", enum: ["shallow", "deep"] },
                },
                required: ["query"],
              },
              output: {
                type: "object",
                properties: {
                  findings: { type: "string" },
                  sources: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    ],
  },
}
```

## Contract schema reference

| Field               | Type        | Description                                                             |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `description`       | `string`    | Human-readable description of what the contract does                    |
| `input`             | JSON Schema | Schema for the input payload the agent expects                          |
| `output`            | JSON Schema | Schema for the output the agent returns                                 |
| `requiresApproval`  | `boolean`   | Whether this contract requires approval from the agent's owner          |
| `version`           | `string`    | Optional version identifier (e.g. `"2.1.0"`)                            |
| `deprecated`        | `boolean`   | Mark this contract as deprecated                                        |
| `deprecatedMessage` | `string`    | Custom deprecation message (defaults to "This contract is deprecated.") |
| `supersededBy`      | `string`    | Name of the replacement contract                                        |

## Sending structured messages

To invoke a contract, wrap the message in the structured A2A format:

```json
{
  "_a2a": true,
  "contract": "research.request",
  "payload": {
    "query": "What are the latest trends in AI?",
    "depth": "deep"
  },
  "correlationId": "optional-tracking-id"
}
```

When a structured message is sent via `sessions_send`:

1. The message is parsed for the `_a2a` marker.
2. The target agent's contract is looked up by name.
3. The payload is validated against the contract's `input` schema.
4. If validation fails, the send is rejected with descriptive errors.
5. If validation succeeds, contract context (description, expected output schema) is injected into the target agent's system prompt.

## Validation behavior

### Structured messages

| Scenario                                           | Result                                        |
| -------------------------------------------------- | --------------------------------------------- |
| Payload matches contract input schema              | Message delivered with contract context       |
| Payload fails validation                           | Rejected with error listing specific failures |
| Contract name not found, agent has other contracts | Rejected with list of available contracts     |
| Contract name not found, agent has no contracts    | Delivered as best-effort (no validation)      |

### Plain text messages

| Scenario                                  | Result                                    |
| ----------------------------------------- | ----------------------------------------- |
| Agent has `allowFreeform: true` (default) | Delivered normally                        |
| Agent has `allowFreeform: false`          | Rejected with list of available contracts |

## Contract context injection

When a valid structured message is delivered, the target agent receives additional system prompt
context including:

- The contract name and description
- The input payload
- The correlation ID (if provided)
- The expected output schema (if defined)

This helps the target agent produce a response that matches the declared output format.

## Versioning & deprecation

Contracts support a versioning lifecycle. When a contract needs to change in a breaking way,
you can deprecate the old version and point callers to the replacement:

```json5
{
  a2a: {
    contracts: {
      // New version
      "research.query-v2": {
        version: "2.0.0",
        description: "Submit a research query (v2 — adds maxSources)",
        input: {
          type: "object",
          properties: {
            topic: { type: "string" },
            maxSources: { type: "integer" },
          },
          required: ["topic"],
        },
      },

      // Old version — still works but emits warnings
      "research.query": {
        version: "1.0.0",
        deprecated: true,
        deprecatedMessage: "Use research.query-v2 for improved source control",
        supersededBy: "research.query-v2",
        description: "Submit a research query",
        input: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
        },
      },
    },
  },
}
```

### Deprecation behavior

When a message targets a deprecated contract:

- **Validation still runs** — the message is accepted or rejected based on the schema.
- **Warnings are returned** — the validation result includes deprecation warnings
  alongside the normal `valid` / `errors` fields.
- **The message is delivered** — deprecation does not block delivery.

You can audit all deprecated contracts across your config using `listDeprecatedContracts(cfg)`.

## Discovery

Other agents can discover available contracts using the config. Each contract is identified by:

- **Agent ID**: The agent that declares the contract
- **Contract name**: A unique identifier within the agent (e.g., `"research.request"`)

## Example: multi-agent research pipeline

```json5
{
  agents: {
    list: [
      {
        id: "coordinator",
        // Coordinator sends structured requests to specialized agents
      },
      {
        id: "researcher",
        a2a: {
          allowFreeform: false, // Only accept structured requests
          contracts: {
            "research.query": {
              description: "Execute a research query and return findings",
              input: {
                type: "object",
                properties: {
                  topic: { type: "string" },
                  maxSources: { type: "integer" },
                },
                required: ["topic"],
              },
              output: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  sources: { type: "array", items: { type: "string" } },
                  confidence: { type: "number" },
                },
              },
            },
          },
        },
      },
      {
        id: "reviewer",
        a2a: {
          contracts: {
            "review.findings": {
              description: "Review and validate research findings",
              input: {
                type: "object",
                properties: {
                  findings: { type: "string" },
                  sources: { type: "array", items: { type: "string" } },
                },
                required: ["findings"],
              },
            },
          },
        },
      },
    ],
  },
}
```
