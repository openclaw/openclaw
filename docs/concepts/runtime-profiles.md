---
summary: "How the standalone build selects host execution capabilities and where dynamic code runs"
title: "Runtime execution profiles"
read_when:
  - You are packaging an embedded AOT Gateway
  - A feature reports that it needs dynamic execution
  - You are writing a plugin that executes generated code
---

OpenClaw distinguishes the code compiled into a host from code supplied after
that host was built. The runtime profile owns that distinction. It is selected
from the standalone artifact's immutable bootstrap facts, with a manifest
fallback for hosts without those facts. A user setting, filename suffix,
operating system, or trial call to `eval` does not select the profile.

## Profiles

| Host                                               | Profile             | Host execution contract                                                                                         |
| -------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| Node or Bun installation, source checkout          | `dynamic-execution` | Source plugins and intentional host JavaScript execution are available.                                         |
| JIT or bytecode standalone                         | `dynamic-execution` | Source plugins and intentional host JavaScript execution use the existing standalone loading contract.          |
| AOT standalone (`manifest.json` has `mode: "aot"`) | `embedded-aot`      | Host code must already be embedded. Source plugin loading and host JavaScript evaluation fail with a next step. |

The selection is process-stable. Workers make the same selection from the same
artifact. Replacing an artifact requires restarting its processes; changing the
manifest under a running Gateway does not change its execution profile.

An execution profile is a compatibility contract, not a sandbox or a new grant
of authority. Tool permissions, approval checks, plugin trust, cancellation,
and lifecycle ownership still apply in both profiles.

## Features that execute code

The default Node Code Mode executor runs JavaScript in `node:vm` in a worker
thread. A worker thread shares the host's runtime restrictions. In an embedded
AOT host it reports `runtime_unavailable` before creating that worker. Run the
Gateway with a Node/Bun installation or a JIT/bytecode standalone to use it.
The existing QuickJS executor is a separate guest runtime; it is not silently
selected instead. An embedded QuickJS deployment still needs its own WASM and
worker qualification. See [Code Mode executors](/tools/code-mode/executors).

QA scenario expressions and lambdas also execute host JavaScript. Embedded AOT
reports a profile error before compiling them. Run those scenarios in a
dynamic-execution host. Declarative values and actions that do not evaluate
JavaScript keep their normal behavior.

Browser JavaScript executes in the browser. A host-side syntax check or callback
serializer must use parsing or static source, not compile the expression locally.
External MCP servers and separately launched runtimes have their own execution
profile. Starting a worker thread, or relaunching the same AOT executable, does
not create a dynamic-execution host.

## Plugins fetched after the build

A successful installation does not make a plugin part of an AOT executable.
The embedded host admits compiled image modules; a plugin's JavaScript or
TypeScript downloaded later requires a dynamic-execution host. This applies
to pretranspiled JavaScript too. Metadata discovery and configuration validation
must remain available without running plugin code.

Plugin authors should use the documented SDK runtime capability assertion before
intentional host evaluation and propagate its actionable error. Do not catch it
and fall back to another host evaluator. Keep fixed programs as normal source
functions or build-time generated modules. Runtime schemas require a codegen-free
validator; runtime syntax checks require a parser. Workers need explicit embedded
entries. Dependencies follow the same rules, including transitive imports.

An embedded-compatible declaration or lint result is not a proof that an
arbitrary downloaded module can run in the image. Shipping another plugin in an
AOT host requires rebuilding the complete artifact with that plugin. A separate
dynamic host can instead run it using the existing Gateway/MCP/tool protocol;
this profile does not invent an automatic plugin sidecar or serialize live SDK
objects across processes.

## String-codegen hardening

AOT compilation alone does not forbid `eval`, `Function`, or VM source. Those
paths can still invoke Bun's interpreter. The profile gates intentional host
execution at its owners; it does not monkey-patch JavaScript globals.

The experimental compiler's ordinary
`--disallow-code-generation-from-strings` flag rejects `eval` and Function
constructors but still permits `node:vm`. Its strict variant also restricts VM
and disk-loaded code. Build-time hardening needs the fixed validator, browser,
codec, worker, and plugin paths to be compatible first. Selecting `embedded-aot`
is not a claim that the whole executable contains no interpreter, and this
change does not enable a process-wide strict flag by default.

Qualification should compile a small probe of the actual boundary and compare
behavior with and without the profile gate. Do not use the experimental
interpreter crash flag as an all-clear signal: it has allowed interpreted
runtime source in compiled positive controls. Whole-artifact builds and runtime
campaigns remain necessary before shipping an AOT desktop release.
