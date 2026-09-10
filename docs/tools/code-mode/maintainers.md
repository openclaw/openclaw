---
summary: "Code Mode implementation layout, the validation checklist, and the E2E test plan"
title: "Code Mode maintainer notes"
read_when:
  - You are changing Code Mode source and need the file layout
  - You are validating a Code Mode change before landing it
  - You are writing or reviewing Code Mode E2E coverage
---

## Implementation layout

- config contract: `tools.codeMode`
- catalog builder: effective tools to compact entries and id map
- model-surface adapter: replace visible tools with control/direct tools
- QuickJS-WASI runtime adapter: load, eval, snapshot, restore, dispose
- worker supervisor: timeout, abort, crash isolation
- bridge adapter: JSON-safe host callbacks and result delivery
- TypeScript transform adapter
- snapshot store: TTL, size caps, run/session scoping
- trajectory projection for nested tool calls
- telemetry counters and diagnostics

The implementation reuses catalog and executor concepts from Tool Search, but
does not use a `node:vm` child as the sandbox.

## Validation checklist

Code mode coverage should prove:

- disabled config without an enabling override leaves existing tool exposure unchanged
- omitted `enabled`, including object config that sets other fields, stays
  disabled unless an agent or model override enables it
- per-model `true`, `false`, and unset values preserve activation precedence,
  fallback-model selection, and limits from the enclosing options
- enabled config exposes `exec`, `wait`, and only required direct-only tools to
  the model when tools are active for the run
- raw no-tool runs, `disableTools`, and empty allowlists do not trigger
  code-mode payload enforcement
- every catalog-eligible effective non-MCP name has one callable winner
- direct-only tools stay model-visible and do not appear in `catalog`
- denied tools have no global or catalog handle
- bare globals, callable `catalog.search` results, `catalog.all`, and handle
  `describe()` work for OpenClaw and client tools without exposing exact ids
- `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` expose TypeScript-style
  MCP declarations without a bridge/tool call
- MCP namespace `$api()` remains available as an inline fallback for schemas
- MCP namespace calls work for visible MCP tools with one object input, while
  direct MCP entries are absent from generic `catalog` discovery
- Tool Search control tools are hidden from both the model surface and the
  hidden catalog
- nested calls preserve approval and hook behavior
- caught and uncaught nested failures remain recoverable without replaying
  previously executed side effects
- network-controlled failures retain untrusted-content wrapping and sanitization
- shell `exec` is hidden from the model but callable as a guest global when
  allowed
- recursive code-mode `exec` and `wait` are not callable from guest code
- TypeScript input is transformed and evaluated without loading TypeScript on
  disabled or JavaScript-only paths
- `import`, `require`, filesystem, network, and environment access fail
- infinite loops time out and cannot block the Gateway
- memory cap failures terminate the guest VM
- output and snapshot caps are enforced for completed and suspended calls
- `wait` resumes a suspended snapshot and returns the final value
- expired, aborted, wrong-session, and unknown `runId` values fail
- transcript replay and persistence preserve code-mode control calls
- transcript and telemetry show nested tool calls clearly

## E2E test plan

Run these as integration or end-to-end tests when changing the runtime:

1. Start a Gateway with `tools.codeMode.enabled: false`.
2. Send an agent turn with a small direct tool set.
3. Assert the model-visible tools are unchanged.
4. Restart with `tools.codeMode.enabled: true`.
5. Send an agent turn with OpenClaw, plugin, MCP, and client test tools.
6. Assert the model-visible tool list is `exec`, `wait`, plus only configured
   direct-only tools.
7. In `exec`, call safe bare globals and assert normalized, reserved, and
   colliding names match the quick index.
8. Search `catalog`, inspect handle metadata/`describe()`, and call
   OpenClaw/plugin/client handles without observing exact ids.
9. In `exec`, call `API.list("mcp")` and `API.read("mcp/<server>.d.ts")` and
   assert the declaration files describe visible MCP tools.
10. In `exec`, call MCP tools through `MCP.<server>.<tool>({ ...input })` and
    assert direct MCP entries are absent from `catalog.search()` and
    `catalog.all()`.
11. Assert denied tools are absent and cannot be called by guessed id.
12. Start a nested tool call that resolves after `exec` returns `waiting`.
13. Call `wait` and assert the restored VM receives the tool result.
14. Assert the final answer contains output produced after restore.
15. Assert timeout, abort, and snapshot expiry clean up runtime state.
16. Export trajectory and assert nested calls are visible under the parent
    code-mode call.

Docs-only changes to this page should still run `pnpm check:docs`.
