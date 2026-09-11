---
summary: "Changed-scope detection, lane routing, and manual dispatch behavior"
title: "CI scope and routing"
read_when:
  - You need to understand why a CI job did or did not run
  - You are changing changed-scope detection or dispatch inputs
---

This page is an index. Scope and routing is documented on four pages, one per
reader job. Open the page that matches your task.

| Page                                                                | Read it when                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Scope selection](/ci/scope-and-routing/selection)                  | Why a lane was or was not selected: changed-scope detection and the per-area routing rules.    |
| [Node test lanes](/ci/scope-and-routing/node-test-lanes)            | How the slowest Node test families are split, balanced, packed, and cached.                    |
| [Job budgets and platform lanes](/ci/scope-and-routing/job-budgets) | UI shards, concurrency and matrix budgets, lint memory policy, Android rows, and sticky disks. |
| [Manual dispatches](/ci/scope-and-routing/manual-dispatches)        | Manual CI dispatch behavior, release-gate fallbacks, and the Windows Testbox Probe.            |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/ci/scope-and-routing#manual-dispatches` still resolves. Each entry points at the page that now holds the content.

- <a id="scope-and-routing" />[Scope and routing](/ci/scope-and-routing/selection#scope-and-routing)
- <a id="manual-dispatches" />[Manual dispatches](/ci/scope-and-routing/manual-dispatches#manual-dispatches)
- <a id="windows-testbox-probe" />[Windows Testbox Probe](/ci/scope-and-routing/manual-dispatches#windows-testbox-probe)

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
