---
summary: "Draft contract for optional, launcher-owned Control UI settings"
title: "External supervisor controls (draft)"
---

# External supervisor controls (draft)

> **Draft proposal — no Gateway or Control UI implementation is included.**
>
> This document defines the narrow extension point proposed for external Gateway
> supervisors. It must not be treated as an existing API or security boundary.

Some deployments own Gateway lifecycle outside OpenClaw: a desktop launcher,
a container orchestrator, or an enterprise service manager. Those supervisors
may have settings that are useful to show and change in Control UI, while the
setting's storage, enforcement, and platform-specific semantics remain owned
by the supervisor.

This proposal deliberately avoids encoding platform features in OpenClaw core.
For example, Windows launcher isolation is a supervisor feature, not a core
`gatewayIsolation` setting.

## Proposed model

A future implementation may advertise a list of **external supervisor
controls** only when `OPENCLAW_SUPERVISOR_MODE=external` is set. Each control
would contain:

- a stable, supervisor-namespaced identifier;
- a short user-facing title and description;
- the current **reported** value and a list of allowed values;
- an explicit `effect` description, such as `"Applies after the next manual
  Gateway restart"`;
- optional status evidence supplied by the supervisor, distinct from the
  requested value.

The future Control UI would render this as an optional supervisor-owned section
rather than as a built-in Gateway setting.

## Authority and transport

The Gateway must not infer state from a process environment variable or claim
that a requested posture is active. The supervisor remains authoritative for:

1. reading and validating state;
2. applying a requested change;
3. creating and verifying any real enforcement boundary; and
4. reporting whether the boundary is actually effective.

A future bridge must use a local, authenticated supervisor transport with
explicit request and response schemas. It must be disabled by default, bind to
no network-accessible interface, and authorize mutations at `operator.admin`
or stronger. The Gateway should proxy only allowlisted controls it learned at
startup; it must never turn arbitrary Control UI input into a supervisor
command line or shell invocation.

A control mutation may save a requested value without restarting the Gateway.
Its response must say when the change takes effect. Control UI must show
**requested** and **effective** state separately whenever the supervisor can
provide both.

## Windows launcher example (non-normative)

The Windows MSIX launcher could expose a namespaced control such as
`windows.gatewayIsolation` with values `enabled` and `disabled`. Its command
surface (`clawctl gateway-isolation …`) remains package-owned. Until that
launcher creates and verifies a real Windows isolation boundary, it must report
the effective state as unavailable rather than calling an environment marker
isolation.

## Why this is not `system.info`

`system.info` is a read-only host snapshot. Adding a feature-specific field to
it makes the core protocol and every client own a supervisor-specific concept,
while still providing no safe write path. A separate optional bridge lets
supervisors opt in without changing the meaning of baseline host information.

## Implementation prerequisites

Do not implement this bridge until an external supervisor has:

- a documented local authenticated transport;
- a stable control descriptor and mutation contract;
- an idempotent, testable requested/effective state model; and
- a real enforcement implementation where the setting makes a security claim.

The Windows packaging implementation should prove those properties first. This
proposal can then add generic protocol schemas, Gateway proxy handlers, Control
UI rendering, and end-to-end tests without importing any Windows-specific
policy into core.
