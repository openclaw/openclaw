---
summary: "Layered filesystem capability model for agent isolation, scratch storage, and safe host file operations"
read_when:
  - Designing agent filesystem isolation, scratch storage, sandbox behavior, or host file mutation APIs
title: "Filesystem capability model"
---

OpenClaw uses several filesystem controls that solve different problems. Treat them as layers, not replacements for each other:

| Layer                      | Purpose                                                                                                     | Current fit                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Runtime boundary           | Keep tool execution away from the host with Docker, SSH, OpenShell, or future worker and process boundaries | Defense in depth around tool execution        |
| Agent scratch storage      | Store agent-local temporary state that does not need to be a real host path                                 | Candidate for a virtual filesystem experiment |
| Host filesystem capability | Mutate real workspaces, media, archives, and state files safely under a rooted capability                   | `@openclaw/fs-safe`                           |

The important distinction is that virtual or sandbox-local storage can reduce how often OpenClaw touches the host filesystem, but it cannot replace safe real-host mutation for repo edits, archive extraction, media staging, exported session data, or any integration that must write a real path.

## Current model

OpenClaw is a long-lived Gateway with one or more agents. Agents can have different workspaces, sandbox settings, tool policies, auth stores, and channel bindings.

The workspace is the default current directory and memory anchor, not a hard security boundary by itself. When tools run on the host, absolute paths and host permissions still define what the process can reach. Use [Sandboxing](/gateway/sandboxing), per-agent tool policy, and separate OS users or hosts when you need a stronger boundary.

For trusted Gateway code that receives untrusted path names, OpenClaw uses [`@openclaw/fs-safe`](https://github.com/openclaw/fs-safe). That package provides rooted file operations, atomic replacement helpers, archive extraction limits, temp workspace helpers, JSON state helpers, and secret-file helpers. See [Secure file operations](/gateway/security/secure-file-operations).

## Why Node permissions are only an outer guard

Node's [permission model](https://nodejs.org/api/permissions.html) can restrict process or worker access with launch flags such as `--permission`, `--allow-fs-read`, `--allow-fs-write`, and `--allow-worker`.

That can be useful around a worker or subprocess, but it is not the same abstraction as an object-capability filesystem API:

- It is launch policy for a process or worker, not a value like `workspaceRoot.write("src/index.ts")`.
- It is coarse for one long-lived Gateway that hosts many agents with different roots.
- Every worker needs correctly configured `execArgv` and environment policy.
- Worker creation and subprocess creation must stay controlled so inner code cannot weaken the model.
- Node documents important constraints, including non-inheritance to worker threads, existing file descriptors, and symlink behavior.
- It does not provide portable `openat` or dirfd-style mutation APIs for traversal-resistant real-host writes.

Use Node permissions, worker isolation, or process isolation as defense in depth. Keep rooted filesystem APIs for host path mutation.

## Virtual filesystem role

A virtual filesystem can be useful for agent scratch or state that does not need to appear on the host:

- intermediate tool outputs;
- agent-local notes, caches, or resumable task state;
- generated artifacts that will be explicitly exported later;
- provider or workflow scratch paths where user-visible semantics do not require a host path.

This can narrow the host filesystem surface and make per-agent cleanup easier. It should not become the default location for real workspace edits unless the user explicitly opts into a virtual workspace model with clear export and sync semantics.

## Host filesystem capability role

Real host paths are still required when OpenClaw edits a repository, stages local media for a channel, extracts archives into a workspace, exports session data, writes Gateway state, or updates plugin-owned local state that intentionally lives on disk.

For these operations, prefer a rooted capability object over ad hoc string checks:

- Core code should use the local fs-safe wrappers under `src/infra/*`.
- Plugin-facing APIs should expose SDK helpers or capabilities instead of raw host paths where feasible.
- Archive, copy, rename, remove, and write paths need tests for traversal, symlink, hardlink, and race-shaped cases.
- If hostile local-user isolation matters, run separate gateways under separate OS users or hosts. `fs-safe` is a library guardrail, not a multi-tenant sandbox.

## Experiment checklist

Use this checklist for future implementation PRs:

- Inventory which file operations require real host paths and which are scratch-only.
- Prototype one agent running in a worker with explicit filesystem permission flags, then compare with a process-mode prototype.
- Add a per-agent scratch filesystem experiment without changing real workspace edit behavior.
- Measure startup cost, memory, debugging complexity, and failure recovery for each runtime boundary.
- Keep workspace edits on `fs-safe` while measuring how much Python helper usage remains after scratch-only paths move away from host writes.
- Evaluate optional Linux `openat2` acceleration only as a portable `fs-safe` implementation detail, not as the whole OpenClaw model.
- Document any new plugin API boundary that passes capabilities instead of raw host paths.
- Add regression tests for traversal, symlink, hardlink, rename, copy, remove, archive extraction, and time-of-check to time-of-use races.

## Non-goals

- Do not replace `fs-safe` with Node permissions.
- Do not migrate all agent execution to workers, processes, or a third-party orchestrator without measured product and operations proof.
- Do not make virtual filesystems the only storage model for workspace edits.
- Do not remove Python helper paths until an equally safe portable alternative exists for the covered operations.
- Do not add large runtime dependencies to core without install size, startup, security, and ownership review.

Related: [Security](/gateway/security), [Secure file operations](/gateway/security/secure-file-operations), [Sandboxing](/gateway/sandboxing), [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools), [Agent workspace](/concepts/agent-workspace).
