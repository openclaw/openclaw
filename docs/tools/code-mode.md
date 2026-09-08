---
summary: "Index of the OpenClaw Code Mode documentation, one page per reader job"
title: "Code Mode"
sidebarTitle: "Code Mode"
read_when:
  - You want to enable OpenClaw code mode for an agent run
  - You need to explain why Code Mode is different from Codex Code Mode
  - You are looking for the Code Mode page that matches your task
---

Code mode is an experimental, opt-in OpenClaw agent-runtime feature. When
enabled, the model no longer sees every enabled tool schema; instead, it sees
`exec`, `wait`, and any direct-only tool whose structured result cannot cross
the JSON-only guest bridge. The model writes a small JavaScript or TypeScript
program that searches, describes, and calls the hidden tool catalog.

<Note>
OpenClaw Code Mode is off by default. To try it, open **Settings → Agents &
Tools → Labs** and turn on **Code Mode**. The Labs switch writes the `"auto"`
tier, which engages only for models marked as preferred Code Mode performers.
This is the global default; agent and model overrides take precedence.
</Note>

This page documents OpenClaw code mode, not Codex Code Mode. The two features
share a name and the same control-tool names (`exec`, `wait`), but they are
separate implementations:

- Codex Code Mode runs inside the Codex coding harness. Its `exec` tool is a
  freeform-grammar tool: the model writes raw JavaScript source (optionally
  prefixed by a `// @exec: {...}` pragma line for execution options), executed
  in Codex's in-process V8 Code Mode runtime.
- OpenClaw code mode runs in the generic OpenClaw agent runtime and is
  enabled through global, agent, or model activation settings. Its `exec`
  tool takes a JSON `{ code, language }` payload, executed in a QuickJS-WASI
  worker.

Both are JavaScript execution surfaces, not shell-command surfaces. Treat them
as independent, differently-implemented features that happen to expose
identically-named `exec`/`wait` tools.

In OpenClaw code mode, `command` is a JavaScript or TypeScript alias for
`code`, not a shell command. For shell or file operations, call the appropriate
async tool global from guest JavaScript. Recognizable shell
commands are rejected before guest execution with actionable
`invalid_input` guidance.

Source validation, TypeScript compilation, and guest execution run in a bounded
pool of worker threads that scales with available CPU cores. Workers stay warm
between calls; each cell gets an isolated QuickJS VM. Fast host exchanges retain
that VM within the same call rather than snapshotting every await. Tool
permissions, approvals, and session ownership remain with the Gateway. Queued
work shares the execution deadline, and cancellation stops an active worker
before the call settles.

This page is an index. Code Mode is documented on eight pages, one per reader
job. Open the page that matches your task.

| Page                                                      | Read it when                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Code Mode quickstart](/tools/code-mode/quickstart)       | You want to turn Code Mode on, override one model, and recover from tool errors.   |
| [Code Mode configuration](/tools/code-mode/configuration) | You need the configuration fields, the preferred-model list, and activation order. |

## What it does

- The model-visible tool list becomes `exec`, `wait`, plus any direct-only tool
  such as `computer` or the native-vision `view_image` loader whose image result
  cannot survive the guest bridge.
- `exec` evaluates model-generated JavaScript or TypeScript in an isolated
  QuickJS-WASI worker thread.
- Every catalog-eligible enabled non-MCP tool (OpenClaw core, plugin, client) is
  hidden as a standalone model tool and exposed inside the guest program as an
  async global function. MCP stays under the `MCP` namespace.
- The `exec` description carries a bounded quick index of final callable names,
  compact input hints, and compact declared output hints when a
  trusted tool provides an output schema. It omits descriptions, full schemas,
  MCP entries, and overflow entries; callable `catalog.search(...)` results are
  the fallback. Input hints retain integer and numeric bounds as comments, such
  as `offset?: number /* integer, >= 1 */`. Other validation details remain in
  the full schema available through `describe()`; these hints do not change
  tool validation or output contracts.
- Guest code calls globals directly or searches the hidden catalog for callable
  handles. A handle exposes bounded metadata and `describe()`, but never the
  exact internal catalog id. Calls use the same execution path as normal agent
  turns (policy, approvals, hooks, telemetry all still apply).
- MCP tools are grouped under the `MCP` namespace; in code mode this is the
  only supported way to call them.
- `wait` resumes a suspended code-mode run when nested tool calls are still
  pending.

Call `wait` only when the outer code-mode result has `status: "waiting"`, using
its top-level `runId`. A completed cell can return a background shell operation
with its own `sessionId` inside `value`; use the enabled process-control tool
inside a new `exec` to poll that operation. Its `sessionId` is not a code-mode
run ID.

Code mode changes the model-facing orchestration surface only. It does not
replace tools, plugin tools, MCP tools, auth, approval policy, channel
behavior, or model selection.

## Why use it

- Smaller prompt surface: providers get two control tools, a bounded native-tool
  index, and only the few required direct tools instead of dozens or hundreds
  of full tool schemas.
- Better orchestration: the model can use loops, joins, small transforms,
  conditional logic, and parallel nested tool calls inside one code cell.
- Fewer model round trips: a declared output contract lets the model call and
  transform a tool result in one `exec`; unknown outputs remain raw-first.
- Provider neutral: works for OpenClaw, plugin, MCP, and client tools without
  depending on provider-native code execution.
- Fails closed: if code mode is enabled but the QuickJS-WASI runtime is
  unavailable, the run fails instead of silently falling back to broad direct
  tool exposure.

Most useful for agents with a large enabled tool catalog, or workflows where
the model needs to search, combine, and call several tools before answering.

Keep direct tool exposure for a small catalog or a model that does not reliably
write short programs. Use [Tool Search](/tools/tool-search) when you want a
compact catalog but prefer structured search/describe/call controls instead of
the QuickJS-WASI guest.

## Technical tour

These pages cover the runtime contract and implementation details,
for maintainers, plugin authors debugging tool exposure, and operators
validating high-risk deployments.

| Page                                                          | Read it when                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Code Mode tool surface](/tools/code-mode/tool-surface)       | You need the `exec` and `wait` contracts, the hidden catalog, and collisions. |
| [Code Mode guest API](/tools/code-mode/guest-api)             | You are writing guest code and need its globals, handles, and MCP namespaces. |
| [Code Mode output](/tools/code-mode/output)                   | You need declared output contracts or the guest output API.                   |
| [Code Mode internals](/tools/code-mode/internals)             | You need scope, terms, nested execution, snapshots, or the security boundary. |
| [Code Mode troubleshooting](/tools/code-mode/troubleshooting) | You need error codes, telemetry fields, or the debug environment variables.   |
| [Code Mode maintainer notes](/tools/code-mode/maintainers)    | You are changing Code Mode source, validating it, or writing E2E coverage.    |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/tools/code-mode#guest-runtime-api` still
resolves. Each entry points at the page that now holds the content.

- <a id="quickstart" />[Quickstart](/tools/code-mode/quickstart)
- <a id="enable-code-mode" />[Enable code mode](/tools/code-mode/quickstart#enable-code-mode)
- <a id="override-one-model" />[Override one model](/tools/code-mode/quickstart#override-one-model)
- <a id="what-the-model-does" />[What the model does](/tools/code-mode/quickstart#what-the-model-does)
- <a id="recover-from-tool-errors" />[Recover from tool errors](/tools/code-mode/quickstart#recover-from-tool-errors)
- <a id="verify-the-active-surface" />[Verify the active surface](/tools/code-mode/quickstart#verify-the-active-surface)
- <a id="use-swarm-for-agent-fan-out" />[Use Swarm for agent fan-out](/tools/code-mode/quickstart#use-swarm-for-agent-fan-out)
- <a id="configuration" />[Configuration](/tools/code-mode/configuration#configuration)
- <a id="automatic-per-model-activation" />[Automatic per-model activation](/tools/code-mode/configuration#automatic-per-model-activation)
- <a id="the-compat.codemode-catalog-flag" /><a id="the-compat-codemode-catalog-flag" />[The compat catalog flag](/tools/code-mode/configuration#the-compat-codemode-catalog-flag)
- <a id="shipped-preferred-models" />[Shipped preferred models](/tools/code-mode/configuration#shipped-preferred-models)
- <a id="models-shipped-by-more-than-one-provider" />[Models shipped by more than one provider](/tools/code-mode/configuration#models-shipped-by-more-than-one-provider)
- <a id="choosing-when-to-enable" />[Choosing when to enable](/tools/code-mode/configuration#choosing-when-to-enable)
- <a id="activation" />[Activation](/tools/code-mode/configuration#activation)
- <a id="model-visible-tools" />[Model-visible tools](/tools/code-mode/tool-surface#model-visible-tools)
- <a id="exec" />[The exec tool](/tools/code-mode/tool-surface#exec)
- <a id="source-in-session-history" />[Source in session history](/tools/code-mode/tool-surface#source-in-session-history)
- <a id="wait" />[The wait tool](/tools/code-mode/tool-surface#wait)
- <a id="tool-catalog" />[Tool catalog](/tools/code-mode/tool-surface#tool-catalog)
- <a id="tool-search-interaction" />[Tool Search interaction](/tools/code-mode/tool-surface#tool-search-interaction)
- <a id="tool-names-and-collisions" />[Tool names and collisions](/tools/code-mode/tool-surface#tool-names-and-collisions)
- <a id="guest-runtime-api" />[Guest runtime API](/tools/code-mode/guest-api#guest-runtime-api)
- <a id="reading-paginated-file-data" />[Reading paginated file data](/tools/code-mode/guest-api#reading-paginated-file-data)
- <a id="declared-output-contracts" />[Declared output contracts](/tools/code-mode/output#declared-output-contracts)
- <a id="output-api" />[Output API](/tools/code-mode/output#output-api)
- <a id="runtime-status" />[Runtime status](/tools/code-mode/internals#runtime-status)
- <a id="scope" />[Scope](/tools/code-mode/internals#scope)
- <a id="terms" />[Terms](/tools/code-mode/internals#terms)
- <a id="nested-tool-execution" />[Nested tool execution](/tools/code-mode/internals#nested-tool-execution)
- <a id="run-and-snapshot-lifecycle" />[Run and snapshot lifecycle](/tools/code-mode/internals#run-and-snapshot-lifecycle)
- <a id="quickjs-wasi-runtime" />[QuickJS-WASI runtime](/tools/code-mode/internals#quickjs-wasi-runtime)
- <a id="typescript" />[TypeScript](/tools/code-mode/internals#typescript)
- <a id="security-boundary" />[Security boundary](/tools/code-mode/internals#security-boundary)
- <a id="error-codes" />[Error codes](/tools/code-mode/troubleshooting#error-codes)
- <a id="telemetry" />[Telemetry](/tools/code-mode/troubleshooting#telemetry)
- <a id="debugging" />[Debugging](/tools/code-mode/troubleshooting#debugging)
- <a id="implementation-layout" />[Implementation layout](/tools/code-mode/maintainers#implementation-layout)
- <a id="validation-checklist" />[Validation checklist](/tools/code-mode/maintainers#validation-checklist)
- <a id="e2e-test-plan" />[E2E test plan](/tools/code-mode/maintainers#e2e-test-plan)

## Related

- [Swarm](/tools/swarm) for fan-out agent orchestration from Code Mode scripts
- [Tool Search](/tools/tool-search)
- [Agent runtimes](/concepts/agent-runtimes)
- [Exec tool](/tools/exec)
- [Code execution](/tools/code-execution)
