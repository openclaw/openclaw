import "./subagents/spawn/subagent-spawn-model.mocks.shared.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-flow-registry.test-support.js";
import {
  configureInMemoryTaskStoresForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { codeModeSwarmHandlers } from "./code-mode-swarm.runtime.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "./subagents/registry/subagent-registry-state.js";
import {
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { spawnSubagentDirect } from "./subagents/spawn/subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagents/spawn/subagent-spawn.test-support.js";
import { prepareDynamicsSpawn } from "./subagents/swarm/dynamics/dynamics-spawn.js";
import { testing as swarmSchedulerTesting } from "./subagents/swarm/swarm-scheduler.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search-catalog.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

vi.mock("./runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("./runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
const task = "Verify the frozen candidate against the acceptance criteria.";
const sessionKey = "agent:main:main";
const parentRunId = "parent-run";
const codeModeRunId = "code-run";
const requestId = "bridge:1";
const groupId = `swarm:${sessionKey}:${parentRunId}`;
const replayKey = `${codeModeRunId}:${requestId}`;

type DispatchGatewayMethodInProcess = NonNullable<
  NonNullable<
    Parameters<typeof subagentSpawnTesting.setDepsForTest>[0]
  >["dispatchGatewayMethodInProcess"]
>;

let stateDir = "";

function candidate(policyDigest = "sha256:policy-a") {
  return {
    version: 1 as const,
    candidateDigest: "sha256:candidate",
    sourceDigest: "sha256:source",
    recipeDigest: "sha256:recipe",
    policyDigest,
  };
}

function dynamics(policyDigest = "sha256:policy-a") {
  return {
    boundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
    handoff: {
      candidateDigest: "sha256:candidate",
      artifactRefs: ["artifact://candidate"],
    },
    candidate: candidate(policyDigest),
  };
}

function preparedInput(dynamicsInput: ReturnType<typeof dynamics>) {
  return {
    ...prepareDynamicsSpawn({
      task,
      dynamics: dynamicsInput,
      sourceReplicaId: groupId,
      targetReplicaId: replayKey,
    }),
    collect: true,
    groupId,
  };
}

function fingerprint(input: ReturnType<typeof preparedInput>): string {
  return `sha256:${createHash("sha256").update(stableStringify(input)).digest("hex")}`;
}

async function writeConfig(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      codeMode: true,
      swarm: { enabled: true, maxConcurrent: 2 },
    },
    agents: {
      defaults: {
        workspace: stateDir,
        sandbox: { mode: "all" },
      },
      entries: { main: { workspace: stateDir } },
    },
  };
  await writeFile(path.join(stateDir, "openclaw.json"), `${JSON.stringify(config)}\n`);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return config;
}

describe("Code Mode dynamics native replay", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    // Queued subagent admission creates its task through the real registry; keep that
    // owner in-process so the suite never depends on a host SQLite broker.
    configureInMemoryTaskStoresForTests();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-dynamics-replay-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    subagentSpawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await cleanupSessionStateForTest({ stateDir });
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("replays the exact candidate without redispatch and rejects changed governing identity", async () => {
    const config = await writeConfig();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const dispatchGatewayMethodInProcess: DispatchGatewayMethodInProcess = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      requests.push({ method, params });
      // SAFETY: this fixture supplies the accepted Gateway response shape for the generic T.
      return { runId: "native-replay-run", status: "accepted" } as T;
    };
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess,
    });

    const originalDynamics = dynamics();
    const input = preparedInput(originalDynamics);
    const seeded = await spawnSubagentDirect(
      {
        ...input,
        swarmLaunchReplayKey: replayKey,
        swarmLaunchRequestFingerprint: fingerprint(input),
      },
      {
        agentSessionKey: sessionKey,
        requesterRunId: parentRunId,
      },
    );
    expect(seeded).toMatchObject({ status: "accepted" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params.message).toEqual(
      expect.stringContaining('"policyDigest":"sha256:policy-a"'),
    );

    // Simulate a cold process boundary: discard the resident registry and hydrate the
    // collector from the production SQLite owner before asking Code Mode to replay it.
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    expect(restoreSubagentRunsFromDisk({ runs: subagentRuns })).toBe(1);
    expect(
      [...subagentRuns.values()].find((entry) => entry.swarmLaunchReplayKey === replayKey),
    ).toMatchObject({
      runId: seeded.runId,
      swarmLaunchRequestFingerprint: fingerprint(input),
    });

    const catalogRef = createToolSearchCatalogRef();
    const spawnTool = createSessionsSpawnTool({
      config,
      agentSessionKey: sessionKey,
      requesterRunId: parentRunId,
    });
    const ctx: ToolSearchToolContext = {
      config,
      runtimeConfig: config,
      sessionKey,
      sessionId: "session-parent",
      runId: parentRunId,
      catalogRef,
    };
    // Code Mode compaction only publishes a catalog when its own control tools are present.
    applyCodeModeCatalog({ ...ctx, tools: [...createCodeModeTools(ctx), spawnTool] });

    const callExactId = vi.fn(async () => {
      throw new Error("exact replay must not redispatch sessions_spawn");
    });
    const runtime: Pick<ToolSearchRuntime, "callExactId"> = { callExactId };
    const request = {
      id: requestId,
      method: "agentSpawn" as const,
      args: [task, { dynamics: originalDynamics }],
    };

    await expect(
      codeModeSwarmHandlers.agentSpawn({
        runtime,
        parentToolCallId: "parent-call",
        request,
        codeModeRunId,
        ctx,
      }),
    ).resolves.toMatchObject({ status: "accepted", runId: seeded.runId });
    expect(callExactId).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);

    await expect(
      codeModeSwarmHandlers.agentSpawn({
        runtime,
        parentToolCallId: "parent-call",
        request: {
          ...request,
          args: [task, { dynamics: dynamics("sha256:policy-b") }],
        },
        codeModeRunId,
        ctx,
      }),
    ).rejects.toThrow("replay request does not match the persisted collector");
    expect(callExactId).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});
