# OpenClaw Octopus Orchestrator — Integration Surface

## Status

Milestone 0 draft v0.1 — the durable contract between Octopus and the rest of OpenClaw.

## Purpose

HLD and LLD cover **how Octopus is built**. This document covers **how a user meets it** and — crucially — **how to keep that contact surface durable when OpenClaw upstream changes**.

Every integration point here is classified by stability and paired with an insulation strategy so that future OpenClaw releases do not cascade into Octopus breakage.

## The Consolidator Role — OpenClaw as Multi-Harness Orchestrator

Before the integration details, the framing that explains why every decision in this document lands the way it does.

**OpenClaw + Octopus is a consolidator.** Agentic coding tools (Claude Code, OpenAI Codex, Gemini CLI, Cursor, Copilot, OpenCode, OpenClaw ACP, any future tool) are **worker runtimes**. Octopus is the **supervisor / router / scheduler / bookkeeper** that drives them as a coordinated team. OpenClaw does all the messaging, routing, state, recovery, audit, policy, and operator surfaces. The harnesses do the actual coding work inside their assigned scope.

### Who owns what

| Concern                                                     | Owner                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Actual coding work (reading, editing, reasoning about code) | The harness assigned to the grip                       |
| Which harness gets which grip                               | Octopus scheduler + the agent decision guide           |
| Credentials for each harness                                | The harness itself — OpenClaw does not broker API keys |
| Tool execution inside the harness sandbox                   | The harness                                            |
| File / branch / port collision prevention across arms       | Octopus ClaimService                                   |
| Budget enforcement across the whole mission                 | Octopus Head                                           |
| Event log and audit trail                                   | Octopus EventLogService                                |
| Operator surfaces (CLI, slash, agent tools)                 | OpenClaw core + Octopus                                |
| Messaging in/out of chat channels                           | OpenClaw Gateway                                       |
| Node pairing and remote habitat trust                       | OpenClaw Gateway (existing device pairing)             |
| Recovery after crashes                                      | Octopus Head + Node Agent SessionReconciler            |
| Cost tracking across providers/models                       | Octopus CostRecord + mission budget                    |
| Persona (AGENTS.md / SOUL.md / USER.md)                     | OpenClaw agent — inherited by arms                     |
| Skills available to an arm                                  | OpenClaw skill loader — inherited from bound agent     |
| Policy ceiling (`tools.allow/deny`, sandbox)                | OpenClaw per-agent config — floor for every arm        |

Every row on the left is either "the harness" (narrow scope: the coding work) or "OpenClaw + Octopus" (everything around that work). There is no row where a harness is driving multi-arm orchestration — that is precisely the gap Octopus fills.

### Principle of user-equivalent operation

**Octopus drives external agentic coding tools the way a human user drives them.** This is the architectural center of gravity for the whole project. It predates the implementation details and it dominates every other tradeoff in the adapter layer.

Concretely: when Octopus runs Claude Code as an arm, it invokes `claude` the same way a developer at a terminal would — either via the interactive TUI (driven through PTY/tmux) or via Claude Code's own non-interactive CLI mode (`claude -p --output-format stream-json`). Same binary, same credentials, same session model, same output stream. The only difference is that the "user" sending keystrokes is a Node Agent instead of a person.

Why this matters:

- **Policy and ToS clarity.** Every major agentic coding tool is shipped and licensed as a developer CLI. A human-equivalent invocation is squarely within the intended use model. A programmatic protocol that bypasses the user-facing surface is in a less well-defined policy space and may be subject to tightening over time.
- **Durability.** CLIs are stable surfaces with long-lived UX contracts. Structured protocols (including ACP) are younger and more actively evolving — they will break under your feet more often.
- **Pluggability.** Any new agentic coding tool that ships as a CLI plugs in without writing harness-specific adapter code. We do not wait for vendors to implement any particular protocol before we can drive their tool.
- **Reattachability.** A human operator can `/octo attach` into a tmux session and literally see what the arm is doing in real time, as if they were sitting at the keyboard. This is the terminal-first posture the PRD committed to.

Per OCTO-DEC-036, PTY/tmux and `cli_exec` (structured-output CLI mode) are the **primary** runtimes for external agentic coding tools. ACP via `acpx` remains available as a runtime but is **not the default path** to Claude Code / Codex / Gemini / etc.

### Worker runtime pool

Four adapter types, in preference order for external agentic coding tools:

1. **`cli_exec`** — the tool is spawned as a subprocess and its own structured CLI output mode is consumed directly. Example: `claude -p --output-format stream-json "your prompt"`, `codex exec --json "your prompt"`. No PTY, no tmux — a regular `spawn()` with `stdout.on('data')`. This is the cleanest path when the tool supports it: user-equivalent invocation, structured events, clean cost tracking, simple supervision. **Preferred for any tool that offers a structured CLI output mode.**

2. **`pty_tmux`** — the tool is launched inside a tmux session via a PTY, and Octopus drives it interactively the way a human would drive the TUI. tmux provides durable session naming, reattach, and detach semantics. Output is captured as normalized byte streams. This is the universal fallback: any tool with an interactive terminal interface can be driven this way, with no vendor cooperation required. **Preferred for interactive TUI tools and any tool without a structured CLI mode.**

3. **`structured_subagent`** — OpenClaw's own native subagent runtime (`sessions_spawn` default). This is not wrapping an external tool — it is OpenClaw talking to its configured model provider directly under OpenClaw's own API terms. Used for work that fits OpenClaw's native agent loop and does not need an external harness.

4. **`structured_acp`** — ACP harnesses via the existing `acpx` plugin. **Available but not the default path** for external agentic coding tools per OCTO-DEC-036. Kept in the adapter layer so users who explicitly want ACP for a specific mission can opt in, and so that ACP-only runtimes (OpenClaw ACP, etc.) remain reachable.

A single mission can use any combination of these. Parallel grips with different runtimes work simultaneously in sibling worktrees, coordinated by claims.

### Pluggability: adding a new agentic coding tool

When a new tool ships — "Foo Coder", "Gemini Antigravity", "whatever comes next" — it enters the worker pool through one of these paths, in order of preference:

1. **The tool has a structured CLI output mode** (e.g. `foo -p --json "prompt"`). Use `cli_exec`. Register the tool's binary path and its structured output flag set in the mission spec. **Zero new adapter code; zero protocol coupling.** This is the ideal case and it is how we expect modern coding tools to be reached.

2. **The tool has an interactive TUI only.** Use `pty_tmux`. Launch it in a tmux session. Send keystrokes as input. Read normalized output bytes. Checkpoint via tmux's own session persistence. Again, zero new adapter code — the `PtyTmuxAdapter` is generic.

3. **The tool only exposes ACP and has no CLI.** Use `structured_acp` as an opt-in. This should be rare for agentic coding tools; most ship a CLI.

4. **The tool has no CLI, no TUI, and no structured protocol.** Out of scope — it cannot be driven by Octopus at all.

We do not take an opinion on which underlying tool is best. We let the user (or their agent) pick per grip, and the scheduler places work accordingly. The default preference order when the user doesn't specify is: `cli_exec` → `pty_tmux` → `structured_subagent` for native model work → `structured_acp` (only on explicit opt-in).

### Multi-harness mission — concrete example

A mission that uses three worker runtimes in one coordinated graph, driving each tool **as a user would**:

```json5
{
  title: "limn-api security audit + fix",
  owner: "whatsapp:+15555550123",
  budget: { cost_usd_limit: 40.0, on_exceed: "pause" },
  graph: [
    {
      grip_id: "g-audit",
      type: "security-audit",
      adapter_type: "structured_subagent",
      runtime_name: "openclaw-subagent",
      // OpenClaw's own native runtime — cheap, fast, read-only
      side_effecting: false,
    },
    {
      grip_id: "g-fix-py-services",
      type: "security-fix",
      depends_on: ["g-audit"],
      adapter_type: "cli_exec",
      runtime_name: "codex",
      runtime_options: {
        command: "codex",
        args: ["exec", "--json"],
        // Codex invoked as a user would — its own structured CLI mode
        initial_input: "{audit_artifact} — fix each issue in services/py, commit per fix",
      },
      worktree_path: "/repos/limn-api/worktrees/py-fix",
      required_claims: [{ type: "dir", key: "/repos/limn-api/services/py", mode: "exclusive" }],
      side_effecting: true,
    },
    {
      grip_id: "g-fix-ts-services",
      type: "security-fix",
      depends_on: ["g-audit"],
      adapter_type: "cli_exec",
      runtime_name: "claude-code",
      runtime_options: {
        command: "claude",
        args: ["-p", "--output-format", "stream-json"],
        // Claude Code invoked the same way a developer would — -p mode
        // is Claude Code's native non-interactive CLI; stream-json gives us
        // structured events for free without any ACP wrapper
        initial_input: "{audit_artifact} — fix each issue in services/ts",
      },
      worktree_path: "/repos/limn-api/worktrees/ts-fix",
      required_claims: [{ type: "dir", key: "/repos/limn-api/services/ts", mode: "exclusive" }],
      side_effecting: true,
    },
    {
      grip_id: "g-verify",
      type: "test-run",
      depends_on: ["g-fix-py-services", "g-fix-ts-services"],
      adapter_type: "pty_tmux",
      runtime_name: "tmux:bash",
      runtime_options: {
        command: "bash",
        args: ["-c", "npm test && pytest"],
        tmuxSessionName: "octo-g-verify",
      },
    },
  ],
}
```

What happens:

1. `g-audit` runs in OpenClaw's native subagent runtime — cheap, fast, read-only, produces an audit artifact. This is OpenClaw calling Anthropic directly under its own API terms.
2. `g-fix-py-services` launches Codex **the way a user would**: `codex exec --json "..."`. Its stdout stream is captured as normalized events. No ACP involved.
3. `g-fix-ts-services` launches Claude Code **the way a developer would**: `claude -p --output-format stream-json "..."`. Its stream-json output feeds directly into the event log. Again, no ACP involved.
4. Both fix grips run in parallel in sibling git worktrees. The ClaimService guarantees the Python grip cannot touch TypeScript files and vice versa (exclusive directory claims).
5. Token/cost metadata from both tools' structured output streams feeds into the same `CostRecord`. The $40 mission budget is enforced across both providers.
6. `g-verify` runs after both fix grips complete, in a tmux pane, running the test suite.
7. The user's agent subscribes to mission events and posts progress updates to WhatsApp throughout.

**Nothing in this mission reaches for ACP.** Claude Code and Codex are each driven through their own documented CLI surfaces, in the same way a human developer would run them from a terminal. This is the policy-safe, durable, user-equivalent invocation model — OCTO-DEC-036 is operationalized here.

At no point does Codex know Claude Code is on the team. At no point does Claude Code know Codex is on the team. Octopus is orchestrating them as peer contractors, and each tool thinks it's just running a normal CLI invocation. That isolation is by design — it means you get the full capability of each tool without them stepping on each other's assumptions, and you stay within each tool's intended use model.

If `g-fix-py-services` keeps failing, an operator can reassign:

```
openclaw octo grip reassign g-fix-py-services --runtime claude-code
```

Same mission, same budget, same claim, different CLI tool driven the same way. The audit artifact from `g-audit` is still the input.

### Fallback: pty_tmux when structured CLI isn't available

Not every coding tool has a structured output CLI mode. For a tool that only offers an interactive TUI, the same mission shape works — just swap `adapter_type: cli_exec` for `adapter_type: pty_tmux`. The tool is launched inside a tmux session; Octopus sends keystrokes to the TUI and reads output byte-by-byte. Cost metadata is approximated via the time-based proxy in CONFIG.md (`ptyHourlyRateProxyUsd`); success is determined by exit code plus worktree diff inspection rather than structured events.

The operator experience is arguably **better** with `pty_tmux` in one important way: `/octo attach <arm_id>` drops you directly into the tmux session, so you can literally watch the tool work in real time and take over the keyboard if needed. This is the full terminal-first story the PRD committed to.

### Value add over running harnesses directly

If you already have Claude Code, Codex, and Gemini installed, you can run them directly from the terminal today. What running them through Octopus adds:

- **Coordination** — claims on files, dirs, branches, ports prevent parallel agents from conflicting
- **Unified budget** — one cap spread across whichever providers do the work
- **Unified audit** — one event log covers everything; one `openclaw octo events --tail` shows the full story
- **Recovery** — Gateway crashes at 2am; you wake up and work has resumed where it left off, including in-flight ACP sessions via their resumable session ids
- **Handoff** — reassign a stuck grip from one harness to another without losing context
- **Natural language entry** — ask your agent to launch a mission from any channel OpenClaw serves
- **Automation entry** — cron, Task Flow, standing orders, hooks can all launch multi-harness missions
- **Single operator surface** — `openclaw octo arm list` shows every arm regardless of harness; `/octo attach` works whether it's tmux or ACP
- **Policy** — one `tools.allow/deny` + sandbox ceiling applies to every harness equally
- **Presence and observability** — arms show up in `openclaw status`; existing dashboards see missions via the mirrored Task Flow

Without Octopus you would be manually opening separate terminals for each harness, creating worktrees to avoid conflicts, separately tracking spend across providers, restarting anything that crashed, and writing your own script to aggregate status. With Octopus, all of that is the default.

### The mental model in one diagram

```
              ┌─────────────────────────────────────┐
              │  User / Agent / Cron / Hook / Flow  │
              └──────────────────┬──────────────────┘
                                 │
              ┌──────────────────▼──────────────────┐
              │  OpenClaw Gateway                   │
              │  - messaging                        │
              │  - routing & bindings               │
              │  - auth / pairing / device tokens   │
              │  - task ledger                      │
              │  - cron / hooks / Task Flow         │
              └──────────────────┬──────────────────┘
                                 │ octo.*  (method namespace)
              ┌──────────────────▼──────────────────┐
              │  Octopus Head                       │
              │  - mission graph                    │
              │  - scheduler + fairness             │
              │  - claims / leases                  │
              │  - event log + replay               │
              │  - budget + cost                    │
              │  - recovery + reconciliation        │
              │  - policy ceiling                   │
              └──────────────────┬──────────────────┘
                                 │
   ┌─────────────────┬───────────┴───────────┬─────────────────┐
   │  (preferred)    │  (preferred)          │  (native)       │  (opt-in)
   │                 │                       │                 │
┌──▼───────────┐ ┌───▼───────────┐ ┌─────────▼──────┐ ┌────────▼──────┐
│  cli_exec    │ │   pty_tmux    │ │   structured_  │ │  structured_  │
│              │ │               │ │   subagent     │ │  acp          │
│  claude -p   │ │ tmux + PTY    │ │                │ │               │
│  --output-   │ │ driving       │ │ OpenClaw's own │ │ acpx harness  │
│  format      │ │ interactive   │ │ native agent   │ │ (available,   │
│  stream-json │ │ TUIs like a   │ │ loop against   │ │  not default) │
│              │ │ user would    │ │ Anthropic      │ │               │
│  codex exec  │ │               │ │ directly       │ │               │
│  --json      │ │ "user at the  │ │                │ │               │
│              │ │  keyboard"    │ │ OpenClaw's     │ │               │
│  any tool    │ │  for any      │ │ own API terms  │ │               │
│  with a      │ │  terminal     │ │                │ │               │
│  structured  │ │  tool         │ │                │ │               │
│  CLI mode    │ │               │ │                │ │               │
└──────────────┘ └───────────────┘ └────────────────┘ └───────────────┘
```

**Preference order for external agentic coding tools:** `cli_exec` → `pty_tmux`. The left two boxes are the preferred paths — both are user-equivalent invocation. `structured_subagent` is primary for work that fits OpenClaw's own native runtime. `structured_acp` is available for users who explicitly want it but is not the default path to any external tool.

Everything **above** the dividing line between Head and the four worker boxes is OpenClaw's job (orchestration, messaging, state, recovery). Everything **below** is the worker runtime's job (the actual coding work). Octopus is the bridge that makes multiple tools behave as one coordinated team, and OpenClaw is the substrate that makes the whole thing reachable from the same surfaces users already know — chat, slash, CLI, cron, flows, hooks.

**The consolidator role in one sentence:** OpenClaw is the only place you need to look to understand, launch, supervise, pay for, recover, and audit coordinated agentic coding work, regardless of which underlying tool is doing the typing — and every external tool is driven the way its designers shipped it to be driven: as a CLI, by a user.

## Integration Principles

### 1. Feature-detect, do not assume

Never read OpenClaw internal state directly. Always go through a published surface: the Gateway WebSocket API, the `openclaw.json` config file, the `~/.openclaw/` state layout, the CLI, or `hello-ok.features`. When a feature's presence or shape is unclear, detect it and degrade gracefully.

### 2. One insulation module per upstream dependency

Every upstream touchpoint lives behind exactly one file in `src/octo/adapters/openclaw/`. The rest of Octopus talks to these bridges with stable internal interfaces. When OpenClaw changes, one file moves — not the whole codebase.

### 3. Versioned integration boundary

We declare a minimum supported OpenClaw version and maintain a compatibility matrix. Breaking upstream changes are pinned to version floors, not silently absorbed.

### 4. Minimal, upstream-able core changes

When Octopus needs OpenClaw to change (e.g., announcing `octo.*` in `hello-ok.features`, adding `/octo` slash commands), those changes are small, additive, and designed to be upstream-able. No forks, no patch-on-install.

### 5. Graceful degradation

Optional integration surfaces (memory backends, presence, channel bindings, MCP exposure) are detected at startup. Missing ones disable a feature cleanly instead of crashing.

### 6. Document the "why" of every dependency

Each insulation bridge has a header comment explaining: what it wraps, which version(s) tested, what's assumed stable, what's reached-around, and the rollback plan if upstream changes. Future maintainers inherit context, not just code.

---

## User-Facing Integration Surfaces

### 1. Agent tool surface

The single highest-leverage integration point. Every other OpenClaw capability is exposed to agents as a tool; Octopus must be the same or it will not get used from natural language.

#### Read-only tools (default allowlist)

These are in the default tool allowlist for any agent with Octopus enabled. They leak nothing beyond what `openclaw octo ... --json` already shows.

| Tool                | Wraps                   | Purpose                                                             |
| ------------------- | ----------------------- | ------------------------------------------------------------------- |
| `octo_status`       | `octo.status` WS method | Snapshot: active arms, queued grips, healthy nodes, mission count   |
| `octo_mission_list` | `octo.mission.list`     | List missions visible to the caller's agent id                      |
| `octo_mission_show` | `octo.mission.show`     | Mission detail including grip graph and current budget state        |
| `octo_arm_list`     | `octo.arm.list`         | Filter by mission, node, state, labels                              |
| `octo_arm_show`     | `octo.arm.show`         | Arm detail including current grip, lease, checkpoint, recent output |
| `octo_grip_list`    | `octo.grip.list`        | Grip detail with dependencies and status                            |
| `octo_events_tail`  | `octo.events.tail`      | Bounded event tail, filterable by entity                            |
| `octo_claims_list`  | `octo.claims.list`      | Current claims with owner and expiry                                |

#### Writer tools (opt-in, capability-gated)

Writer tools are **not** in the default allowlist. Enabling them requires explicit per-agent `tools.allow` opt-in in `openclaw.json` **and** the operator device token carrying the `octo.writer` capability.

| Tool                  | Wraps                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `octo_mission_create` | `octo.mission.create` | Create a mission from a template or inline `MissionSpec`. The agent is expected to run the preflight classifier (see LLD §Research-Driven Execution Pipeline, OCTO-DEC-039) and set `MissionSpec.execution_mode` before calling this tool. If the mode is research-first, the agent also pre-populates `MissionSpec.graph` with research/synthesis/design grips ahead of any implementation grips. |
| `octo_mission_pause`  | `octo.mission.pause`  | Pause a mission (no new grip assignment)                                                                                                                                                                                                                                                                                                                                                           |
| `octo_mission_resume` | `octo.mission.resume` | Resume a paused mission                                                                                                                                                                                                                                                                                                                                                                            |
| `octo_mission_abort`  | `octo.mission.abort`  | Abort a mission and terminate live arms                                                                                                                                                                                                                                                                                                                                                            |
| `octo_arm_spawn`      | `octo.arm.spawn`      | Spawn a new arm with an `ArmSpec`                                                                                                                                                                                                                                                                                                                                                                  |
| `octo_arm_send`       | `octo.arm.send`       | Send input to a live arm                                                                                                                                                                                                                                                                                                                                                                           |
| `octo_arm_terminate`  | `octo.arm.terminate`  | Terminate an arm with reason                                                                                                                                                                                                                                                                                                                                                                       |
| `octo_grip_reassign`  | `octo.grip.reassign`  | Move a grip to a different arm/node                                                                                                                                                                                                                                                                                                                                                                |

All writer tools require an `idempotency_key` parameter (reusing existing Gateway semantics) and are logged to the octo event log with the calling agent id and sender identity.

#### Tool schema reuse

Tool parameters are thin wrappers over the already-defined `ArmSpec`, `GripSpec`, and `MissionSpec` TypeBox schemas. Agents see the same schemas operators see. One source of truth.

#### Natural language routing guide

Octopus documentation ships an explicit decision guide for agents (written into the equivalent of `AGENTS.default.md`):

> **When to use Octopus vs subagents vs ACP:**
>
> - **Subagent** — one-shot background work that fits in a single run. "Research this topic and summarize."
> - **ACP** — delegating to an external coding harness for a single task. "Run this in Codex."
> - **Octopus** — multiple coordinated arms with shared state, long-running supervision, cross-node execution, or when any of {file claims, grip dependencies, duplicate-work prevention, mission budgets} matter. "Refactor the auth module across these 4 services and make sure they don't step on each other."
>
> Default: prefer subagents for simple fan-out. Upgrade to Octopus when the user says "mission," "in parallel with coordination," "keep supervising," "across these machines," or when the work has inter-task dependencies.

This guide lives in `docs/concepts/octo-agent-guide.md` in the installed docs tree.

### 2. In-chat operator surface — `/octo` slash commands

Operators on mobile need the same supervision surface the CLI provides. Slash commands follow existing OpenClaw conventions (`/subagents`, `/acp`, `/elevated`).

| Command                                  | Action                                                       |
| ---------------------------------------- | ------------------------------------------------------------ |
| `/octo status`                           | Status snapshot formatted for chat                           |
| `/octo missions`                         | List missions                                                |
| `/octo mission <id>`                     | Show a mission                                               |
| `/octo arms`                             | List arms                                                    |
| `/octo arm <id>`                         | Show an arm                                                  |
| `/octo arm kill <id>`                    | Terminate an arm (writer)                                    |
| `/octo attach <arm_id>`                  | Bind this thread to an arm so follow-up messages route to it |
| `/octo unattach`                         | Release the thread binding                                   |
| `/octo tail <arm_id> [--lines N]`        | Recent arm output                                            |
| `/octo events [--since time]`            | Recent events                                                |
| `/octo mission create <template> [args]` | Start a mission from a template (writer)                     |
| `/octo help`                             | Command help                                                 |

**Attach semantics** reuse the existing `/focus` / `/unfocus` thread-binding pattern from subagents. When a thread is attached to an arm, subsequent user messages in that thread are dispatched to the arm via `octo.arm.send` and the arm's output is streamed back to the thread.

Writer commands require the operator's device identity to be on the `octo.writer` allowlist (see §3). Non-writers get a structured permission error, not silent failure.

### 3. Operator authorization model — device-token capabilities, not `tools.elevated`

**Correction from earlier doc versions:** OpenClaw's `tools.elevated` is specifically about breaking a sandboxed agent out of its sandbox for `exec`. It is **not** a general authorization gate for destructive control-plane commands. Previous Octopus doc language that routed approvals "through the existing `tools.elevated` flow" was incorrect and is superseded here.

**The correct model:**

1. Every paired operator has a device token (existing Gateway behavior).
2. Device tokens may carry an `octo.writer` capability, granted during pairing approval.
3. Loopback-originated calls auto-grant `octo.writer` — preserving the existing same-host UX.
4. Side-effecting Octopus methods reject calls from tokens lacking `octo.writer` with a structured error.
5. Every side-effecting action is logged to the Octopus event log with the token identity.
6. Milestone 5 adds per-mission ownership delegation on top of this base.

This model is **additive** to the existing Gateway auth — no existing Gateway code changes, just a new capability string recognized in the connect handler.

### 4. Automation trigger surfaces

Octopus missions must be invokable from every existing OpenClaw automation mechanism without inventing a parallel scheduler.

#### Cron jobs

A cron entry in `openclaw.json` can target an Octopus mission template:

```json5
{
  cron: {
    jobs: [
      {
        id: "nightly-refactor-audit",
        schedule: "0 2 * * *",
        type: "octo.mission",
        template: "refactor-audit",
        args: { repo: "main", scope: "src/" },
        isolated: true,
      },
    ],
  },
}
```

The cron runtime dispatches to `octo.mission.create` at the scheduled time using the existing cron → task creation pipeline. The resulting mission carries `metadata.source: "cron"` and `metadata.cron_id`. Cron execution semantics (isolated session, timing, timezone) are unchanged; only the action is new.

#### Task Flow (formerly ClawFlow)

Task Flow is the existing flow orchestration layer above background tasks. Octopus integrates in two ways:

**Managed mode:** a Task Flow step can be `type: "octo.mission"` with an inline spec. Task Flow waits for mission completion and advances the flow on `mission.completed`.

**Mirrored mode:** an Octopus mission automatically creates a mirrored Task Flow record. This gives existing `openclaw tasks flow list` consumers a unified view of Octopus work without reimplementing flow tracking. Mission state changes propagate to the mirrored flow as events.

Mirrored mode is the more durable option — it lets OpenClaw's existing flow UIs, dashboards, and tools see missions as first-class flows without any upstream awareness of Octopus.

#### Standing orders

Standing orders can reference a mission template. When the trigger fires, the standing order handler calls `octo.mission.create` with the template and carries `metadata.source: "standing_order"`.

#### Hooks

Hook handlers can be marked `handler: "octo.mission.create"` with a template. This lets existing hook triggers (file changes, webhook events, scheduled windows) launch missions without custom code.

#### Taskflow action type

A new Task Flow step type `octo.arm.spawn` supports single-arm delegation as a step, for cases where a full mission is overkill.

#### Mission templates

Templates live at `~/.openclaw/octo/templates/*.json5` and are parameterized `MissionSpec` documents. The template loader validates against the TypeBox schema at registration time. Templates are discoverable via `openclaw octo templates list`.

### 5. Client feature detection via `hello-ok.features.octo`

The existing Gateway handshake returns `hello-ok.features.methods` — a discovery list built from `src/gateway/server-methods-list.ts` plus plugin exports (per the existing Gateway protocol doc). Octopus extends this with a structured `features.octo` block:

```json
{
  "hello-ok": {
    "features": {
      "methods": ["...", "octo.arm.spawn", "octo.mission.create", "..."],
      "events": ["...", "octo.arm.state", "..."],
      "octo": {
        "version": "1",
        "enabled": true,
        "adapters": ["structured_subagent", "structured_acp", "pty_tmux"],
        "acpHarnesses": ["codex", "claude", "cursor", "gemini", "opencode", "openclaw"],
        "capabilities": {
          "missionBudgets": true,
          "worktreeClaims": true,
          "forwardProgressWatchdog": true
        }
      }
    }
  }
}
```

**Clients must check `features.octo.enabled` before showing Octopus UI.** Clients that predate Octopus simply never see the block and render unchanged. Clients that know about Octopus but run against an older Gateway see `features.octo` absent and hide their Octopus UI.

This is the durable pattern: no hard version pinning, no runtime errors on old Gateways — just capability negotiation.

### 6. MCP exposure

OpenClaw ships `openclaw mcp serve` for exposing Gateway functionality as an MCP server. Octopus methods surface through MCP automatically when their WS method names are registered — no separate MCP plumbing is required because the existing MCP bridge forwards registered methods.

This means external tools (Claude Code, Cursor, an IDE) can spawn and supervise Octopus arms via MCP without any Octopus-specific work on the MCP side. If `openclaw mcp serve` ever moves to a method-allowlist model, Octopus methods will need to be added to that allowlist — tracked in §Upstream Change Playbook.

### 7. SOUL/AGENTS/USER persona inheritance

An arm runs under a bound OpenClaw agent id. By default it inherits the agent's persona files exactly as a subagent does:

- `AGENTS.md` — shared operating instructions
- `SOUL.md` — personality
- `USER.md` — user-specific context

**Mission override:** a mission may supply `mission.persona_overlay` with patch-style replacements. Overlays are additive: the agent's files are the base, and the overlay is prepended as a system note identifying the mission. This lets a mission say "act as a refactoring specialist for this work" without rewriting the agent.

**Arms do not read persona files from disk themselves.** The Head Controller resolves the overlay + agent files at arm spawn time and passes the merged context to the adapter via `ArmSpec.initial_input` or the runtime-specific equivalent. This isolates Octopus from any future change in how OpenClaw locates or formats persona files.

### 8. Memory backend inheritance

Arms inherit their bound agent's `memory.backend` configuration unchanged. No memory configuration is reimplemented in Octopus.

- **Read paths:** arms use the agent's existing memory read surface (`sessions_history`, QMD search, honcho, builtin) via the adapter. The adapter calls are unchanged from existing subagent behavior.
- **Write paths:** arm transcripts write into the agent's existing session store at the existing path.
- **Cross-mission memory:** missions do not have their own memory layer. Cross-mission context lives in the Octopus event log and the artifact index — not in a new memory backend.

If OpenClaw adds new memory backends, Octopus inherits them for free because it never touches memory directly — it just calls the agent's existing memory tools.

### 9. Skills inheritance

Arms inherit the bound agent's effective skill allowlist. The existing skill loader (`~/.openclaw/skills` + per-agent roots + allowlists) is called unchanged. Octopus does not maintain a separate skill registry.

Per-arm narrowing is allowed but is a **filter**, not a new skill source. An ArmSpec can specify `skills_filter: ["skill_a", "skill_b"]` to restrict the arm to a subset of the agent's skills. It cannot add skills the agent doesn't already have.

### 10. Presence emission

Active arms register with OpenClaw's existing presence layer so `openclaw status` and presence events include them.

Emission is one-way: Octopus writes arm presence; it does not read presence to make decisions. This asymmetry means that if OpenClaw changes the presence event schema, Octopus only loses visibility, not correctness — and a single bridge file updates to fix it.

If the presence layer is unavailable or absent, presence emission is a no-op. Octopus functions without it.

### 11. Sandbox scope defaults

By default, arms inherit their bound agent's `sandbox.scope`:

- `sandbox.scope: "agent"` → all arms under that agent share one container
- `sandbox.scope: "shared"` → arms use the shared container
- `sandbox.mode: "off"` → arms run on host

A mission or arm may **narrow** the scope but never widen it. An arm can opt into its own container with `ArmSpec.sandbox_override.scope: "arm"` which creates a per-arm container within the agent's policy envelope. Widening is rejected at spec validation.

### 12. Channel bindings for mission threads

Existing OpenClaw bindings route inbound messages from channels to agents. Octopus extends this at the agent level, not the binding level.

**Pattern:** when `/octo attach <arm_id>` is run in a thread, the agent stores a thread→arm_id map. Subsequent messages in that thread are intercepted by the agent's message handler and dispatched to the arm via `octo.arm.send`. The binding configuration in `openclaw.json` is unchanged.

This avoids touching the binding system entirely, which is a complex and actively evolving surface. If bindings change upstream, Octopus is unaffected.

### 13. Logging destination

Octopus logs route through the existing OpenClaw logging framework. Structured fields defined in OBSERVABILITY.md (`subsystem: "octo"`, `component`, `arm_id`, etc.) pass through the existing logger with no custom transport. Log files, redaction, rotation, and tail surfaces are inherited.

### 14. First-run and doctor

Two new CLI commands, following the existing `openclaw acp doctor` / `openclaw doctor` pattern:

**`openclaw octo init`** — interactive setup wizard:

1. Confirm feature flag turn-on
2. Show resolved `octo:` config block with defaults
3. Create `~/.openclaw/octo/` state directories
4. Verify tmux is installed (warn if missing — PTY adapter needs it)
5. Probe that structured adapters (subagent, acpx) are available
6. Offer to install a sample mission template
7. Run `octo doctor` at the end

**`openclaw octo doctor`** — health check:

- Feature flag state
- State path writability
- SQLite registry health
- Event log integrity (last 100 events replay clean)
- Tmux availability and version
- Subagent and ACP adapter readiness (via existing `/acp doctor` equivalent checks)
- Agent ceiling permissiveness for the default agent id
- `hello-ok.features.octo` advertisement visible to a loopback client
- Structured diagnostic output with severity classification

Doctor is idempotent, read-only, and safe to run at any time.

### 15. Docs tree placement

Octopus docs land in the existing installed docs tree at these paths:

- `docs/concepts/octo.md` — conceptual overview, this integration story
- `docs/concepts/octo-agent-guide.md` — the agent decision guide (§1)
- `docs/tools/octo-tools.md` — the agent tool surface reference
- `docs/cli/octo.md` — CLI reference
- `docs/automation/octo-missions.md` — trigger integration (cron, Task Flow, standing orders, hooks)
- `docs/reference/octo-architecture.md` — condensed HLD/LLD derivative for end-user reference

Source of truth remains in this workspace's PRD/HLD/LLD set; the `docs/` tree is the operator-facing derivative.

### 16. Plugin vs core

Octopus ships as **core**, not a plugin. Rationale:

- Adapter layer has deep cross-cutting dependencies on subagent and ACP runtimes that already live in core.
- Feature flag + empty scaffold makes it safe to ship disabled.
- Plugin APIs are a younger, more actively evolving surface; building on them would _increase_ upstream coupling risk, not decrease it.

If the plugin API matures and stabilizes past Milestone 5, a follow-up decision can move Octopus to a bundled plugin without changing its user surface.

### 17. Node Agent onboarding for remote habitats

Remote habitats reuse the existing OpenClaw node pairing flow:

1. On the remote machine: `openclaw octo node register --head <head-url>` (new command)
2. This invokes the existing device pairing handshake against the target Gateway, adding `role: node` and `caps.octo` to the connect payload
3. The operator on the Head side approves the pairing via the existing pairing UI (or `openclaw pairing approve`)
4. On approval, the Gateway issues a device token with `octo.writer` if approved
5. The remote Node Agent starts, registers its capability manifest, and appears in `openclaw octo node list`

**Zero new credential or pairing infrastructure.** The only new bits are the CLI wrapper (convenience) and the connect-payload extension. Both are additive.

---

## Upstream Compatibility Matrix

Octopus declares a minimum supported OpenClaw version at release time and is tested against each subsequent version.

```
Supported:      >= 2026.4.0  (hypothetical; set at M0 exit)
Known working:  2026.4.0, 2026.5.x, 2026.6.x
Floor reason:   hello-ok.features plugin exports, Task Flow mirrored mode
```

Compatibility is tracked in `COMPATIBILITY.md` (a new file created at M0 exit, not yet written) and validated by integration tests that run against each supported version.

When Octopus detects a lower version at runtime (via `hello-ok.protocol` or a version probe), it refuses to enable and logs a structured error naming the minimum required version. No partial operation.

---

## Upstream Dependency Classification

Each upstream surface Octopus touches is classified:

| Surface                          | Stability    | Insulation                                 | If it changes                                                               |
| -------------------------------- | ------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| Gateway WS transport             | **stable**   | `wire/gateway-handlers.ts`                 | Update handler registration; wire format is versioned                       |
| Device pairing + tokens          | **stable**   | none needed                                | Core identity; would be a major OpenClaw version bump                       |
| `openclaw.json` top-level schema | **stable**   | `config/octo-config.ts`                    | Our block is self-contained                                                 |
| `~/.openclaw/` state layout      | **stable**   | `config/octo-config.ts`                    | We own `octo/` subdir                                                       |
| CLI conventions                  | **stable**   | `cli/*`                                    | Purely ours                                                                 |
| `hello-ok.features`              | **moderate** | `adapters/openclaw/features-advertiser.ts` | Update advertiser; clients feature-detect                                   |
| `sessions_spawn` parameters      | **moderate** | `adapters/openclaw/sessions-spawn.ts`      | Bridge maps old/new param names; schema version recorded per call           |
| Background task ledger           | **moderate** | `adapters/openclaw/task-ledger.ts`         | `task_ref` is a weak pointer; dereference failures are tolerated            |
| ACP / `acpx` runtime             | **moderate** | `adapters/openclaw/acpx-bridge.ts`         | Harness set is feature-detected; missing harnesses degrade cleanly          |
| Skills loader                    | **moderate** | `adapters/openclaw/skills-loader.ts`       | Inheritance only; no direct allowlist rewriting                             |
| Memory backends                  | **moderate** | `adapters/openclaw/memory-bridge.ts`       | We only read the agent's existing tools; backend changes are transparent    |
| Task Flow schema                 | **moderate** | `adapters/openclaw/taskflow-bridge.ts`     | Mirrored mode is observer-only; breakage is visibility loss, not state loss |
| Slash command handler            | **moderate** | `cli/slash-commands.ts`                    | Our handlers are self-registered; upstream changes affect registration only |
| Presence layer                   | **unstable** | `adapters/openclaw/presence-bridge.ts`     | Emission is one-way; absence disables a feature, not the system             |
| Channel bindings                 | **unstable** | intentionally not used                     | Thread→arm maps live in agent handler state, not bindings                   |
| MCP server internals             | **unstable** | intentionally not extended                 | Auto-exposure via method registration; never touching internals             |

**Stability definitions:**

- **stable** — architectural identity of OpenClaw; changes here are major version bumps and well-signaled
- **moderate** — documented public surfaces that have evolved over recent releases and likely will again
- **unstable** — actively developed or less-documented surfaces; coupling is avoided unless the value is high

---

## Upstream Change Playbook

When OpenClaw upstream changes a surface Octopus depends on, use this playbook.

### Detection

1. **Compatibility integration tests** run on every new OpenClaw version. These are the first line.
2. **Schema version probes** in each bridge record the OpenClaw version seen and raise an anomaly on unexpected shapes.
3. **`openclaw octo doctor`** catches runtime-visible changes (missing method, wrong capability, absent feature).
4. **CHANGELOG review** on every OpenClaw release — added to the Octopus release process as a manual checklist item.

### Response template

For each detected change:

1. Identify which bridge file owns the surface.
2. Update the bridge, never the downstream callers.
3. Bump the bridge's `tested_against` version comment.
4. Add a regression test capturing the pre- and post-change shapes.
5. If the change is not backward compatible, bump the Octopus minimum supported version and update `COMPATIBILITY.md`.

### Worked example: `clawflow` → `taskflow` rename

OpenClaw renamed ClawFlow to Task Flow. Any Octopus code depending on a `clawflow` module name or command would break silently on the rename.

**How Octopus survives this:**

1. All references go through `adapters/openclaw/taskflow-bridge.ts`.
2. The bridge imports by documented CLI verbs (`openclaw tasks flow ...`), not module paths.
3. If a future rename happens again, one file changes.
4. The rename itself is detected by a compat test that invokes `openclaw tasks flow list` and asserts the subcommand exists.

**What we explicitly do not do:** reference old names in Octopus docs, code, or config. Only the bridge file may carry transitional compatibility shims, and those shims are time-bounded (remove after two Octopus releases).

### Worked example: `sessions_spawn` parameter addition

If OpenClaw adds a new parameter to `sessions_spawn` (e.g., new model options), Octopus should not need to change unless we want to expose it.

**How Octopus survives this:**

1. `sessions-spawn.ts` bridge calls the runtime with an explicit allowlist of parameters it knows about.
2. Unknown parameters in caller-supplied `ArmSpec.runtime_options` are passed through transparently.
3. The bridge logs a warning when it sees a runtime that declares a newer parameter schema than the bridge version; operators can upgrade Octopus at their pace.
4. Adding support for a new parameter is: update the bridge allowlist + update the `ArmSpec.runtime_options` TypeBox schema. Downstream callers untouched.

### Worked example: `hello-ok.features` shape change

If OpenClaw restructures `hello-ok.features`, Octopus feature advertisement could break.

**How Octopus survives this:**

1. `features-advertiser.ts` writes to the current schema; reads through the structured wrapper.
2. Clients always check `features.octo?.enabled === true` before assuming anything — defensive reads.
3. If the top-level shape changes, one file updates advertisement; clients that followed the defensive read pattern continue to degrade cleanly.

---

## Required Upstream Changes

The following are minimal, additive, upstream-able changes Octopus needs in OpenClaw core. Each is designed to be a small PR against the OpenClaw repo, not a fork.

| Change                                                      | File (approximate)                   | Reason                                         |
| ----------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| Register `octo.*` methods in `server-methods-list.ts`       | `src/gateway/server-methods-list.ts` | So `hello-ok.features.methods` advertises them |
| Add `features.octo` builder                                 | `src/gateway/features.ts`            | Structured feature descriptor                  |
| Accept `caps.octo` on `role: node` connect                  | `src/gateway/connect-handler.ts`     | Node capability declaration                    |
| Recognize `octo.writer` in device token capability set      | `src/gateway/pairing.ts`             | Writer capability pairing                      |
| Dispatch `/octo` slash commands                             | `src/chat/slash-command-router.ts`   | In-chat operator surface                       |
| Cron job type `octo.mission`                                | `src/cron/job-types.ts`              | Cron trigger integration                       |
| Task Flow step type `octo.mission` + mirrored-mode observer | `src/taskflow/step-types.ts`         | Flow integration                               |
| Hook handler `octo.mission.create`                          | `src/hooks/handlers.ts`              | Hook trigger integration                       |
| `octo.enabled` config loader key                            | `src/config/schema.ts`               | Feature flag plumbing                          |
| `openclaw octo ...` CLI dispatch                            | `src/cli/command-registry.ts`        | CLI integration                                |
| Agent tool registration for `octo_*` tools                  | `src/tools/registry.ts`              | Agent tool surface                             |

All of these are registration points, not behavioral changes. Each can be individually PR'd to OpenClaw. None require changes to existing code paths, only additions.

**Octopus does not fork OpenClaw. Octopus does not patch-on-install.** If any required change cannot land upstream, that is a go/no-go signal for the project, not a reason to maintain a fork.

---

## First-Class Citizenship Checklist

At Milestone 2 exit (when `octo.enabled` defaults to `true`), all of these must be true:

- [ ] Agent tools registered in the default tool registry
- [ ] `/octo` slash commands dispatched by the chat router
- [ ] `hello-ok.features.octo` advertised by the Gateway handshake
- [ ] Cron job type `octo.mission` functional
- [ ] Task Flow mirrored mode creates flow records for every mission
- [ ] Standing orders can launch missions
- [ ] Hooks can launch missions
- [ ] `openclaw octo init` + `openclaw octo doctor` shipped
- [ ] Octopus docs present in the installed docs tree at the paths in §15
- [ ] Logs route through the existing OpenClaw logging framework
- [ ] Presence emission working
- [ ] Arms inherit persona files, skills, memory backend, sandbox scope
- [ ] MCP auto-exposure working via existing `openclaw mcp serve`
- [ ] `openclaw status` shows octopus in its summary
- [ ] `openclaw agents list --bindings` unchanged (no new bindings added)
- [ ] Remote node registration via existing pairing flow
- [ ] All compatibility integration tests pass against the current OpenClaw release

If any item is not true, Octopus is a subsystem with a CLI, not a first-class OpenClaw citizen. Milestone 2 cannot exit until all items are checked.

---

## Related

- HLD §OpenClaw Integration Foundation, §Code layout and module boundaries, §Operator authorization
- LLD §Head↔Node Agent Wire Contract, §Operator Surfaces
- CONFIG.md — `octo:` block defaults
- DECISIONS.md — OCTO-DEC-002/003/004/016/024/027 and the new 28+ entries threaded from this pass
- OpenClaw docs (upstream): `/concepts/architecture`, `/gateway/protocol`, `/tools/subagents`, `/tools/acp-agents`, `/automation/taskflow`, `/automation/tasks`, `/automation/cron-jobs`, `/automation/standing-orders`, `/automation/hooks`
