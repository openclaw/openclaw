---
summary: "Read-only model and MCP catalogs a harness reports from its own native runtime"
read_when:
  - You are reporting native models to the OpenClaw model picker
  - You own MCP connections outside the in-process MCP runtime
  - You are implementing catalog readiness or cleanup joins
title: "Agent harness native inventories"
sidebarTitle: "Native inventories"
---

The read-only catalogs a harness exposes to OpenClaw control surfaces: native model rows with their readiness, and MCP tool inventory owned outside the in-process MCP runtime. Part of the [Agent harness plugins](/plugins/sdk-agent-harness) reference.

## Native model inventory

`loadModelCatalog(params)` lists models for the supplied agent, workspace, and
config snapshot. Rows owned by native model selection set `nativeRuntime` to
the harness ID and omit host `api` and `baseUrl` claims. Core does not enrich
these rows with transport or capabilities from a host route.

An optional synchronous `readModelCatalogReadiness(params)` returns only
`{ accountType: string }` for a current native account observation
covering that exact scope and model. Preserve the native account type; it does
not imply a host credential or OAuth refresh lifecycle. Return `undefined` for missing, failed,
superseded, or disposed observations. Readiness must remain with the physical
native owner and be revalidated at use; never serialize it on catalog rows,
perform I/O in this callback, or infer it from a successful earlier turn.
Gateway uses this metadata for native-owned picker rows; authored host routes,
credentials, and profile locks still use host readiness. This is not execution
authorization, and all run-time compatibility and permission checks still apply.

## Native MCP inventory

A harness that owns MCP connections outside OpenClaw's in-process MCP runtime
can implement `loadMcpToolCatalog(params)`. The callback is used by read-only
control surfaces such as the composer Tool access view. It receives the
authoritative session identity, runtime config, workspace, and sparse session
MCP overrides. `mcpServerNames` is the bounded set of OpenClaw-configured
servers whose session policy the harness may represent. Return OpenClaw's
`McpToolCatalog` shape for only that set.

Use only an already-bound native process and thread. Returning `undefined`
means no live catalog is available; do not start a new harness process merely
to answer inventory. Preserve raw server/tool names, assign collision-safe
server names with `assignMcpCatalogSafeServerNames(...)`, and retain tools
hidden only by a session denial in `sessionDeniedTools`. Core still applies the
final OpenClaw tool policy and schema compatibility checks before exposing the
rows.

`SessionMcpRuntime` implementations used by materialized tool views should
provide `joinCleanup()`. It waits for cleanup already requested from that exact
runtime, including unpublished or retiring servers, and rejects if any owned
cleanup failed or could not be confirmed. It must preserve that failure for
later callers without closing transports still leased by another run. A fulfilled
best-effort `dispose()` alone is not cleanup evidence.

The method is optional for existing SDK implementations; automatic one-shot
recovery treats a missing method as uncertain cleanup. A native facade that owns
no transport may resolve immediately when its enclosing runtime separately owns
and verifies the process lifetime.

Harnesses that forward embedded attempt params should pass
`skillWorkshopProposalOnly` through. Proposal-only skill-workshop runs are
deliberately narrow single-tool runs, and the runtime keeps them on the raw
tool surface instead of engaging code mode or a tool-search catalog.
