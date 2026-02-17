import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.js";

const {
  loadSubagentRegistryFromDiskMock,
  saveSubagentRegistryToDiskMock,
  onAgentEventMock,
  callGatewayMock,
  warnMock,
} = vi.hoisted(() => ({
  loadSubagentRegistryFromDiskMock: vi.fn(() => new Map()),
  saveSubagentRegistryToDiskMock: vi.fn(() => {}),
  onAgentEventMock: vi.fn(() => () => {}),
  callGatewayMock: vi.fn(async () => ({ status: "ok" })),
  warnMock: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: (...args: unknown[]) => onAgentEventMock(...args),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: () => loadSubagentRegistryFromDiskMock(),
  saveSubagentRegistryToDisk: (...args: unknown[]) => saveSubagentRegistryToDiskMock(...args),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      agents: {
        defaults: {
          subagents: {
            archiveAfterMinutes: 0,
          },
        },
      },
    }),
  };
});

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      isEnabled: vi.fn(() => true),
      child: vi.fn(),
      subsystem: "subagents",
    }),
  };
});

import {
  addSubagentRunForTests,
  getRunByChildKey,
  resetSubagentRegistryForTests,
  updateRunRecord,
} from "./subagent-registry.js";

beforeEach(() => {
  loadSubagentRegistryFromDiskMock.mockReset();
  loadSubagentRegistryFromDiskMock.mockReturnValue(new Map());
  saveSubagentRegistryToDiskMock.mockReset();
  onAgentEventMock.mockReset();
  callGatewayMock.mockReset();
  warnMock.mockReset();
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
});

describe("updateRunRecord", () => {
  it("patches an existing run and persists", () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
      createdAt: Date.now(),
    } as SubagentRunRecord);

    saveSubagentRegistryToDiskMock.mockClear();

    updateRunRecord("run-1", {
      task: "updated task",
      label: "updated label",
      endedAt: 123,
      latestProgress: {
        phase: "finalizing",
        percentComplete: 90,
        updatedAt: "2026-02-17T00:00:00.000Z",
      },
      verificationState: "running",
    });

    const updated = getRunByChildKey("agent:main:subagent:child-1");
    expect(updated?.task).toBe("updated task");
    expect(updated?.label).toBe("updated label");
    expect(updated?.endedAt).toBe(123);
    expect(updated?.latestProgress?.phase).toBe("finalizing");
    expect(updated?.verificationState).toBe("running");
    expect(saveSubagentRegistryToDiskMock).toHaveBeenCalledTimes(1);
  });

  it("logs a warning and does not persist when runId is missing", () => {
    updateRunRecord("missing-run", { task: "ignored" });

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("subagent run not found for update: missing-run"),
    );
    expect(saveSubagentRegistryToDiskMock).not.toHaveBeenCalled();
  });
});
