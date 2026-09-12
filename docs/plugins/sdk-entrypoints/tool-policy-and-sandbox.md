---
summary: "toolPolicy matchers, tool-group expansion, and splitSandboxBindSpec"
title: "Plugin SDK tool policy and sandbox helpers"
sidebarTitle: "Policy and sandbox"
read_when:
  - You are expanding tool groups or building a tool policy matcher
  - You are parsing a sandbox bind specification
---

The synchronous policy and sandbox parsing primitives that
`openclaw/plugin-sdk/agent-harness-runtime` exposes to plugins. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## Tool policy vocabulary

`openclaw/plugin-sdk/agent-harness-runtime` exposes core's synchronous policy
primitives through `toolPolicy`:

- `toolPolicy.expandToolGroups(list?)` normalizes tool aliases, drops blank entries, expands
  core groups, and returns unique tool ids in first-seen order. Members of each
  expanded group follow that group's catalog order.
- `toolPolicy.createToolPolicyMatcher(policy?, writeAllowsApplyPatch = true)` returns a
  matcher for tool names. Deny entries win, an empty allow list is unrestricted,
  and `*` patterns and aliases use core normalization. Set the second argument
  to `false` to disable the runtime compatibility where allowing `write` also
  allows `apply_patch`.

For conformance coverage, negate a matcher built with `{ deny: entries }`;
this keeps an empty coverage list false and avoids allow-side compatibility.
Prepare matchers for one synchronous operation; do not retain an authorization
decision across awaited work.

## Sandbox bind parsing

`openclaw/plugin-sdk/agent-harness-runtime` exports
`splitSandboxBindSpec(spec, options?)`. It returns raw `{ host, container, options }`
segments, or `null` when no host/container separator exists. Windows host drive
prefixes are always preserved. Pass `{ allowWindowsContainerPath: true }` to
preserve drive prefixes in container paths too, as Policy does for its existing
Windows bind grammar. The default keeps POSIX container parsing unchanged.
This helper splits text; it does not validate or authorize a mount.
