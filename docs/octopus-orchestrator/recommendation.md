# OpenClaw Octopus Orchestrator Recommendation

## Status
Draft v0.1

## Executive Summary
OpenClaw should **not** adopt a single external system wholesale for terminal-first distributed orchestration.

The current ecosystem has strong partial solutions, but no convincing full-stack winner that combines:
- durable terminal-native execution
- structured runtime control where available
- PTY/tmux fallback where needed
- explicit shared state and claims
- distributed habitats
- operator intervention, safety, and recovery
- provider flexibility without ACP lock-in

The recommended strategy is:
- **build the orchestration core in OpenClaw**
- **borrow proven patterns from the best adjacent systems**
- **integrate structured runtimes opportunistically, not architecturally depend on them**

## Strategic Recommendation
### Recommendation
Build an OpenClaw-native orchestration core.

### Reason
What we want is not well served by any single candidate. The desired system is a synthesis of multiple architectural layers that are currently split across different tools.

### Build posture
- Build the head, scheduler, shared state, lease/claim model, and operator surfaces natively in OpenClaw.
- Treat runtime control as an adapter layer.
- Make structured CLI control the preferred fast path.
- Make PTY/tmux the universal fallback path.

## What to Borrow

### From Fleet / fleetspark
Borrow:
- distributed mission dispatch ideas
- commander/worker separation
- dependency-aware routing
- lightweight coordination concepts

Do not borrow wholesale:
- any assumption that Git-as-message-bus should become the permanent OpenClaw control plane

Reason:
Git as bus is elegant for low-infra distributed execution, but too crude as the primary nervous system for rich supervision, leases, claims, and recovery.

### From ai-fleet
Borrow:
- branch/worktree isolation patterns
- tmux-backed local session durability
- local fleet operational hygiene

Do not borrow wholesale:
- a narrow model where orchestration is mostly session spawning plus tmux attachment

Reason:
ai-fleet is strong substrate plumbing, but too weak as a complete control plane.

### From PiloTY
Borrow:
- PTY embodiment concepts
- stateful terminal session handling patterns
- the idea that human-like terminal control is a first-class orchestration mode

Do not borrow wholesale:
- any security posture that effectively bypasses OpenClaw approval boundaries

Reason:
PiloTY validates the control model, but its security implications are too loose to become the default orchestration substrate.

### From AgentPipe
Borrow:
- operator-facing observability patterns
- TUI ideas for multi-agent visibility
- metrics, health, and cost surfacing
- agent-room visualization ideas where they help operator comprehension

Do not borrow wholesale:
- the assumption that multi-agent conversation is equivalent to execution orchestration

Reason:
AgentPipe is useful for visibility and conversation topology, but not sufficient as the task/ownership/recovery substrate.

### From ccswarm
Borrow:
- cautionary lessons from ambitious orchestration design
- any useful abstractions that are not ACP-bound

Do not borrow wholesale:
- ACP-first architectural assumptions

Reason:
The system we want must remain terminal-first and provider-flexible.

## What to Avoid
- ACP as the center of gravity
- transcript-only shared state
- hidden destructive automation inside orchestration abstractions
- parallel fan-out without ownership and recovery semantics
- overfitting the system to one agent runtime
- making tmux the whole architecture instead of one substrate layer
- making Git the whole control plane instead of one coordination pattern

## Recommended Architecture Position
### Core thesis
OpenClaw should be the nervous system, not just a launcher.

That means OpenClaw should own:
- durable arm identity
- grip ownership
- state transitions
- leases
- claims
- recovery logic
- operator intervention
- policy and auditability

And it should treat external runtimes as arms connected through adapters.

### Runtime hierarchy
1. Structured CLI mode when available
2. PTY/tmux mode when structured control is unavailable or insufficient
3. Human takeover path always available

This is the right hierarchy because it optimizes for reliability without sacrificing universality.

## Recommended Build Strategy
### Phase A, Core local substrate
Build first:
- tmux-backed arm durability
- registry and event log
- arm lifecycle commands
- attach/resume/restart behavior

Reason:
Without durable arms and local recovery, the higher-level system is theater.

### Phase B, Structured adapter path
Build next:
- structured adapter abstraction
- first-class Claude Code structured integration
- normalized event ingestion

Reason:
This gives OpenClaw a high-quality control path where the runtime supports it.

### Phase C, Claims and shared state
Build next:
- grip ownership
- file/resource claims
- artifact indexing
- checkpoint metadata

Reason:
This is where orchestration becomes more than parallel session management.

### Phase D, Distributed habitats
Build next:
- node agent
- leases and heartbeat model
- capability-aware scheduling

Reason:
This turns the system into a real octopus rather than a local session board.

### Phase E, Safety and advanced supervision
Build next:
- policy engine
- approvals and quarantine
- speculative execution only after ownership/recovery are solid

Reason:
Speed without safety will cause damage, especially with PTY-backed systems.

## Build vs Fork vs Integrate
### Adopt
No full adoption recommended.

### Fork
Possible for isolated utility components if useful, but not as the main architectural path.

### Integrate
Yes, through selective adapters and optional tooling patterns.

### Build
Yes, the orchestration core should be built in OpenClaw.

## Why Build in OpenClaw
OpenClaw already has native advantages:
- session model
- cron and wake/event infrastructure
- multi-tool coordination
- node support
- messaging surfaces
- operator-centric interaction model

These are stronger foundations for the orchestration head than most external repos.

What OpenClaw lacks is the explicit octopus execution substrate. That is what should be built.

## Decision Statement
OpenClaw should pursue a **build-native, borrow-patterns, integrate-selectively** strategy.

Specifically:
- build the orchestration head and shared state plane natively
- build a runtime adapter layer with structured-first and PTY/tmux fallback
- treat external projects as reference implementations and idea mines, not foundational dependencies

## Immediate Next Steps
1. Approve PRD, HLD, and LLD
2. Translate docs into implementation epics and milestones
3. Build Local Octopus MVP
4. Add first structured adapter
5. Add leases, claims, and node agent after local durability proves out

## Exit Criteria for Recommendation Approval
This recommendation is ready for review when:
- the build-native posture is accepted
- the borrow sources are accepted
- the avoid list is accepted
- the phased build strategy is accepted as the basis for planning
