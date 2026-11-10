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

| Host                                               | Profile             | Host execution contract                                                                               |
| -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| Node or Bun installation, source checkout          | `dynamic-execution` | Source plugins and intentional host JavaScript execution use the runtime's normal execution engine.   |
| JIT or bytecode standalone                         | `dynamic-execution` | Source plugins and intentional host JavaScript execution use the standalone loading contract.         |
| AOT standalone (`manifest.json` has `mode: "aot"`) | `embedded-aot`      | Embedded code is compiled; fetched plugins and intentional host JavaScript execution run interpreted. |

The selection is process-stable. Workers inherit the artifact's profile.
Replacing an artifact requires restarting its processes; changing the manifest
under a running Gateway does not change its execution profile.

An execution profile is a compatibility contract, not a sandbox or a new grant
of authority. Tool permissions, approval checks, plugin trust, cancellation,
and lifecycle ownership still apply in both profiles.

## Features that execute code

The default Node Code Mode executor runs JavaScript in `node:vm` in a worker
thread. In an AOT host the VM code runs interpreted and returns its normal
results, including retained continuations. OpenClaw emits one performance notice
for Node Code Mode per process, rather than warning for every cell. Use a JIT
build for full speed. The QuickJS executor remains a separate guest runtime;
OpenClaw does not silently select it instead. See
[Code Mode executors](/tools/code-mode/executors).

QA scenario expressions and lambdas also run interpreted in AOT hosts, with one
performance notice for the feature. Declarative values and actions keep their
normal behavior. Doctor and runtime diagnostics identify the selected profile
and interpreted execution without evaluating probe code.

Browser JavaScript executes in the browser. A host-side syntax check or callback
serializer should use parsing or static source. External MCP servers and
separately launched runtimes have their own execution profile. Starting a worker
thread, or relaunching the same AOT executable, keeps this image's restrictions.

## Plugins fetched after the build

A plugin downloaded after compilation can load from disk through the normal
plugin loader and share the host's compiled SDK objects and classes. This
includes CJS JavaScript and TypeScript transformed with Jiti. The host emits one
performance notice for fetched plugin code per process; it does not warn for
every plugin or callback. Embedded plugin code keeps its compiled execution.

Installation does not add code to the executable. A late import that is neither
embedded nor available through the disk loader still fails with install/rebuild
guidance. Keep dependencies declared and available to the loader; an import of
a previously unused host builtin or API may require a retained build entry.
Fetched workers and child programs need their own declared runtime/entry
contract. Successful CJS/TS loading does not qualify arbitrary native ESM,
workers, child programs, or transitive dependencies.

Plugin authors can call `noteRuntimeDynamicExecution` and
`annotateRuntimeExecutionError` from `openclaw/plugin-sdk/runtime-env` for the
same diagnostics. Keep fixed programs as normal source functions or build-time
generated modules. Runtime schemas should use codegen-free validators and
syntax checks should use parsers. See
[Plugin runtime utilities](/plugins/sdk-runtime/config-and-utilities#runtime-execution-profile).

## String-codegen hardening

AOT compilation alone does not forbid `eval`, `Function`, or VM source. These
paths use Bun's interpreter. OpenClaw allows them and adds actionable guidance
after a real runtime rejection; it does not monkey-patch JavaScript globals or
reject code merely because the host is AOT.

The experimental compiler's ordinary
`--disallow-code-generation-from-strings` flag rejects `eval` and Function
constructors but still permits `node:vm`. Its `=strict` variant also rejects VM
and disk-loaded code. Those restricted builds cannot run all of these features;
use a Node/Bun or JIT build without the disabling flag, or rebuild without it.
OpenClaw does not enable this flag by default. A selected AOT profile is not an
interpreter-free claim.

Qualification should compile small probes of the actual execution/loading
boundaries. Do not use the experimental interpreter crash flag as an all-clear
signal: it has allowed interpreted runtime source in compiled positive controls.
Whole-artifact builds and runtime campaigns remain necessary before shipping an
AOT desktop release.
