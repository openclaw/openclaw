---
summary: "Implementation plan and effort estimate for exposing OpenClaw as a VS Code Copilot chat participant"
read_when:
  - Scoping the OpenClaw Copilot integration
  - Estimating delivery time for a VS Code chat participant
title: "VS Code Copilot Chat Agent Plan"
---

# VS Code Copilot Chat Agent Plan

This page estimates the level of effort to expose OpenClaw as a chat agent in GitHub Copilot Chat for VS Code.

Recommended target: a **VS Code extension** that provides `@openclaw` and uses the OpenClaw Gateway as the backend.

Architecture background: [VS Code Copilot Chat Agent](/concepts/copilot-chat-agent)

## Scope levels

### Prototype

Deliver a working spike for local evaluation.

Includes:

- one local-only VS Code extension
- `@openclaw` participant registration
- fixed Gateway URL and token config
- simple prompt forwarding to OpenClaw
- basic streamed text response

Does not include:

- durable thread mapping
- slash commands
- session controls
- polished auth UX
- packaging for distribution

Estimated effort:

- **Level of effort:** small to medium
- **Calendar time:** 3 to 5 working days for one engineer

### V1

Deliver a usable extension for day-to-day local use.

Includes:

- stable thread-to-session mapping
- extension settings and secret storage
- streamed response handling
- basic slash commands such as `/agent`, `/reset`, and `/status`
- retry and error handling for Gateway failures
- unit tests for mapping and transport logic
- user-facing docs

Estimated effort:

- **Level of effort:** medium
- **Calendar time:** 2 to 3 weeks for one engineer

### V1.5

Add OpenClaw-specific workflow affordances.

Includes:

- session list and history helpers
- links or references to transcript-backed state
- support for switching agents per thread
- better progress messages and tool-style output cards where practical

Estimated effort:

- **Level of effort:** medium to large
- **Calendar time:** 1 additional week

### V2

Add deeper OpenClaw orchestration and shared tool surfaces.

Includes:

- `sessions_send` and `sessions_spawn` workflows
- optional MCP server surface for agent mode
- richer workspace context controls
- packaging and publishing polish

Estimated effort:

- **Level of effort:** large
- **Calendar time:** 2 to 4 additional weeks

## Work breakdown

### 1. Discovery and spike

- confirm the exact Chat Participant API contract to target
- validate that the OpenClaw Gateway streaming API provides the right response shape for the extension
- decide whether to use `user` or explicit `x-openclaw-session-key` mapping
- define the local persistence model for thread metadata

Estimate:

- 1 to 2 days

### 2. Extension skeleton

- create extension manifest
- register `@openclaw`
- add activation, settings, and command wiring
- add local dev and debug instructions

Estimate:

- 1 to 2 days

### 3. Gateway transport

- implement OpenClaw HTTP client
- handle streaming response chunks
- handle timeouts, cancellation, and auth failures
- normalize response text for Copilot Chat rendering

Estimate:

- 2 to 4 days

### 4. Session mapping

- map chat thread to OpenClaw session
- choose persistence location and lifecycle
- support reset and thread reassignment

Estimate:

- 2 to 3 days

### 5. User experience

- add `/agent`, `/reset`, `/status`
- add progress messages and follow-up prompts where helpful
- expose clear error messages for unreachable Gateway or auth failures

Estimate:

- 2 to 3 days

### 6. Testing and hardening

- unit tests for transport and mapping
- smoke tests against a live OpenClaw Gateway
- cancellation and reconnect testing
- docs and packaging cleanup

Estimate:

- 2 to 4 days

## Rollup estimate

For one engineer working mostly full-time:

- **Prototype:** 3 to 5 days
- **Practical V1:** 10 to 15 working days
- **V1 plus OpenClaw workflow commands:** 15 to 20 working days
- **V2 with MCP follow-up:** 25 to 40 working days total

For two engineers splitting extension UX and backend adaptation work:

- **Practical V1:** 1 to 2 weeks
- **V2 with MCP:** 2 to 3 weeks

## Main dependencies

- stable OpenClaw Gateway availability and auth
- a well-defined streaming contract from the Gateway endpoint used by the extension
- a decision on local-only vs published extension scope
- access to GitHub Copilot chat extensibility APIs in the target VS Code build

## Main risks

### Streaming mismatch

Risk: the extension may need response adaptation if the Gateway stream shape does not map cleanly to Copilot Chat output.

Mitigation:

- prototype transport first
- isolate stream parsing in a single adapter module

### Session identity drift

Risk: VS Code conversation identity may not map cleanly to the desired OpenClaw session lifecycle.

Mitigation:

- keep the first version simple: one chat thread equals one OpenClaw session
- add explicit reset and reassignment commands

### Auth friction

Risk: local users may tolerate a manual token flow, but broader rollout will need better UX.

Mitigation:

- start with secret storage and explicit settings
- defer advanced auth flows until after local validation

### Scope creep

Risk: trying to add MCP, session control, and GitHub App support in the first cut will slow delivery sharply.

Mitigation:

- keep the first milestone limited to `@openclaw` participant behavior
- sequence MCP and cross-surface work later

## Suggested milestone plan

### Milestone 1

- local prototype
- participant registration
- prompt forwarding
- streaming response

Target: end of week 1

### Milestone 2

- stable session mapping
- auth UX
- reset and status commands
- initial tests

Target: end of week 2

### Milestone 3

- agent switching
- session helpers
- packaging polish
- docs and rollout notes

Target: end of week 3

## Recommended staffing

- **Best single-owner path:** 1 engineer for 2 to 3 weeks
- **Best faster path:** 2 engineers for 1 to 2 weeks

If the goal is to validate product value rather than ship polished distribution, build the prototype first and make the publish decision after one week of live use.
