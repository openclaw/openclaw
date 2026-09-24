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

## Runtime tool allowlists

`applyEmbeddedAttemptToolsAllow(tools, toolsAllow?, options?)` filters concrete
runtime tools using the shared aliases, groups, and wildcard matching. An
undefined allowlist keeps all tools; an explicit empty list disables them.
Independent restrictions must each permit a tool.

Use `options.toolMeta(tool)` to supply its owning `pluginId` for plugin-group
matching. A harness that exposes a tool under another name can supply
`options.toolAliases(tool)` with its accepted policy aliases. Each restriction
can match the original name or an alias; the result retains the original tool
objects and their execution wrappers.

## Sandbox bind parsing

`openclaw/plugin-sdk/agent-harness-runtime` exports
`splitSandboxBindSpec(spec, options?)`. It returns raw `{ host, container, options }`
segments, or `null` when no host/container separator exists. Windows host drive
prefixes are always preserved. Pass `{ allowWindowsContainerPath: true }` to
preserve drive prefixes in container paths too, as Policy does for its existing
Windows bind grammar. The default keeps POSIX container parsing unchanged.
This helper splits text; it does not validate or authorize a mount.

## Sandbox filesystem mappings

`SandboxContext`, exported by `openclaw/plugin-sdk/agent-harness-runtime`, exposes
its filesystem bridge through `fsBridge`. That bridge accepts optional readonly
`pathMappings`: `{ hostRoot, containerRoot }` pairs from the backend's prepared
mounts. Include workspace, agent-workspace, and protected-resource projections.
The container root declares the path syntax: POSIX roots retain literal
backslashes; Windows drive and UNC roots use Windows containment and preserve
filename case. The deepest matching root wins; equal roots use the supplied
order.

Workspace-only file tools use these mappings for admission. Bridge operations
still enforce physical boundaries, mount visibility, and read-only policy.
A supplied empty list admits no paths, and an unmatched path never falls back
to host-root admission. Older external bridges that omit the property retain
the host-root compatibility exposed in v2026.9.4. New implementations should
supply the mappings; removal of that compatibility requires a breaking SDK
contract that makes the property required.

Host-backed bridges can additionally expose `resolveReadPolicyPath()` to map
an existing read target into that caller-facing mount namespace. When present,
`readFile()` and `stat()` must reject an `expectedPolicyPath` that no longer
names their final opened target. This keeps
the bridge, not its caller, responsible for physical alias resolution.
Expected-policy metadata comes from the admitted descriptor; bridges can keep
their existing pathname metadata behavior when this optional contract is unused.
