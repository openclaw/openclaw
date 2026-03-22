---
title: "Plugin SDK Testing"
sidebarTitle: "Testing"
summary: "How to test plugin code with the public testing helpers and small local test doubles"
read_when:
  - You are writing tests for a plugin
  - You need fixtures for Windows command shims or shared routing failures
  - You want to know what the public testing surface includes
---

# Plugin SDK Testing

OpenClaw keeps the public testing surface intentionally small.

Use `openclaw/plugin-sdk/testing` for helpers that are stable enough to support
for plugin authors, and build small plugin-local doubles for everything else.

## Public testing helpers

Current helpers include:

- `createWindowsCmdShimFixture(...)`
- `installCommonResolveTargetErrorCases(...)`
- `shouldAckReaction(...)`
- `removeAckReactionAfterReply(...)`

The testing surface also re-exports some shared types:

- `OpenClawConfig`
- `PluginRuntime`
- `RuntimeEnv`
- `ChannelAccountSnapshot`
- `ChannelGatewayContext`

## Example: Windows command shim fixture

```ts
import { createWindowsCmdShimFixture } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

describe("example CLI integration", () => {
  it("creates a command shim", async () => {
    await createWindowsCmdShimFixture({
      shimPath: "/tmp/example.cmd",
      scriptPath: "/tmp/example.js",
      shimLine: 'node "%~dp0\\example.js" %*',
    });

    expect(true).toBe(true);
  });
});
```

## Example: shared target-resolution failures

```ts
import { installCommonResolveTargetErrorCases } from "openclaw/plugin-sdk/testing";

installCommonResolveTargetErrorCases({
  implicitAllowFrom: ["user-1"],
  resolveTarget({ to, mode, allowFrom }) {
    if (!to?.trim()) {
      return { ok: false, error: new Error("missing target") };
    }
    if (mode === "implicit" && allowFrom.length > 0 && to === "invalid-target") {
      return { ok: false, error: new Error("invalid target") };
    }
    return { ok: true, to };
  },
});
```

## Runtime doubles

There is no catch-all `createTestRuntime()` export on the public SDK today.
Instead:

- use the public testing helpers where they fit
- use `plugin-sdk/runtime` for small runtime adapters
- build tiny plugin-local runtime doubles for the rest

Example:

```ts
import { createLoggerBackedRuntime } from "openclaw/plugin-sdk/runtime";

const logs: string[] = [];

const runtime = createLoggerBackedRuntime({
  logger: {
    info(message) {
      logs.push(`info:${message}`);
    },
    error(message) {
      logs.push(`error:${message}`);
    },
  },
});
```

## Test guidance

- Prefer focused unit tests over giant end-to-end harnesses.
- Import pure types from focused SDK subpaths in tests.
- Keep plugin-local test doubles small and explicit.
- Avoid depending on non-exported OpenClaw test internals.

## Related

- [Building Plugins](/plugins/building-plugins)
- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Runtime](/plugins/sdk-runtime)
