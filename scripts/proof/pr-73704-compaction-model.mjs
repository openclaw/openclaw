#!/usr/bin/env node
/*
 * Real-behavior proof for PR #73704 (fix/57901-safeguard-compaction-model).
 *
 * Goal: prove that with this patch applied, when the user configures
 * `agents.defaults.compaction.model` to a model DIFFERENT from the session
 * model, the safeguard runtime that is registered for compaction summarization
 * uses the CONFIGURED compaction model — not the session model.
 *
 * This script imports the actual fixed source under
 *   src/agents/pi-embedded-runner/extensions.ts
 * and invokes `resolveSafeguardRuntimeTarget` + `buildEmbeddedExtensionFactories`
 * end-to-end (no vitest, no mocks of the function under test). The resolved
 * model is printed; assertions throw if the patch ever regresses.
 *
 * Run from the repo root with:
 *   node --import tsx scripts/proof/pr-73704-compaction-model.mjs
 */

import {
  buildEmbeddedExtensionFactories,
  resolveSafeguardRuntimeTarget,
} from "../../src/agents/pi-embedded-runner/extensions.ts";
import { resolveEmbeddedCompactionTarget } from "../../src/agents/pi-embedded-runner/compaction-runtime-context.ts";
import { getCompactionSafeguardRuntime } from "../../src/agents/pi-hooks/compaction-safeguard-runtime.ts";

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${label}`);
  }
  console.log(`  OK   ${label} = ${JSON.stringify(actual)}`);
}

function makeModel(provider, id, contextWindow = 200_000) {
  return {
    id,
    name: id,
    provider,
    api: provider === "anthropic" ? "anthropic" : "openai-responses",
    baseUrl:
      provider === "anthropic"
        ? "https://api.anthropic.com"
        : "https://api.openai.com/v1",
    contextWindow,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
  };
}

// ---------------------------------------------------------------------------
// Scenario A: configured compaction model differs from session model.
// Resolver MUST pick the configured one and pass it into the safeguard runtime.
// ---------------------------------------------------------------------------
console.log("--- Scenario A: configured compaction model overrides session model ---");
const sessionModel = makeModel("anthropic", "claude-opus-4-7");
const configuredCompactionModel = makeModel("anthropic", "claude-sonnet-4-6");
const modelRegistryA = {
  find: (provider, modelId) => {
    console.log(`    modelRegistry.find("${provider}", "${modelId}")`);
    return provider === "anthropic" && modelId === "claude-sonnet-4-6"
      ? configuredCompactionModel
      : null;
  },
};

const cfgA = {
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        model: "anthropic/claude-sonnet-4-6",
      },
    },
  },
};

console.log("  session provider/model in : anthropic/claude-opus-4-7");
console.log("  configured compaction      : anthropic/claude-sonnet-4-6 (from agents.defaults.compaction.model)");

const pureTarget = resolveEmbeddedCompactionTarget({
  config: cfgA,
  provider: "anthropic",
  modelId: "claude-opus-4-7",
});
console.log(`  resolveEmbeddedCompactionTarget => provider="${pureTarget.provider}" model="${pureTarget.model}"`);
assertEq("pure target provider", pureTarget.provider, "anthropic");
assertEq("pure target model", pureTarget.model, "claude-sonnet-4-6");

const runtimeTargetA = resolveSafeguardRuntimeTarget({
  cfg: cfgA,
  provider: "anthropic",
  modelId: "claude-opus-4-7",
  model: sessionModel,
  modelRegistry: modelRegistryA,
});
console.log(
  `  resolveSafeguardRuntimeTarget => provider="${runtimeTargetA.provider}" modelId="${runtimeTargetA.modelId}" model.id="${runtimeTargetA.model?.id}"`,
);
assertEq("runtime target provider", runtimeTargetA.provider, "anthropic");
assertEq("runtime target modelId", runtimeTargetA.modelId, "claude-sonnet-4-6");
assertEq("runtime target model.id", runtimeTargetA.model?.id, "claude-sonnet-4-6");
assertEq("runtime target model.provider", runtimeTargetA.model?.provider, "anthropic");
assertEq("runtime target model.id is NOT session id", runtimeTargetA.model?.id !== sessionModel.id, true);

const sessionManagerA = {};
buildEmbeddedExtensionFactories({
  cfg: cfgA,
  sessionManager: sessionManagerA,
  provider: "anthropic",
  modelId: "claude-opus-4-7",
  model: sessionModel,
  modelRegistry: modelRegistryA,
});
const registeredA = getCompactionSafeguardRuntime(sessionManagerA);
console.log(
  `  registered safeguard runtime  : provider="${registeredA?.model?.provider}" model.id="${registeredA?.model?.id}" contextWindowTokens=${registeredA?.contextWindowTokens}`,
);
assertEq("registered runtime model.id", registeredA?.model?.id, "claude-sonnet-4-6");
assertEq("registered runtime model.provider", registeredA?.model?.provider, "anthropic");
assertEq("registered runtime model.id != session model id", registeredA?.model?.id !== sessionModel.id, true);

// ---------------------------------------------------------------------------
// Scenario B: no compaction model configured -> safeguard runtime keeps the
// session model. Proves the patch does not falsely override the session model.
// ---------------------------------------------------------------------------
console.log("\n--- Scenario B: no compaction.model configured -> session model preserved ---");
const sessionManagerB = {};
const cfgB = {
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
      },
    },
  },
};
buildEmbeddedExtensionFactories({
  cfg: cfgB,
  sessionManager: sessionManagerB,
  provider: "anthropic",
  modelId: "claude-opus-4-7",
  model: sessionModel,
});
const registeredB = getCompactionSafeguardRuntime(sessionManagerB);
console.log(
  `  registered safeguard runtime  : model.id="${registeredB?.model?.id}" (session id was "${sessionModel.id}")`,
);
assertEq("session model.id preserved when no override", registeredB?.model?.id, sessionModel.id);
assertEq("registered runtime model is session model (no override)", registeredB?.model === sessionModel, true);

// ---------------------------------------------------------------------------
// Scenario C: configured model missing from registry -> warns but still
// records the configured provider/modelId in the resolved target. Proves the
// safeguard NEVER silently falls back to the session model when an override is
// explicitly requested.
// ---------------------------------------------------------------------------
console.log("\n--- Scenario C: configured compaction model missing from registry ---");
const modelRegistryC = {
  find: () => null,
};
const targetC = resolveSafeguardRuntimeTarget({
  cfg: {
    agents: {
      defaults: {
        compaction: {
          mode: "safeguard",
          model: "anthropic/claude-typo-4-6",
        },
      },
    },
  },
  provider: "anthropic",
  modelId: "claude-opus-4-7",
  model: sessionModel,
  modelRegistry: modelRegistryC,
});
console.log(
  `  unresolved target             : provider="${targetC.provider}" modelId="${targetC.modelId}" model=${targetC.model === undefined ? "undefined (safeguard surfaces miss)" : targetC.model?.id}`,
);
assertEq("provider stays as configured", targetC.provider, "anthropic");
assertEq("modelId stays as configured", targetC.modelId, "claude-typo-4-6");
assertEq("model resolves to undefined on miss", targetC.model, undefined);

console.log("\nPROOF PASSED: configured compaction model wins over session model in safeguard registration.");
