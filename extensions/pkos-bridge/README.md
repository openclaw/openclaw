# PKOS Bridge

`pkos-bridge` is the local customization seam for AIWork:

- OpenClaw remains the control plane.
- Workbench remains the execution plane.
- PKOS remains the memory and truth plane.

This plugin is intentionally a bridge, not a fork of OpenClaw core semantics.

## Current scaffold

- Tool surfaces:
  - `pkos_bridge_status`
  - `pkos_bridge_prepare_task_handoff`
  - `pkos_bridge_submit_trace_bundle`
- Gateway methods:
  - `pkosBridge.status`
  - `pkosBridge.prepareTaskHandoff`
  - `pkosBridge.submitTraceBundle`
- Command surface:
  - `/pkos-bridge`
- HTTP base path:
  - `/plugins/pkos-bridge`

## Design rule

PKOS-specific object semantics should live here first. If a future requirement
cannot be expressed through this plugin boundary, add a small generic seam to
OpenClaw core instead of embedding PKOS logic directly into `src/**`.

See [`/Volumes/AIWork/OpenClaw/docs/refactor/aiwork-pkos-bridge-strategy.md`](/Volumes/AIWork/OpenClaw/docs/refactor/aiwork-pkos-bridge-strategy.md) for the full upgrade and customization strategy.

