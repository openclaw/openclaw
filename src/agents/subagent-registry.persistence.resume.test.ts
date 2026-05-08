import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToDisk } from "./subagent-registry.store.js";

const hoisted = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
const { announceSpy } = hoisted;
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

let mod: typeof import("./subagent-registry.js");
let callGatewayModule: typeof import("../gateway/call.js");
let agentEventsModule: typeof import("../infra/agent-events.js");

describe("subagent registry persistence resume", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      abortedLastRun: params.abortedLastRun,
      defaultSessionId: `sess-${Date.now()}`,
    });
  };

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.js");
    callGatewayModule = await import("../gateway/call.js");
    agentEventsModule = await import("../infra/agent-events.js");
  });

  beforeEach(async () => {
    announceSpy.mockClear();
    vi.mocked(callGatewayModule.callGateway).mockReset();
    vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    mod.__testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      }),
    });
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent).mockReset();
    vi.mocked(agentEventsModule.onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    announceSpy.mockClear();
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists runs to SQLite and resumes after restart", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");

    saveSubagentRegistryToDisk(
      new Map([
        [
          "run-1",
          {
            runId: "run-1",
            childSessionKey: "agent:main:subagent:test",
            requesterSessionKey: "agent:main:main",
            requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
            requesterDisplayKey: "main",
            task: "do the thing",
            cleanup: "keep",
            createdAt: Date.now(),
          },
        ],
      ]),
    );
    await expect(fs.access(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:test",
      sessionId: "sess-test",
    });

    mod.initSubagentRegistry();

    await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
      timeout: 1_000,
      interval: 10,
    });

    const announceCalls = announceSpy.mock.calls as unknown as Array<[unknown]>;
    const announce = (announceCalls.at(-1)?.[0] ?? undefined) as
      | {
          childRunId?: string;
          childSessionKey?: string;
          requesterSessionKey?: string;
          requesterOrigin?: { channel?: string; accountId?: string };
          task?: string;
          cleanup?: string;
          outcome?: { status?: string };
        }
      | undefined;
    expect(announce?.childRunId).toBe("run-1");
    expect(announce?.childSessionKey).toBe("agent:main:subagent:test");
    expect(announce?.requesterSessionKey).toBe("agent:main:main");
    expect(announce?.requesterOrigin?.channel).toBe("whatsapp");
    expect(announce?.requesterOrigin?.accountId).toBe("acct-main");
    expect(announce?.task).toBe("do the thing");
    expect(announce?.cleanup).toBe("keep");
    expect(announce?.outcome?.status).toBe("ok");

    const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(restored?.childSessionKey).toBe("agent:main:subagent:test");
    expect(restored?.requesterOrigin?.channel).toBe("whatsapp");
    expect(restored?.requesterOrigin?.accountId).toBe("acct-main");
  });
});
