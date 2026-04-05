---
title: "Claw v1 Full Access Semantics Spec"
summary: "Normative definition of what full access means for every Claw capability family."
read_when:
  - You need the exact meaning of full access in Claw.
  - You are deciding whether a missing capability is a blocker or a preflight issue.
  - You need to separate tool existence from actual mission usability.
status: active
---

# Claw v1 Full Access Semantics Spec

## Purpose

Claw v1 uses the phrase "full access" in a much stronger sense than OpenClaw's built-in `profile: "full"`. In OpenClaw today, `profile: "full"` mostly means "do not apply a core allowlist." It does not, by itself, guarantee host browser control, plugin tool exposure, owner-only tool eligibility, real auth presence, or actual runtime usability.

This document defines what full access means for Claw v1 and how capability availability is evaluated before and during mission execution.

## Capability state vocabulary

Every tool or capability must be classified into one of four distinct states:

| State           | Meaning                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `exists`        | The code for the capability is present in the build or plugin set.                                                |
| `exposed`       | The capability is actually surfaced to the Claw session by tool policy and runtime assembly.                      |
| `usable`        | The capability can be invoked successfully in the current runtime environment.                                    |
| `authenticated` | The capability can operate against its target system because required credentials, pairing, or login are present. |

These states are intentionally different.

### Examples

- `browser` can exist and be exposed, but not usable if startup or attach is failing.
- `nodes` can exist and be exposed, but not authenticated or usable if no device is paired.
- `message` can exist and be exposed, but not authenticated if channels are not configured.
- `gateway` can exist and be exposed, but still be owner-only and therefore unavailable to non-owner sessions.

## Core rule

In Claw v1, "full access" means:

1. Claw sessions must expose every eligible capability family by default.
2. Claw runs on host by default, not in the normal sandbox path.
3. Routine execution does not wait for per-step approvals after unattended continuation is approved.
4. Missing auth or missing runtime capability becomes a preflight finding or runtime blocker, not a silent absence.

## Scope of full access

Full access covers the following capability families.

| Family                 | Included capabilities                                             | Claw v1 meaning of full access                                                           |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Filesystem             | `read`, `write`, `edit`, `apply_patch`                            | Host-wide read and mutation, not workspace-limited.                                      |
| Runtime                | `exec`, `process`, `code_execution`                               | Host execution, background process control, no routine ask gate.                         |
| Browser and web        | `browser`, `web_fetch`, `web_search`, provider web tools          | Host browser control, evaluation enabled, web tools surfaced when configured.            |
| Sessions and agents    | `sessions_*`, `subagents`, `agents_list`                          | Full orchestration, spawning, yielding, resuming, and inspection.                        |
| Gateway and automation | `gateway`, `cron`                                                 | Full control available to owner-controlled Claw missions.                                |
| Nodes and devices      | `nodes`, device-backed capabilities                               | Fully surfaced when devices are paired and host permissions exist.                       |
| Media                  | `image`, `image_generate`, `tts`, media-understanding style tools | Exposed when installed and configured; auth-dependent where relevant.                    |
| Memory                 | `memory_search`, `memory_get`, memory plugins                     | Exposed when configured; backend availability and auth still matter.                     |
| Messaging and channels | `message` and channel-owned tools                                 | Exposed when installed; operational only when channels are configured and authenticated. |
| Plugin tools           | Bundled and enabled plugin tools, including optional tools        | Exposed by default to Claw unless a later Claw policy explicitly narrows them.           |

## Normative semantics by family

## Filesystem

Claw full access for filesystem tools means:

- `read`, `write`, `edit`, and `apply_patch` are exposed to Claw sessions.
- Host-wide file access is allowed.
- There is no workspace-only mutation boundary after mission approval.
- Mission roots are tracking and organization constructs, not write guards.

### Required implementation consequences

- Claw must not rely on workspace root guards as a product boundary.
- Mission files still declare primary and secondary roots for context assembly and artifact placement.
- Audit must log host path targets for file mutations.

## Runtime

Claw full access for runtime tools means:

- `exec`, `process`, and `code_execution` are exposed.
- Execution occurs on host by default.
- `exec.ask` behavior is effectively off at the Claw layer after mission approval.
- Security policy is effectively "full" unless a later Claw config explicitly narrows it.
- Background execution and process management are part of the expected autonomy surface.

### Required implementation consequences

- Claw must treat host runtime capability as part of its baseline.
- Missing shell availability, missing binaries, or OS-level restrictions are preflight issues or blockers.
- Audit must record process creation, long-running job identity, and terminal outcome.

## Browser and web

Claw full access for browser and web means:

- The `browser` tool is exposed.
- Host browser control is allowed.
- DOM evaluation and interactive actions are allowed.
- Browser runtime stability is a prerequisite for browser-dependent missions.
- Web fetch and search tools remain available when configured.

### Important distinction

`browser` being exposed is not enough. For Claw, browser full access also requires:

- browser startup to succeed reliably
- CDP attach to be stable enough for multi-step flows
- gateway restart behavior not to break browser ownership on Windows

These behaviors are defined in [Browser and Runtime Hardening Spec](/claw/04-browser-and-runtime-hardening-spec).

## Sessions and agents

Claw full access for orchestration means:

- Session listing, history, send, spawn, status, yield, and subagent management are exposed.
- Claw may run coordinator, planner, executor, verifier, and research roles as distinct sessions.
- Claw may delegate, reassign, and retry work without operator approval after unattended continuation is approved.

### Required implementation consequences

- Session tools must be available to Claw even when they are not central to standard chat flows.
- Governance must enforce fanout and spawn depth limits.

## Gateway and cron

Claw full access for gateway and automation means:

- `gateway` and `cron` are exposed to owner-controlled Claw sessions.
- Claw may inspect and use gateway automation facilities as part of mission execution.
- Claw may create or adjust its own mission-runner scheduling infrastructure if that becomes part of the implementation.

### Owner-only handling

In the broader OpenClaw platform, some tools are owner-only. Claw does not remove that distinction. Instead:

- Claw itself is owner-only.
- Therefore owner-only tool classes are fully available inside Claw once the operator is authenticated into the Claw console.

## Nodes and devices

Claw full access for node/device tools means:

- Device-backed tools are exposed when paired and permitted.
- If device pairing or OS permission is missing, Claw must report that as a preflight issue or runtime blocker.
- Missing device presence must never be hidden behind a vague "tool unavailable" experience.

## Media and memory

Claw full access for media and memory means:

- Installed media and memory capabilities must be exposed to Claw by default.
- Backend or provider requirements remain real.
- Missing provider auth, model routing, or storage backend availability is a capability finding, not a prompt-only problem.

## Messaging and channel tools

Claw v1 is UI-only as a product surface, but underlying message and channel tools may still exist in the OpenClaw installation.

Claw full access therefore means:

- If channel and message tools are enabled in the runtime, Claw may use them as capabilities.
- Messaging is not part of the primary operator interface in v1.
- Missing channel config or missing channel auth is treated as a preflight finding or runtime blocker when a mission depends on it.

## Plugin tools

Claw full access for plugins means:

- Enabled plugin tools are exposed to Claw by default.
- Optional plugin tools are not silently excluded from Claw just because they are optional in generic sessions.
- Disabled plugins do not count as exposed.
- Plugin tool availability must be included in preflight output when missions depend on them.

## Capability preflight

Before unattended continuation is approved, Claw must build a readiness packet that classifies required capabilities into the four-state model.

The readiness packet must include:

- selected model and auth profile
- selected mission roots
- exposed tool families
- browser availability and health
- plugin availability
- message/channel availability if mission-implied
- node/device availability if mission-implied
- memory backend availability if mission-implied
- missing credentials or integration auth
- expected high-impact side-effect domains

### Preflight outcomes

Preflight may end in one of three outcomes:

| Outcome          | Meaning                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ready`          | Mission packet is ready for unattended continuation approval.                                                               |
| `awaiting_setup` | Mission requires auth, config, or capability setup before unattended continuation approval is sensible.                     |
| `blocked`        | Mission cannot even produce a viable start packet because the runtime or product configuration is fundamentally incomplete. |

## Blocker conditions

Capability-related blockers fall into two buckets.

### Pre-start blockers

- Missing credentials or tokens required to do the mission at all
- Browser unavailable for a browser-dependent mission
- Required plugin disabled or absent
- Required node/device not paired
- Required model/provider not configured

### Runtime blockers

- Credentials expired after unattended continuation was already approved
- Interactive login or CAPTCHA encountered mid-mission
- External system permission revoked mid-mission
- Device or browser runtime becomes unavailable and cannot be recovered automatically

## Explicit non-goals of full access

Full access does not mean:

- magic access to accounts that have not been authenticated
- bypassing OS permission prompts that require a human
- bypassing remote system access control
- bypassing Claw's audit and governance requirements

## Current source touchpoints

This spec is grounded in the current OpenClaw tool/runtime structure around:

- `src/agents/tool-catalog.ts`
- `src/agents/pi-tools.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/tool-policy.ts`
- `src/agents/tool-policy-shared.ts`
- `src/plugins/tools.ts`
- `src/agents/tools/cron-tool.ts`
- `src/agents/tools/gateway-tool.ts`
- `src/agents/tools/nodes-tool.ts`
- `extensions/browser/src/browser/client.ts`
- `extensions/browser/src/browser/cdp-timeouts.ts`

## Related specs

- [Claw v1 Master Spec](/claw/00-master-spec)
- [Mission Engine Spec](/claw/02-mission-engine-spec)
- [Browser and Runtime Hardening Spec](/claw/04-browser-and-runtime-hardening-spec)
- [Governance and Audit Spec](/claw/06-governance-and-audit-spec)
