---
summary: "FogClaw plugin for agent message redaction and PII scanning"
read_when:
  - You want optional built-in privacy tooling in OpenClaw
  - You need configurable redaction, blocking, or warning for sensitive content
  - You are setting up a custom entity scanner in your agent workflow
title: "FogClaw Plugin"
---

# FogClaw (plugin)

FogClaw is an OpenClaw plugin that protects agent workflows by detecting and handling sensitive data before or during tool execution.

It provides both proactive guardrail behavior (via the `before_agent_start` hook) and explicit tools:

- `fogclaw_scan`: scans text for PII and custom entities.
- `fogclaw_redact`: scans and redacts sensitive matches.

## Install

```bash
openclaw plugins install @openclaw/fogclaw
```

After install, restart the Gateway and enable/configure `plugins.entries.fogclaw`.

## Plugin entry

The package exports the plugin manifest and entry as:

- plugin id: `fogclaw`
- package name: `@openclaw/fogclaw`
- extension entry: `./dist/index.js`

## What it scans

- Structured PII via regex (for example emails, phone numbers, SSNs, credit cards)
- Custom named-entity labels via GLiNER zero-shot detection

You can also define custom entity labels and per-entity actions in config (for example `redact`, `block`, or `warn`).

## Behavior at a glance

- Runs as a plugin loaded by the standard OpenClaw plugin pipeline.
- Supports local-only and hosted environments; works from OpenClaw extensions path.
- Fails safely to regex-only mode if optional GLiNER model initialization is unavailable.

## Configuration reference

Set plugin config under `plugins.entries.fogclaw.config`:

```json5
{
  plugins: {
    entries: {
      fogclaw: {
        enabled: true,
        config: {
          enabled: true,
          guardrail_mode: "redact",
          redactStrategy: "token",
          confidence_threshold: 0.5,
          custom_entities: ["project codename", "competitor name"],
          entityActions: {
            EMAIL: "redact",
            PHONE: "redact",
            SSN: "block",
            CREDIT_CARD: "block",
            PERSON: "warn",
          },
        },
      },
    },
  },
}
```

## Use in the OpenClaw tool policy

When enabled, the plugin registers the `before_agent_start` hook and two tools:

- `fogclaw_scan`
- `fogclaw_redact`

These tools accept a required `text` field and optional strategy / custom label overrides.

For install and reproducible package metadata evidence, use the package's `openclaw.extensions` field:

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```
