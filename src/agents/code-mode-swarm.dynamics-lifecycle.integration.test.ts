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
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { codeModeSwarmHandlers } from "./code-mode-swarm.runtime.js";
import { createToolSearchCatalogRef } from "./tool-search-catalog.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import {
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { prepareDynamicsSpawn } from "./subagents/swarm/dynamics/dynamics-spawn.js";
import { testing as swarmSchedulerTesting } from "./subagents/swarm/swarm-scheduler.test-support.js";
import { updateSwarmCollectorCompletion } from "./subagents/swarm/swarm-collector.js";
import { spawnSubagentDirect } from "./subagents/spawn/subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagents/spawn/subagent-spawn.test-support.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const parentRunId = "parent-run";
const codeModeRunId = "code-run";
const requestId = "bridge:1";
const groupId = `swarm:${sessionKey}:${parentRunId}`;
const replayKey = `${codeModeRunId}:${requestId}`;
const task = "Explore one independent explanation.";

let stateDir = "";

async function writeConfig(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      codeMode: true,
      swarm: { enabled: true, maxConcurrent: 2 },
    },
    agents: {
      defaults: { workspace: stateDir },
      entries: { main: { workspace: stateDir } },
    },
  };
  await writeFile(path.join(stateDir, "openclaw.json"), `${JSON.stringify(config)}\n`);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return config;
}

function isolatedInput() {
  return {
    ...prepareDynamicsSpawn({
      task,
      dynamics: { boundary: "isolated" },
      sourceReplicaId: groupId,
      targetReplicaId: replayKey,
    }),
    collect: true,
    groupId,
  };
}

function fingerprint(input: ReturnType<typeof isolatedInput>): string {
  return `sha256:${createHash("sha256").update(stableStringify(input)).digest("hex")}`;
}

describe("Code Mode dynamics lifecycle integration", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
    });
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-dynamics-lifecycle-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
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

  it("projects terminal debt into one advisory and releases the parent observer", async () => {
    const config = await writeConfig();
    const dispatchGatewayMethodInProcess = vi.fn(
      async <T>(
        _method: string,
        _params: Record<string, unknown>,
        _options?: unknown,
      ) => {
        // SAFETY: this fixture supplies the accepted Gateway response shape for the generic T.
        return { runId: "native-lifecycle-run", status: "accepted" } as T;
      },
    );
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess,
    });

    const input = isolatedInput();
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
    if (!seeded.runId) {
      throw new Error("expected a native collector run id");
    }

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
    applyCodeModeCatalog({ ...ctx, tools: [spawnTool] });

    const callExactId = vi.fn(async () => {
      throw new Error("registered replay must not redispatch sessions_spawn");
    });
    const runtime: Pick<ToolSearchRuntime, "callExactId"> = { callExactId };
    await codeModeSwarmHandlers.agentSpawn({
      runtime,
      parentToolCallId: "parent-call",
      request: {
        id: requestId,
        method: "agentSpawn",
        args: [task, { dynamics: { boundary: "isolated" } }],
      },
      codeModeRunId,
      ctx,
    });
    expect(callExactId).not.toHaveBeenCalled();
    expect(catalogRef.onDispose?.size).toBe(1);

    const entry = getSubagentRunByRunId(seeded.runId);
    if (!entry) {
      throw new Error("expected the seeded collector in the native registry");
    }
    const endedAt = Date.now();
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "error", error: "synthetic collector failure" },
    };
    entry.completion = {
      required: false,
      resultText: "synthetic collector failure",
      capturedAt: endedAt,
    };
    expect(updateSwarmCollectorCompletion(entry, config)).toBe(true);

    const events: SessionLifecycleEvent[] = [];
    const unsubscribe = onSessionLifecycleEvent((event) => events.push(event));
    try {
      await expect(
        codeModeSwarmHandlers.agentWait({
          request: {
            id: "wait:1",
            method: "agentWait",
            args: [seeded.runId],
          },
          ctx,
        }),
      ).resolves.toMatchObject({
        runId: seeded.runId,
        status: "failed",
      });

      expect(events).toContainEqual(
        expect.objectContaining({
          sessionKey,
          reason: "swarm-note",
          swarmGroupId: groupId,
          kind: "log",
          text: expect.stringContaining("Dynamics advisory: drain"),
        }),
      );
      expect(catalogRef.onDispose?.size ?? 0).toBe(0);

      const advisoryCount = events.length;
      await codeModeSwarmHandlers.agentWait({
        request: {
          id: "wait:2",
          method: "agentWait",
          args: [seeded.runId],
        },
        ctx,
      });
      expect(events).toHaveLength(advisoryCount);
    } finally {
      unsubscribe();
    }
  });
});
