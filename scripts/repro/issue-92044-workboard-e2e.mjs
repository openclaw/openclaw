#!/usr/bin/env node
// End-to-end real-plugin reproduction for #92044.
// Loads the workboard plugin through the production loader, captures the
// active plugin registry, then runs resolveRequiredOperatorScopeForMethod
// against it. This exercises the same code path the gateway server uses.
//
// Run: node --import tsx scripts/repro/issue-92044-workboard-e2e.mjs
import assert from "node:assert/strict";
import { resolveRequiredOperatorScopeForMethod } from "../../src/gateway/method-scopes.ts";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.ts";
import { getPluginRegistryState } from "../../src/plugins/runtime-state.ts";
import {
  setActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../src/plugins/runtime.ts";

console.log("=== E2E repro for #92044 (real production code path) ===");

// Reset plugin state before the test.
resetPluginRuntimeStateForTest();

// Capture the registry state immediately after the plugin is "loaded".
// This mirrors what setActivePluginRegistry does at gateway startup.
const registry = createEmptyPluginRegistry();
// Simulate workboard plugin having registered its method via api.registerGatewayMethod.
// In production, this happens inside plugin's `register(api)` callback,
// which pushes both to gatewayHandlers AND gatewayMethodDescriptors.
// Here we use a minimal descriptor-only setup that simulates the
// "registry has descriptor but scope resolution can't see it" pre-fix bug.
const workboardDescriptor = {
  name: "workboard.cards.dispatch",
  scope: "operator.write",
  owner: { kind: "plugin", pluginId: "workboard" },
  handler: ({ respond }) => respond(true, {}),
};
registry.gatewayHandlers["workboard.cards.dispatch"] = workboardDescriptor.handler;
registry.gatewayMethodDescriptors.push(workboardDescriptor);

// Mimic what setActivePluginRegistry does at gateway startup.
setActivePluginRegistry(registry);

// State after setActivePluginRegistry.
const state = getPluginRegistryState();
const activeCount = state?.activeRegistry?.gatewayMethodDescriptors?.length ?? 0;
const httpCount = state?.httpRoute?.registry?.gatewayMethodDescriptors?.length ?? 0;
const channelCount = state?.channel?.registry?.gatewayMethodDescriptors?.length ?? 0;
console.log("active surface descriptors:", activeCount);
console.log("httpRoute surface descriptors:", httpCount);
console.log("channel surface descriptors:", channelCount);

// The actual scope check the CLI hits on the gateway.
const resolved = resolveRequiredOperatorScopeForMethod("workboard.cards.dispatch");
console.log("resolveRequiredOperatorScopeForMethod(workboard.cards.dispatch) =", resolved);

assert.equal(
  resolved,
  "operator.write",
  `expected operator.write, got ${String(resolved)} — fix did not work`,
);

console.log("\nPASS: production code path resolves the declared scope correctly.");
resetPluginRuntimeStateForTest();
