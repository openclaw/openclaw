---
summary: "Upstream runtime/SDK API request for OpenClaw x AOTUI integration"
owner: "codex"
status: "draft"
last_updated: "2026-03-07"
title: "OpenClaw x AOTUI Runtime and SDK API Request"
---

# OpenClaw x AOTUI Runtime and SDK API Request

## 1. Why this document exists

OpenClaw has already integrated AOTUI as:

- a live app runtime
- a live tool surface
- a live state projection surface

The remaining long-term gap is not on the OpenClaw side alone.

If the integration is to stay clean over time, the AOTUI runtime and SDK should expose a small set of explicit capabilities for:

- desktop-level app reinitialization during OpenClaw compaction
- app-level cooperation with that reinitialization
- host-owned app installation without relying on ambient global config

This document is the concrete upstream request for those capabilities.

## 2. Terminology correction

The word `compact` is wrong for the AOTUI-side action.

What OpenClaw is doing:

- compacting model context
- summarizing conversation state
- reclaiming prompt budget

What AOTUI needs to do in response is not "compact itself".
What it needs to do is:

- reinitialize every app on a desktop back to its initial state
- while preserving desktop identity and app installation identity

Therefore the correct terms should be:

- runtime primitive: `reinitializeDesktopApps`
- SDK lifecycle hook: `onReinitialize`

The following names are inaccurate and should be avoided:

- `compactDesktop`
- `onCompact`
- `clear_app_state`

Reason:

- they imply data compression semantics
- they hide the real behavior
- they make future API users mis-model the system

The real behavior is reset/reinitialization, not compaction.

## 3. What OpenClaw needs from upstream

There are three requests.

Priority order:

1. desktop-level app reinitialization primitive
2. app-level reinitialization lifecycle hook
3. host-owned explicit app installation API

## 4. Request 1: desktop-level app reinitialization primitive

### Required capability

The runtime should expose a host-callable primitive that:

- reinitializes every app on a desktop back to its initial state
- does not destroy desktop identity
- does not uninstall and reinstall apps as a side effect
- preserves enough root-level surface for re-entry

Illustrative API:

```ts
await kernel.reinitializeDesktopApps(desktopId, {
  reason: "context_compaction",
  preserve: {
    desktopIdentity: true,
    installedApps: true,
    rootSurface: true,
  },
});
```

The exact method name is negotiable.
The semantics are not.

### Hard semantics

The primitive must satisfy all of the following:

1. The `desktopId` remains stable.
2. The installed app set remains stable.
3. Each app is returned to its initial state.
4. The runtime does not create a new desktop as an implementation shortcut.
5. The host does not need to know each app's private state topology.
6. Root-level re-entry surface remains available after reinitialization.

### Why this is needed

Without this primitive, the host is forced into one of two bad options:

1. destroy and recreate the entire desktop
2. learn each app's private reset semantics

Option 1 is too destructive.
It turns compaction into world replacement.

Option 2 destroys framework boundaries.
The host should not know app-private runtime structure.

That is the first-principles reason this primitive belongs in runtime:

Only runtime has the authority to define what it means to "reset every app to its initial state while preserving desktop identity".

The host does not have that knowledge.

## 5. Request 2: app-level reinitialization lifecycle hook

### Required capability

The SDK should expose a formal lifecycle hook so app authors can cooperate with reinitialization.

Illustrative API:

```ts
createTUIApp({
  ...,
  onReinitialize(ctx) {
    // reset app to initial state
    // keep root-level re-entry surface
  },
});
```

The exact hook name is negotiable.
The semantics are not.

### Hard semantics

The hook must satisfy all of the following:

1. Runtime can invoke it during desktop-app reinitialization.
2. App authors can reset transient working state intentionally.
3. App authors can preserve the root-level re-entry surface intentionally.
4. Host logic does not need to understand app-private state structure.
5. Apps that do nothing still end up in a correct initial state.

### Why this is needed

Only app authors know:

- which state is transient
- which state is derived
- which state is expensive to rebuild
- which state must remain visible for re-entry

If the SDK does not provide an official hook, developers will do what humans always do:

- optimize locally
- invent hidden escape hatches
- store pseudo-durable state in unofficial places

That is how framework rot begins.

When the framework has no sanctioned survival path, users create unsanctioned ones.

## 6. Request 3: host-owned explicit app installation API

### Required capability

The runtime/registry layer should support host-owned app loading and installation without relying on ambient global user config as the effective control plane.

Illustrative API:

```ts
const registry = new AppRegistry();

await registry.loadFromEntries([
  { package: "@agentina/aotui-ide", version: "..." },
  { package: "@scope/other-app", version: "..." },
]);

await registry.installSelected(desktop, ["@agentina/aotui-ide"], {
  dynamicConfig,
});
```

The exact API shape is negotiable.
The semantics are not.

### Hard semantics

The API must allow the host to:

1. declare which apps are available
2. declare which apps are installed on a given desktop
3. avoid inheriting app exposure from hidden global config
4. preserve dynamic config injection where needed

### Why this is needed

If capability policy comes from two places:

- the host config
- a hidden global runtime config

then the system will drift.

Drift is worse than a crash.

A crash is visible.
Drift is invisible until behavior becomes inconsistent across:

- machines
- developers
- environments
- test runs

Humans are bad at maintaining two sources of truth.
This is not a moral judgment.
It is a stable property of group behavior.

Therefore capability authority must be singular.

## 7. Explicit non-goals

These requests do not ask runtime/SDK to do the following:

1. Take orchestration authority away from OpenClaw
2. Persist full app state across compaction
3. Replace OpenClaw transcript compaction
4. Solve OpenClaw projection budgeting
5. Redesign all upstream AOTUI internals

The requests are intentionally narrow.

## 8. Expected division of responsibility

### OpenClaw should own

- session identity
- agent identity
- model calls
- transcript
- compaction triggering
- summary generation
- app policy resolution
- projection budgeting

### AOTUI runtime should own

- desktop identity preservation during app reinitialization
- app reinitialization semantics
- app installation semantics

### AOTUI SDK should own

- app-author cooperation with reinitialization
- lifecycle entry points for returning to initial state cleanly

## 9. Acceptance criteria

The upstream work is sufficient when all of the following are true.

### For runtime

1. Host can reinitialize desktop apps without recreating the desktop.
2. Desktop identity remains stable across reinitialization.
3. Installed app identity remains stable across reinitialization.
4. Runtime does not require host knowledge of app-private state.

### For SDK

1. App authors have a formal lifecycle hook for reinitialization.
2. Apps can intentionally rebuild their initial state.
3. Apps can intentionally preserve re-entry surface.

### For app installation

1. Host can explicitly select installed apps.
2. Effective capability surface no longer depends on ambient global config.

## 10. Suggested minimal API names

If upstream wants concrete names, these are the recommended ones:

### Runtime

```ts
reinitializeDesktopApps(desktopId, options);
```

### SDK

```ts
onReinitialize(ctx);
```

### Registry

```ts
loadFromEntries(entries);
installSelected(desktop, appIds, options);
```

These names are preferred because they describe actual behavior.

## 11. Final statement

The OpenClaw x AOTUI integration does not need a broad upstream redesign.
It needs three explicit capabilities that make the system honest:

- when OpenClaw compacts, AOTUI reinitializes apps instead of pretending to "compact" them
- app authors get an official lifecycle hook instead of inventing hidden state workarounds
- host capability authority stops depending on hidden global config

That is the narrowest upstream surface that prevents long-term architectural decay.
