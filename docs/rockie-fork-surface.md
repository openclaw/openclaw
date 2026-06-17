# Rockie Fork Surface

`Rockielab/rockie-claw` packages OpenClaw for Rockie BYOK tenant runtimes.
The fork should stay easy to compare with `openclaw/openclaw`: Rockie-owned
runtime code belongs in predictable prefixes, and any OpenClaw core patch
outside those prefixes needs an explicit reason.

## Intended Rockie-Owned Prefixes

- `Dockerfile.multitenant` builds the tenant runtime image.
- `overlay/multitenant/**` contains tenant entrypoint, runtime assembly, and
  Rockie runtime helpers.
- `overlay/tenant/**` contains tenant lifecycle scripts.
- `apps/broker/**` contains the Go broker used by Rockie tenant runtimes.
- `overlay/multitenant/mcp-rockie/**` contains Rockie MCP runtime integration.
- `.github/workflows/**` entries for runtime image build, rollout, promotion,
  and runtime acceptance checks are Rockie-owned when they target tenant
  runtime delivery.
- `scripts/**` entries for tenant runtime build, rollout, and verification are
  Rockie-owned when they target those workflows.
- `overlay/multitenant/tests/**` and runtime-focused `test/scripts/**` entries
  cover the tenant runtime contract.

## Core Patch Groups Outside Those Prefixes

Some current Rockie patches still touch OpenClaw core paths. These should stay
visible until they can be moved behind overlay, plugin, MCP, or configuration
boundaries.

| Area | Current reason | Minimization direction |
| --- | --- | --- |
| `src/agents/**` | Tenant runtime tool policy, sandbox behavior, and owner-only tool handling need to match Rockie's BYOK execution model. | Move Rockie-only behavior behind runtime configuration, plugin, or MCP boundaries when the upstream surface can support it cleanly. |
| `src/gateway/**` | Gateway import/auth hardening is needed for packaged runtime operation. | Keep generic hardening upstreamable; isolate Rockie deployment assumptions in runtime config. |
| `src/infra/**` | File identity, pinned-path helpers, SSH/runtime process behavior, and owned child environment handling support tenant isolation. | Prefer reusable generic safety helpers; keep tenant-specific policy in overlay/runtime code. |
| `src/process/**` | Supervisor and spawn behavior supports long-running tenant agent sessions. | Push generic fixes upstream; avoid Rockie-specific branching in shared supervisor code. |
| `src/secrets/**` | Runtime platform-secret integration is needed for tenant machines. | Keep provider-specific secret injection out of core where a config or MCP bridge can own it. |
| `src/media/**` and `src/plugins/**` | Packaged runtime behavior and plugin metadata lifecycle need to work inside tenant containers. | Retain only generic fixes in core; move runtime packaging assumptions to overlay tests and config. |

## Review Rule

New Rockie changes should prefer the intended prefixes above. When a change
must touch OpenClaw core, the PR should explain why the patch cannot live in an
overlay, plugin, MCP integration, or runtime configuration boundary yet.
