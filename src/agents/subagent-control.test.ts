import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as sessions from "../config/sessions.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import {
  __testing,
  killSubagentRunAdmin,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "./subagent-control.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("sendControlledSubagentMessage", () => {
  afterEach(() => {
    __testing.setDepsForTest();
  });

  it("rejects runs controlled by another session", async () => {
    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:subagent:leaf",
        callerSessionKey: "agent:main:subagent:leaf",
        callerIsSubagent: true,
        controlScope: "children",
      },
      entry: {
        runId: "run-foreign",
        childSessionKey: "agent:main:subagent:other",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:subagent:other-parent",
        task: "foreign run",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "forbidden",
      error: "Subagents can only control runs spawned from their own session.",
    });
  });

  it("returns a structured error when the gateway send fails", async () => {
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent") {
          throw new Error("gateway unavailable");
        }
        return {} as T;
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-owned",
        childSessionKey: "agent:main:subagent:owned",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "continue work",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "error",
      runId: expect.any(String),
      error: "gateway unavailable",
    });
  });
});

describe("killSubagentRunAdmin", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("kills a subagent by session key without requester ownership checks", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-admin-kill-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            sessionId: "sess-worker",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await killSubagentRunAdmin({
      cfg,
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-worker",
      sessionKey: childSessionKey,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await killSubagentRunAdmin({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:subagent:missing",
    });

    expect(result).toEqual({ found: false, killed: false });
  });

  it("still terminates the run when session store persistence fails during kill", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-admin-kill-store-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:worker-store-fail";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            sessionId: "sess-worker-store-fail",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-worker-store-fail",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const updateSessionStoreSpy = vi
      .spyOn(sessions, "updateSessionStore")
      .mockRejectedValueOnce(new Error("session store unavailable"));

    try {
      const result = await killSubagentRunAdmin({
        cfg: {
          session: { store: storePath },
        } as OpenClawConfig,
        sessionKey: childSessionKey,
      });

      expect(result).toMatchObject({
        found: true,
        killed: true,
        runId: "run-worker-store-fail",
        sessionKey: childSessionKey,
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
    } finally {
      updateSessionStoreSpy.mockRestore();
    }
  });
});

describe("steerControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("returns an error and clears the restart marker when run remap fails", async () => {
    addSubagentRunForTests({
      runId: "run-steer-old",
      childSessionKey: "agent:main:subagent:steer-worker",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const replaceSpy = vi
      .spyOn(await import("./subagent-registry.js"), "replaceSubagentRunAfterSteer")
      .mockReturnValue(false);

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-steer-new" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    try {
      const result = await steerControlledSubagentRun({
        cfg: {} as OpenClawConfig,
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry: {
          runId: "run-steer-old",
          childSessionKey: "agent:main:subagent:steer-worker",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "initial task",
          cleanup: "keep",
          createdAt: Date.now() - 5_000,
          startedAt: Date.now() - 4_000,
        },
        message: "updated direction",
      });

      expect(result).toEqual({
        status: "error",
        runId: "run-steer-new",
        sessionKey: "agent:main:subagent:steer-worker",
        sessionId: undefined,
        error: "failed to replace steered subagent run",
      });
      expect(getSubagentRunByChildSessionKey("agent:main:subagent:steer-worker")).toMatchObject({
        runId: "run-steer-old",
        suppressAnnounceReason: undefined,
      });
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it("rejects steering runs that are no longer tracked in the registry", async () => {
    __testing.setDepsForTest({
      callGateway: async () => {
        throw new Error("gateway should not be called");
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: {} as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-stale",
        childSessionKey: "agent:main:subagent:stale-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      },
      message: "updated direction",
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale",
      sessionKey: "agent:main:subagent:stale-worker",
      text: "stale task is already finished.",
    });
  });
});
