#!/usr/bin/env node
// Live repro for #92044: plugin-registered gateway methods were silently requiring
// operator.admin because resolveScopedMethod only looked at
// activeRegistry.gatewayMethodDescriptors. The fix looks across the active,
// http-route, and channel surfaces so plugin-declared scopes reach the resolver.
//
// Run: node --import tsx scripts/repro/issue-92044-workboard-scope.mjs
import assert from "node:assert/strict";
import {
  authorizeOperatorScopesForMethod,
  resolveRequiredOperatorScopeForMethod,
} from "../../src/gateway/method-scopes.ts";
import { createPluginGatewayMethodDescriptor } from "../../src/gateway/methods/registry.ts";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.ts";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.ts";
import { resetPluginRuntimeStateForTest } from "../../src/plugins/runtime.ts";

const WORKBOARD_DISPATCH = "workboard.cards.dispatch";
const MEMORY_DREAM_PROMOTE = "memory.dream.promote";

function buildPluginRegistryWithDescriptors(methods) {
  const registry = createEmptyPluginRegistry();
  for (const entry of methods) {
    registry.gatewayHandlers[entry.name] = ({ respond }) => respond(true, {});
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: entry.pluginId,
        name: entry.name,
        handler: ({ respond }) => respond(true, {}),
        scope: entry.scope,
      }),
    );
  }
  return registry;
}

function resetAllSurfaces() {
  const empty = createEmptyPluginRegistry();
  setActivePluginRegistry(empty);
  pinActivePluginHttpRouteRegistry(empty);
  pinActivePluginChannelRegistry(empty);
}

async function main() {
  console.log("=== Reproduction for issue #92044 ===");
  resetPluginRuntimeStateForTest();

  // Case 1: workboard.cards.dispatch lives on the http-route surface only.
  // Before the fix, resolveRequiredOperatorScopeForMethod returned undefined and
  // authorizeOperatorScopesForMethod defaulted to operator.admin, rejecting the
  // CLI's write+read scope. After the fix, the http-route surface is consulted
  // and the plugin-declared operator.write scope is returned.
  {
    console.log("\n--- Case 1: workboard.cards.dispatch on http-route surface ---");
    const workboardRegistry = buildPluginRegistryWithDescriptors([
      { pluginId: "workboard", name: WORKBOARD_DISPATCH, scope: "operator.write" },
    ]);
    resetAllSurfaces();
    pinActivePluginHttpRouteRegistry(workboardRegistry);

    const required = resolveRequiredOperatorScopeForMethod(WORKBOARD_DISPATCH);
    console.log("resolveRequiredOperatorScopeForMethod =", required);
    assert.equal(required, "operator.write", "expected write scope from http-route surface");

    const writeAllowed = authorizeOperatorScopesForMethod(WORKBOARD_DISPATCH, ["operator.write"]);
    console.log("authorize([operator.write]) =", writeAllowed);
    assert.deepEqual(writeAllowed, { allowed: true }, "write scope should be accepted");

    const readAllowed = authorizeOperatorScopesForMethod(WORKBOARD_DISPATCH, ["operator.read"]);
    console.log("authorize([operator.read]) =", readAllowed);
    assert.deepEqual(
      readAllowed,
      { allowed: false, missingScope: "operator.write" },
      "read scope should be rejected with write missing-scope, not admin",
    );
  }

  // Case 2: workboard.cards.dispatch on the channel surface.
  {
    console.log("\n--- Case 2: workboard.cards.dispatch on channel surface ---");
    const workboardRegistry = buildPluginRegistryWithDescriptors([
      { pluginId: "workboard", name: WORKBOARD_DISPATCH, scope: "operator.write" },
    ]);
    resetAllSurfaces();
    pinActivePluginChannelRegistry(workboardRegistry);

    const required = resolveRequiredOperatorScopeForMethod(WORKBOARD_DISPATCH);
    console.log("resolveRequiredOperatorScopeForMethod =", required);
    assert.equal(required, "operator.write", "expected write scope from channel surface");
  }

  // Case 3: the active surface is still preferred over http-route and channel.
  {
    console.log("\n--- Case 3: active surface takes priority over http-route ---");
    const httpRouteRegistry = buildPluginRegistryWithDescriptors([
      { pluginId: "workboard", name: WORKBOARD_DISPATCH, scope: "operator.read" },
    ]);
    const activeRegistry = buildPluginRegistryWithDescriptors([
      { pluginId: "workboard", name: WORKBOARD_DISPATCH, scope: "operator.write" },
    ]);
    setActivePluginRegistry(activeRegistry);
    pinActivePluginHttpRouteRegistry(httpRouteRegistry);

    const required = resolveRequiredOperatorScopeForMethod(WORKBOARD_DISPATCH);
    console.log("resolveRequiredOperatorScopeForMethod =", required);
    assert.equal(required, "operator.write", "active surface must win over http-route");
  }

  // Case 4: unknown method with empty surfaces still falls through to the
  // admin-scope default (existing behavior preserved).
  {
    console.log("\n--- Case 4: unknown method falls through to admin default ---");
    resetAllSurfaces();
    const result = authorizeOperatorScopesForMethod("totally.unknown.method", ["operator.write"]);
    console.log("authorize(totally.unknown.method, [operator.write]) =", result);
    assert.deepEqual(
      result,
      { allowed: false, missingScope: "operator.admin" },
      "unknown method must keep its admin default",
    );
  }

  // Case 5: sibling coverage for #78894 — a memory-core style descriptor on the
  // channel surface resolves to its declared scope.
  {
    console.log("\n--- Case 5: memory-core style descriptor on channel surface ---");
    const memoryRegistry = buildPluginRegistryWithDescriptors([
      { pluginId: "memory-core", name: MEMORY_DREAM_PROMOTE, scope: "operator.write" },
    ]);
    resetAllSurfaces();
    pinActivePluginChannelRegistry(memoryRegistry);

    const required = resolveRequiredOperatorScopeForMethod(MEMORY_DREAM_PROMOTE);
    console.log("resolveRequiredOperatorScopeForMethod =", required);
    assert.equal(required, "operator.write", "memory-core style should resolve write");
  }

  resetPluginRuntimeStateForTest();
  console.log("\nPASS: plugin-declared scopes are resolved across all active surfaces.");
}

// oxlint-disable-next-line typescript/use-unknown-in-catch-callback-variable -- this is a .mjs file; the parameter type lives in the diagnostic logging below.
main().catch((error) => {
  console.error("FAIL:", error);
  resetPluginRuntimeStateForTest();
  process.exitCode = 1;
});
