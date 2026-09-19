---
summary: "Per-agent secret-store assignment policy for the exec projection, enforced through the host secret_env_authorize seam."
read_when:
  - You are installing, configuring, or auditing the secret-assignment-broker plugin
title: "Secret Assignment Broker plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Per-agent secret-store assignment policy for the exec projection, enforced through the host secret_env_authorize seam.

## Distribution

- Package: `@openclaw/secret-assignment-broker`
- Install route: included in OpenClaw

## Surface

This plugin declares no channels, providers, commands, or contracts.

<!-- openclaw-plugin-reference:manual-start -->

## Activation and rollout

The plugin is **disabled by default** (`enabledByDefault: false`). Existing
installs are unaffected by an upgrade until an operator enables it.

When it is enabled, the core `secret_env_authorize` seam asks it for the
assigned entry names on every Gateway-hosted `exec` run. Enabling the broker
with **no assignments** authorizes nothing: every resolved shared-store entry is
withheld from the executable environment (fail closed). Assign an agent
explicitly before enabling it, or its commands run without those variables.

Assignments are stored in the host keyed store under the `agent-assignments`
namespace, so they persist across plugin reloads: a fresh registry binding reads
the same keyed-store records. Assign
per agent with `secrets.assignments.broker.set` (`none`, `selected`, or `all`);
`secrets.assignments.broker.self` reports only the caller's own assignment and
derives its identity from the authenticated client, never from params;
`secrets.assignments.broker.list` is the operator-admin inventory. Discovery of
the plugin follows the normal bundled-plugin enable path.

<!-- openclaw-plugin-reference:manual-end -->
