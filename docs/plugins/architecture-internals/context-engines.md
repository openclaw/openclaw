---
summary: "Registering a context engine plugin that owns session ingest, assembly, and compaction"
read_when:
  - Adding a context engine plugin
  - You are replacing or extending the default context pipeline
  - You need to delegate compaction back to the runtime
title: "Context engines"
sidebarTitle: "Context engines"
---

How a plugin takes over session context orchestration through the
`contextEngine` slot, and what it must still delegate. Part of the [Plugin
architecture internals](/plugins/architecture-internals) guide.

## Context engine plugins

Context engine plugins own session context orchestration for ingest, assembly,
and compaction. Register them from your plugin with
`api.registerContextEngine(id, factory)`, then select the active engine with
`plugins.slots.contextEngine`.

Use this when your plugin needs to replace or extend the default context
pipeline rather than just add memory search or hooks.

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("lossless-claw", (ctx) => ({
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
      acceptedHostParams: ["sessionKey"],
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, sessionKey, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
          agentSessionKey: sessionKey,
        }),
      };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

The factory `ctx` exposes optional `config`, `agentDir`, and `workspaceDir`
values for construction-time initialization.

The host completes registered async memory prompt preparation before calling a
non-legacy engine's `assemble()`. `buildMemorySystemPromptAddition(...)` stays
synchronous and reads that immutable run snapshot while `assemble()` is active.
Pass the supplied tool and citation context through unchanged so the snapshot
cannot cross run boundaries.

`assemble()` may return `contextProjection` when the active harness has a
persistent backend thread. Omit it for legacy per-turn projection. Return
`{ mode: "thread_bootstrap", epoch }` when the assembled context should be
injected once into a backend thread and reused until the epoch changes. Change
the epoch after the engine's semantic context changes, such as after an
engine-owned compaction pass. Hosts may preserve tool-call metadata, input
shape, and redacted tool results in a thread-bootstrap projection so fresh
backend threads retain tool continuity without copying raw secret-bearing
payloads.

If your engine does **not** own the compaction algorithm, keep `compact()`
implemented and delegate it explicitly:

```ts
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("my-memory-engine", (ctx) => ({
    info: {
      id: "my-memory-engine",
      name: "My Memory Engine",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, sessionKey, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
          agentSessionKey: sessionKey,
        }),
      };
    },
    async compact(params) {
      return await delegateCompactionToRuntime(params);
    },
  }));
}
```
