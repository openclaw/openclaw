---
summary: "CLI reference for `openclaw doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "Doctor CLI"
---

# `openclaw doctor`

Health checks and quick fixes for the gateway, channels, plugins, skills, model routing, local state, and config migrations. Use it whenever something is not behaving as expected and you want one command to explain what is wrong.

When run for a managed Gateway, Doctor compares active official plugins with the OpenClaw package referenced by the installed service. This check still works when the Gateway is stopped or unreachable. When an older Gateway is still running, Doctor reports its version separately from the post-restart version. If the service package cannot be identified, Doctor reports restart readiness as unknown instead of treating the plugin set as compatible.

When Gateway status reports degraded SecretRef owners, doctor prints a **Secret runtime degradation** warning with every cold or stale owner, affected config path, redacted reason, and the `openclaw secrets reload` retry command.

When channel ingress events are dead-lettered, doctor names each affected channel account and points to [`openclaw channels dead-letters list`](/cli/channels#inbound-dead-letters) for inspection and recovery.

Doctor warns when a registry-owned project clone is partial or shallow. It names
the clone, shallow state, and partial-clone config keys, including URL-keyed
remote twins. It prints manual repair commands; `--fix` does not fetch or repack
these clones. Agent workspaces and manually registered checkouts are excluded.

When the Gateway has exporter health facts, doctor reports the latest trusted
per-signal state and transport under **Telemetry exporters**. The summary is
redacted and does not include endpoint values, headers, certificates, payloads,
or raw errors.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Doctor pages

This page is an index. `openclaw doctor` is documented on seven pages, one per
reader job. Open the page that matches your task.

| Page                                                                       | Read it when                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Run doctor](/cli/doctor/running)                                          | Pick a posture, copy a working example, or look up what an option does.                 |
| [Gateway and service recovery](/cli/doctor/recovery)                       | The Gateway service, remote target, Control UI assets, or Gateway token needs repair.   |
| [Lint and post-upgrade modes](/cli/doctor/lint)                            | You want read-only findings for a CI gate, or post-upgrade plugin compatibility probes. |
| [Structured health check contract](/cli/doctor/health-contract)            | You are writing a doctor check or a plugin-backed health check.                         |
| [Legacy state migration](/cli/doctor/state-migrations)                     | A file-to-SQLite migration is blocked and needs manual reconciliation.                  |
| [SQLite maintenance and session migration](/cli/doctor/sqlite-maintenance) | You are compacting a database, or importing, validating, or recovering session history. |
| [Other checks and repairs](/cli/doctor/checks)                             | You want the inventory of every remaining check and repair, from Nix mode to channels.  |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here,
so an existing link such as `/cli/doctor#session-sqlite-migration` still resolves.
Each entry points at the page that now holds the content.

- <a id="postures" />[Postures](/cli/doctor/running#postures)
- <a id="gateway-service-recovery" />[Gateway service recovery](/cli/doctor/recovery#gateway-service-recovery)
- <a id="remote-gateway-recovery" />[Remote Gateway recovery](/cli/doctor/recovery#remote-gateway-recovery)
- <a id="control-ui-assets" />[Control UI assets](/cli/doctor/recovery#control-ui-assets)
- <a id="examples" />[Examples](/cli/doctor/running#examples)
- <a id="options" />[Options](/cli/doctor/running#options)
- <a id="lint-mode" />[Lint mode](/cli/doctor/lint#lint-mode)
- <a id="structured-health-checks" />[Structured health checks](/cli/doctor/health-contract#structured-health-checks)
- <a id="check-selection" />[Check selection](/cli/doctor/lint#check-selection)
- <a id="post-upgrade-mode" />[Post-upgrade mode](/cli/doctor/lint#post-upgrade-mode)
- <a id="legacy-state-migration" />[Legacy state migration](/cli/doctor/state-migrations#legacy-state-migration)
- <a id="shared-state-sqlite-compaction" />[Shared state SQLite compaction](/cli/doctor/sqlite-maintenance#shared-state-sqlite-compaction)
- <a id="session-sqlite-migration" />[Session SQLite migration](/cli/doctor/sqlite-maintenance#session-sqlite-migration)
- <a id="downgrading-after-session-sqlite-migration" />[Downgrading After Session SQLite Migration](/cli/doctor/sqlite-maintenance#downgrading-after-session-sqlite-migration)
- <a id="notes" />[Notes](/cli/doctor/checks#notes)
- <a id="invalid-gateway-tokens" />[Invalid Gateway tokens](/cli/doctor/recovery#invalid-gateway-tokens)
- <a id="macos%3A-launchctl-env-overrides" />[macOS: `launchctl` env overrides](/cli/doctor/recovery#macos%3A-launchctl-env-overrides)
- <a id="macos-launchctl-env-overrides" />[macOS: `launchctl` env overrides](/cli/doctor/recovery#macos-launchctl-env-overrides)

## Related

- [CLI reference](/cli)
- [Gateway doctor](/gateway/doctor)
