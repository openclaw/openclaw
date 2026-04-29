---
summary: "Design proposal for a public OpenClaw app SDK for agent runs, sessions, tasks, artifacts, and managed environments"
title: "OpenClaw SDK design"
read_when:
  - You are designing or implementing a public OpenClaw app SDK
  - You are comparing OpenClaw agent APIs with Cursor, Claude Agent SDK, OpenAI Agents, Google ADK, OpenCode, Codex, or ACP
  - You need to decide whether a feature belongs in the public app SDK, plugin SDK, Gateway protocol, ACP backend, or managed environment layer
---

This page is a design proposal for a future public **OpenClaw app SDK**. It is
separate from the existing [plugin SDK](/plugins/sdk-overview).

The plugin SDK is for code that runs inside OpenClaw and extends providers,
channels, tools, hooks, and trusted runtimes. The app SDK should be for
external applications, scripts, dashboards, CI jobs, IDE extensions, and
automation systems that want to run and observe OpenClaw agents through a stable
public API.

## Status

Draft architecture.

This document captures the design direction from a comparative review of these
agent SDK and runtime surfaces:

| Project             | Useful lesson                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor SDK cookbook | Best high-level product API: `Agent`, `Run`, local and cloud runtimes, streaming, cancellation, model discovery, repositories, artifacts, and cloud pull request flows.    |
| Claude Agent SDK    | Strong bidirectional session client, interrupt and steer support, permission modes, hooks, custom tools, session stores, and resumable transcripts.                        |
| OpenAI Agents SDK   | Strong workflow concepts: handoffs, guardrails, human approvals, tracing, run state, streaming result objects, and resume after interruptions.                             |
| Google ADK          | Strong internal architecture: runner, session service, memory service, artifact service, credential service, plugins, event actions, and long running tool confirmations.  |
| OpenCode            | Strong client/server shape: generated API client, REST plus SSE, sessions, workspaces, worktrees, permissions, questions, files, VCS, PTY, tools, agents, skills, and MCP. |
| Codex               | Strong local runtime boundary: approvals, sandboxing, network policy, local and remote exec servers, structured protocol events, and thread aware app-server sessions.     |
| ACP and acpx        | Strong interoperability layer for external coding harnesses with named sessions, prompt queues, cooperative cancellation, and runtime adapters.                            |

The recommendation is to build a Cursor-simple public facade on top of an
OpenCode-style generated Gateway client, while keeping Claude, OpenAI Agents,
ADK, Codex, and ACP concepts as internal design references where they fit.

## Goals

- Give app developers a tiny high-level API for running OpenClaw agents.
- Keep local-first OpenClaw as the default runtime.
- Make cloud or managed environments an additive environment provider, not a
  different agent API.
- Preserve existing OpenClaw boundaries: Gateway owns public protocol, plugin
  SDK owns in-process extensions, ACP owns external harness interop.
- Support `stream`, `wait`, `cancel`, `resume`, `fork`, artifacts, approvals,
  and background tasks as first-class operations.
- Expose stable normalized events while preserving runtime-native raw events for
  advanced consumers.
- Make SDK permissions, secret forwarding, approvals, sandboxing, and remote
  environments explicit.
- Keep the public contract small enough to document, test, version, and
  generate.

## Non goals

- Do not expose `openclaw/plugin-sdk/*` as the app SDK.
- Do not make ACP the only runtime model.
- Do not require a cloud service before the SDK is useful.
- Do not clone Cursor, Claude, OpenAI, ADK, OpenCode, Codex, or ACP APIs
  exactly.
- Do not expose unbounded `any` event payloads as the only public contract.
- Do not promise sandbox or network isolation for an external harness unless
  the selected environment can actually enforce it.
- Do not make plugin authors depend on app SDK objects inside plugin runtime
  code.

## Current OpenClaw fit

OpenClaw already has most of the substrate:

| Existing surface                                    | What it contributes                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [Agent loop](/concepts/agent-loop)                  | `agent` and `agent.wait` run lifecycle, streaming, timeout, and session serialization.                                     |
| [Agent runtimes](/concepts/agent-runtimes)          | Provider, model, runtime, and channel separation.                                                                          |
| [ACP agents](/tools/acp-agents)                     | External harness sessions for Claude Code, Cursor, Gemini CLI, OpenCode, explicit Codex ACP, and similar tools.            |
| [Background tasks](/automation/tasks)               | Detached activity ledger for ACP, subagents, cron, CLI operations, and async media jobs.                                   |
| [Sub-agents](/tools/subagents)                      | Isolated background agent runs, optional forked context, delivery back to requester sessions.                              |
| [Agent harness plugins](/plugins/sdk-agent-harness) | Trusted native runtime registration for embedded harnesses such as Codex.                                                  |
| Gateway protocol schemas                            | Current typed method and event definitions for agent params, sessions, subscriptions, aborts, compaction, and checkpoints. |

The gap is not agent execution. The gap is a stable, friendly public facade over
these pieces.

## Core model

The app SDK should use a small set of durable nouns.

| Noun          | Meaning                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OpenClaw`    | Client entry point. Owns Gateway discovery, auth, low-level client access, and namespace factories.                        |
| `Agent`       | Configured actor. Carries agent id, default model, default runtime, default tool policy, and app-facing helpers.           |
| `Session`     | Durable transcript, routing, workspace, context, and runtime binding.                                                      |
| `Run`         | One submitted turn or task. Streams events, waits for result, cancels, and exposes artifacts.                              |
| `Task`        | Detached or background activity ledger entry. Covers subagents, ACP spawns, cron jobs, CLI runs, and async jobs.           |
| `Artifact`    | Files, patches, diffs, media, logs, trajectories, pull requests, screenshots, and generated bundles.                       |
| `Environment` | Where the run executes: local Gateway, local workspace, node host, ACP harness, managed runner, or future cloud workspace. |
| `ToolSpace`   | The effective tool surface: OpenClaw tools, MCP servers, channel tools, app tools, approval rules, and tool metadata.      |
| `Approval`    | Human or policy decision requested by a run, tool, environment, or harness.                                                |

These nouns map cleanly to existing OpenClaw concepts but avoid leaking
implementation-specific names such as PI runner internals, plugin harness
registration, or ACP adapter details.

## Product shape

The high-level SDK should feel like this:

```typescript
import { OpenClaw } from "@openclaw/sdk";

const oc = new OpenClaw({ gateway: "auto" });
const agent = await oc.agents.get("main");

const run = await agent.run({
  input: "Review this pull request and suggest the smallest safe fix.",
  model: "openai/gpt-5.5",
});

for await (const event of run.events()) {
  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  }
}

const result = await run.wait();
console.log(result.status);
```

The same app should be able to use a durable session:

```typescript
const session = await oc.sessions.create({
  agentId: "main",
  label: "release-review",
});

const run = await session.send("Prepare release notes from the current diff.");
await run.wait();
```

Current implementation note: `@openclaw/sdk` starts with the Gateway-backed
surface that exists today. Provider-qualified model refs such as
`openai/gpt-5.5` are split into Gateway `provider` and `model` overrides.
Per-run `workspace`, `runtime`, `environment`, and `approvals` selections are
still design targets; the client throws when callers set them so requests do not
silently execute with defaults. Task, artifact, environment, and generic tool
invocation helpers are also scaffolded as future API shape and throw explicit
unsupported errors until Gateway RPCs exist for them.

And the same API should be able to use an external ACP harness:

```typescript
const run = await oc.runs.create({
  input: "Deep review this repository and return only high-risk findings.",
  workspace: { cwd: process.cwd() },
  runtime: { type: "acp", harness: "claude" },
  mode: "task",
});
```

Managed environments should not change the top-level API:

```typescript
const run = await agent.run({
  input: "Run the full changed gate and summarize failures.",
  workspace: { repo: "openclaw/openclaw", ref: "main" },
  runtime: {
    type: "managed",
    provider: "testbox",
    timeoutMinutes: 90,
  },
});
```

## Runtime selection

The app SDK should expose runtime selection as a normalized union:

```typescript
type RuntimeSelection =
  | "auto"
  | { type: "embedded"; id: "pi" | "codex" | string }
  | { type: "cli"; id: "claude-cli" | string }
  | { type: "acp"; harness: "claude" | "cursor" | "gemini" | "opencode" | string }
  | { type: "managed"; provider: "local" | "node" | "testbox" | "cloud" | string };
```

Rules:

- `auto` follows OpenClaw runtime selection rules.
- `embedded` targets trusted in-process harnesses registered through the plugin
  SDK, such as `pi` or `codex`.
- `cli` targets OpenClaw-owned CLI backend execution where available.
- `acp` targets external harnesses through ACP/acpx.
- `managed` targets an environment provider and may still run an embedded,
  CLI, or ACP runtime inside that environment.

The runtime selection object should be descriptive. It should not be the place
where secret handling, sandbox policy, or workspace provisioning hides.

## Environment model

The environment is the execution substrate. It should be explicit because local
CLI runs, external harnesses, node hosts, and cloud workspaces have different
safety and lifecycle properties.

```typescript
type EnvironmentSelection =
  | { type: "local"; cwd?: string }
  | { type: "gateway"; url?: string; cwd?: string }
  | { type: "node"; nodeId: string; cwd?: string }
  | { type: "managed"; provider: string; repo?: string; ref?: string }
  | { type: "ephemeral"; provider: string; repo?: string; ref?: string };
```

The environment owns:

- checkout or workspace preparation
- process and file access
- sandbox and network enforcement
- environment variables and secret references
- logs, traces, and artifacts
- cleanup and retention
- runtime availability

This separation makes managed agents a natural extension of the SDK. A managed
agent is a normal run in a managed environment, not a special product fork.

The detailed namespace, event, result, approval, artifact, security, package,
and environment provider contracts live in
[OpenClaw SDK API design](/reference/openclaw-sdk-api-design).

## Cookbook plan

The SDK should ship with a cookbook, not just reference docs.

Recommended examples:

| Example                      | Shows                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Quickstart                   | Create client, run an agent, stream output, wait for result.                                 |
| Coding agent CLI             | Local workspace, model picker, cancellation, approvals, JSON output.                         |
| Agent dashboard              | Sessions, runs, background tasks, artifacts, event replay, status filters.                   |
| App builder                  | Agent edits a workspace while a preview server runs beside it.                               |
| Pull request reviewer        | Run against a repository ref, collect diff comments and artifacts.                           |
| Approval console             | Subscribe to approvals and answer them from a UI.                                            |
| ACP harness runner           | Run Claude Code, Cursor, Gemini CLI, or OpenCode through ACP using the same `Run` API.       |
| Managed environment provider | Minimal provider that prepares a workspace, streams events, saves artifacts, and cleans up.  |
| Slack or Discord bridge      | External app receives events and posts progress summaries without becoming a channel plugin. |
| Multi-agent research         | Spawn parallel runs, collect artifacts, and synthesize a final report.                       |

Cookbook examples should use the high-level API first. Low-level generated
client examples belong in an advanced section.

## Phased implementation

### Phase 0: RFC and vocabulary

- Agree on public nouns and names.
- Decide package names.
- Define the first event taxonomy.
- Mark the current plugin SDK as intentionally separate in docs.

### Phase 1: Low-level generated client

- Generate a TypeScript client from Gateway protocol schemas.
- Cover `agent`, `agent.wait`, sessions, subscriptions, aborts, and tasks first.
- Add smoke tests that generated methods match Gateway method names and schema
  shapes.
- Publish as experimental or internal package.

### Phase 2: High-level run API

- Add `OpenClaw`, `Agent`, `Session`, and `Run`.
- Support `run.events()`, `run.wait()`, and `run.cancel()`.
- Support local Gateway discovery and explicit Gateway URLs.
- Support durable sessions and session send.

### Phase 3: Normalized event projection

- Add Gateway-side normalized event projection beside existing raw events.
- Preserve raw runtime events where policy allows.
- Add replay cursors and reconnect behavior.
- Map PI, Codex, ACP, and task events into the stable taxonomy.

### Phase 4: Artifacts and approvals

- Add artifact listing and download.
- Add approval subscription and response helpers.
- Add question subscription and response helpers.
- Add cookbook approval console.

### Phase 5: Environment providers

- Introduce local, node, and managed environment provider contracts.
- Start with an environment that already exists operationally.
- Add workspace preparation, logs, artifacts, timeout, cleanup, and retention.

### Phase 6: Cloud style workflows

- Add repository and branch oriented runs.
- Add pull request artifacts.
- Add run boards grouped by repo, branch, status, and assignee.
- Add long-running managed sessions and retention policy.

## Design choices to copy

Copy these ideas:

- From Cursor: `Agent` plus `Run`, local and cloud symmetry, model discovery,
  artifacts, and cookbook-driven onboarding.
- From Claude Agent SDK: bidirectional clients, interrupt, permissions, hooks,
  custom tools, session stores, and resume semantics.
- From OpenAI Agents: handoffs, guardrails, human approval resume, tracing, and
  structured streamed result objects.
- From Google ADK: services behind runner, event actions, memory, artifacts,
  credential services, and plugin interception around run lifecycle.
- From OpenCode: generated protocol client, REST plus SSE, sessions,
  workspaces, questions, permissions, files, VCS, PTY, MCP, agents, and skills.
- From Codex: explicit sandbox, approval, network, local and remote exec, and
  app-server thread boundaries.
- From ACP and acpx: adapter based external harness interoperability and named
  prompt queues.

## Design choices to avoid

Avoid these traps:

- A public SDK that is just a thin dump of Gateway internals.
- A public SDK that imports plugin SDK subpaths.
- A public SDK where events are only `stream` plus `data`.
- A cloud-first API that makes local OpenClaw feel like a legacy mode.
- Runtime selection hidden in model id prefixes.
- Secret forwarding hidden in environment maps.
- ACP specific options at the top level of every run.
- Sandbox flags that cannot be enforced by the chosen runtime.
- One SDK object that tries to be provider plugin, channel plugin, app client,
  and managed runner at once.

## Open questions

- Should the initial package live in this repo or a separate SDK repo?
- Should the generated low-level client be published publicly before the
  high-level wrapper stabilizes?
- What is the first supported app auth mechanism: local token, admin token,
  OAuth device flow, or signed app registration?
- How much session message history should the SDK expose by default?
- Should managed environments be configured only in Gateway config, or can SDK
  callers request them directly with scoped tokens?
- What retention rules apply to artifacts generated by local runs?
- Which event payloads require redaction before app delivery?
- Should `Run` cover normal chat turns and detached tasks, or should detached
  background work always return a `Task` wrapper with a nested `Run`?

## Related docs

- [Agent loop](/concepts/agent-loop)
- [Agent runtimes](/concepts/agent-runtimes)
- [Session](/concepts/session)
- [Sub-agents](/tools/subagents)
- [Background tasks](/automation/tasks)
- [ACP agents](/tools/acp-agents)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Plugin SDK overview](/plugins/sdk-overview)
