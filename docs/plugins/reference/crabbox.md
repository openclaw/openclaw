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

Select protected shared-store credentials for setup with `setupSecrets`:

```json5 validate=false
{
  setup: 'install-worker "$ARTIFACT_TOKEN"',
  setupSecrets: {
    ARTIFACT_TOKEN: { source: "store", provider: "default", id: "ARTIFACT_TOKEN" },
  },
}
```

Each selected entry needs explicit HTTPS destination bindings. Setup receives an
opaque placeholder, not the credential; its HTTPS client must honor the supplied
proxy and CA settings. Missing protected entries or bindings fail before a new
machine is allocated. The selection is checked again when the setup grant opens.
`OPENCLAW_*` names are reserved, and `setupEnv` is retired. See
[Setup secrets](/gateway/config-cloud-workers#setup-secrets) for storage,
destination bindings, and migration.

## Conversation tool feedback

The `crabbox` tool reports readable outcomes for profile discovery, attachment
status, creation or reuse, commands, process inspection, and shutdown. An empty
status means no Crabbox is attached to the conversation, not that a run failed.
Delegated workers belong to their child sessions; inspect the retained child's
placement through [session discovery](/concepts/session-tool#listing-and-reading-sessions).
An empty conversation attachment does not prove that delegated work had no effects.

Longer operations emit a request-in-progress update while awaiting the Gateway.
These updates do not claim intermediate provisioning stages or app readiness.
Command results retain stdout, stderr, exit and termination facts; background
results report the observed process state. Structured result details remain
available to tool consumers.

<!-- openclaw-plugin-reference:manual-end -->
