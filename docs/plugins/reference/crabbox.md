---
summary: "Cloud worker provider and lease-backed sandbox backend for the Crabbox CLI."
read_when:
  - You are installing, configuring, or auditing the crabbox plugin
title: "Crabbox plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Cloud worker provider and lease-backed sandbox backend for the Crabbox CLI.

## Distribution

- Package: `@openclaw/crabbox-provider`
- Install route: included in OpenClaw

## Surface

- CLI commands: `openclaw crabbox`
- Contracts: `tools`, `workerProfileSuggestions`, `workerProviders`
- Skills

<!-- openclaw-plugin-reference:manual-start -->

## Configure

See [Cloud worker environments](/gateway/config-cloud-workers#crabbox-profile) for the profile schema and lifecycle notes.

Forward Gateway environment variables to an operator-provided setup script by listing their names in the Crabbox profile settings:

```json5 validate=false
{
  setup: 'install-worker "$OPENCLAW_WORKER_ARTIFACT_TOKEN"',
  setupEnv: ["OPENCLAW_WORKER_ARTIFACT_TOKEN"],
}
```

`setupEnv` explicitly forwards up to 16 unique environment variable names to the setup command only. Values are read from the Gateway process environment and are never stored in the profile configuration. Missing variables fail before a machine is allocated.

## Model-run timeout

`openclaw crabbox run --timeout <seconds>` requires decimal whole seconds from
`1` through `86400`. Hexadecimal, binary, octal, and exponent spellings are rejected.

## Conversation tool feedback

The `crabbox` tool reports readable outcomes for profile discovery, attachment
status, creation or reuse, commands, process inspection, and shutdown. An empty
status means no Crabbox is attached to the conversation, not that a run failed.

Longer operations emit a request-in-progress update while awaiting the Gateway.
These updates do not claim intermediate provisioning stages or app readiness.
Command results retain stdout, stderr, exit and termination facts; background
results report the observed process state. Structured result details remain
available to tool consumers.

<!-- openclaw-plugin-reference:manual-end -->
