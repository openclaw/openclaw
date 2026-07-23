#!/usr/bin/env node
// Real-behavior proof for PR #58823 (fix subagent model precedence).
//
// Runs three scenarios through the actual resolver functions from src/agents
// and src/cron/isolated-agent and asserts the resolved subagent model follows
// the documented precedence:
//
//   1. agentConfig.subagents.model         (per-agent override, HIGHEST)
//   2. agents.defaults.subagents.model     (global subagent default)
//   3. agentConfig.model                   (agent's own primary, LOWEST)
//
// Invoke from the worktree root:
//   node --import tsx scripts/proof/pr-58823-subagent-precedence.mjs

import assert from "node:assert/strict";
import { resolveSubagentModelConfigSelectionResult } from "../../src/agents/agent-scope.ts";
import {
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
} from "../../src/agents/model-selection.ts";

function buildCfg({ agentModel, defaultSubagentModel, perAgentSubagentModel }) {
  const agentEntry = { id: "alpha", default: true };
  if (agentModel) {
    agentEntry.model = agentModel;
  }
  if (perAgentSubagentModel) {
    agentEntry.subagents = { model: perAgentSubagentModel };
  }
  const cfg = { agents: { list: [agentEntry], defaults: {} } };
  if (defaultSubagentModel) {
    cfg.agents.defaults.subagents = { model: defaultSubagentModel };
  }
  return cfg;
}

function runScenario(label, params, expected) {
  const cfg = buildCfg(params);
  const agentId = "alpha";

  const scopeResult = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
  const configured = resolveSubagentConfiguredModelSelection({ cfg, agentId });
  const spawnResolved = resolveSubagentSpawnModelSelection({ cfg, agentId });

  console.log(`--- ${label} ---`);
  console.log("input.agentConfig.model              =", params.agentModel ?? "(unset)");
  console.log("input.defaults.subagents.model       =", params.defaultSubagentModel ?? "(unset)");
  console.log("input.agentConfig.subagents.model    =", params.perAgentSubagentModel ?? "(unset)");
  console.log("agent-scope source                   =", scopeResult?.source ?? "(none)");
  console.log("agent-scope raw                      =", JSON.stringify(scopeResult?.raw));
  console.log("model-selection.resolveConfigured()  =", configured);
  console.log("model-selection.resolveSpawn()       =", spawnResolved);

  assert.equal(
    configured,
    expected.configured,
    `[${label}] configured selection: expected ${expected.configured}, got ${configured}`,
  );
  assert.equal(
    scopeResult?.source,
    expected.source,
    `[${label}] selection source: expected ${expected.source}, got ${scopeResult?.source}`,
  );
  assert.equal(
    spawnResolved,
    expected.spawn,
    `[${label}] spawn resolution: expected ${expected.spawn}, got ${spawnResolved}`,
  );
  console.log(`OK ${label}`);
  console.log("");
}

console.log("PR #58823 subagent model precedence — real-behavior proof");
console.log("repo head:", process.env.GITHUB_SHA ?? "(local worktree)");
console.log("node:", process.version);
console.log("");

// Scenario A: Global default must beat the agent's own primary model.
// This is the bug the PR fixes: an Opus-running agent with
// defaults.subagents.model=openai/gpt-5 must spawn GPT subagents, not Opus.
runScenario(
  "scenario A — global default beats agent primary",
  {
    agentModel: "anthropic/claude-opus",
    defaultSubagentModel: "openai/gpt-5",
    perAgentSubagentModel: undefined,
  },
  {
    configured: "openai/gpt-5",
    source: "default-subagent",
    spawn: "openai/gpt-5",
  },
);

// Scenario B: Per-agent subagents.model takes precedence over everything.
runScenario(
  "scenario B — per-agent override wins",
  {
    agentModel: "anthropic/claude-opus",
    defaultSubagentModel: "openai/gpt-5",
    perAgentSubagentModel: "openai/gpt-5-mini",
  },
  {
    configured: "openai/gpt-5-mini",
    source: "subagent",
    spawn: "openai/gpt-5-mini",
  },
);

// Scenario C: With nothing else set, fall through to agent's own model.
runScenario(
  "scenario C — falls through to agent primary",
  {
    agentModel: "anthropic/claude-opus",
    defaultSubagentModel: undefined,
    perAgentSubagentModel: undefined,
  },
  {
    configured: "anthropic/claude-opus",
    source: "agent",
    spawn: "anthropic/claude-opus",
  },
);

console.log(
  "PROOF PASSED — subagent model precedence follows: per-agent > defaults.subagents > agent primary",
);
