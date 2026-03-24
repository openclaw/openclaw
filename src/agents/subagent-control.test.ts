import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as sessions from "../config/sessions.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import {
  __testing,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
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
    resetSubagentRegistryForTests({ persist: false });
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
    addSubagentRunForTests({
      runId: "run-owned",
      childSessionKey: "agent:main:subagent:owned",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "continue work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

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

  it("does not send to a newer live run when the caller passes a stale run entry", async () => {
    addSubagentRunForTests({
      runId: "run-current-send",
      childSessionKey: "agent:main:subagent:send-worker",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
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
        runId: "run-stale-send",
        childSessionKey: "agent:main:subagent:send-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 9_000,
        startedAt: Date.now() - 8_000,
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale-send",
      text: "stale task is already finished.",
    });
  });

  it("sends follow-up messages to the exact finished current run", async () => {
    addSubagentRunForTests({
      runId: "run-finished-send",
      childSessionKey: "agent:main:subagent:finished-worker",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent") {
          return { runId: "run-followup-send" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        if (request.method === "chat.history") {
          return { messages: [] } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
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
        runId: "run-finished-send",
        childSessionKey: "agent:main:subagent:finished-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "finished task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "ok",
      runId: "run-followup-send",
      replyText: undefined,
    });
  });

  it("sends follow-up messages to the newest finished run when stale active rows still exist", async () => {
    const childSessionKey = "agent:main:subagent:finished-stale-worker";
    addSubagentRunForTests({
      runId: "run-stale-active-send",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-finished-send",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent") {
          return { runId: "run-followup-stale-send" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        if (request.method === "chat.history") {
          return { messages: [] } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
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
        runId: "run-current-finished-send",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "finished task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "ok",
      runId: "run-followup-stale-send",
      replyText: undefined,
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

  it("does not kill a newest finished run when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:worker-stale-admin";

    addSubagentRunForTests({
      runId: "run-stale-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "stale admin task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "current admin task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await killSubagentRunAdmin({
      cfg: {} as OpenClawConfig,
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-current-admin",
      sessionKey: childSessionKey,
    });
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

describe("killControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("does not mutate the live session when the caller passes a stale run entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-stale-kill-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:stale-kill-worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-current",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killControlledSubagentRun({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-stale",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 9_000,
        startedAt: Date.now() - 8_000,
      },
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale",
      sessionKey: childSessionKey,
      label: "stale task",
      text: "stale task is already finished.",
    });
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
      string,
      { abortedLastRun?: boolean }
    >;
    expect(persisted[childSessionKey]?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current");
  });
});

describe("killAllControlledSubagentRuns", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("ignores stale run snapshots in bulk kill requests", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-stale-kill-all-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:stale-kill-all-worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-current-bulk",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-stale-bulk",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "stale bulk task",
          cleanup: "keep",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
      string,
      { abortedLastRun?: boolean }
    >;
    expect(persisted[childSessionKey]?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current-bulk");
  });

  it("does not let a stale bulk entry suppress the current live entry for the same child key", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-subagent-stale-kill-all-shadow-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          [childSessionKey]: {
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    addSubagentRunForTests({
      runId: "run-current-shadow",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current shadow task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-stale-shadow",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "stale shadow task",
          cleanup: "keep",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        },
        {
          runId: "run-current-shadow",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "current shadow task",
          cleanup: "keep",
          createdAt: Date.now() - 4_000,
          startedAt: Date.now() - 3_000,
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["current shadow task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("does not kill a newest finished bulk target when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:stale-bulk-finished-worker";

    addSubagentRunForTests({
      runId: "run-stale-bulk-finished",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale bulk finished task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-bulk-finished",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk finished task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {} as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-current-bulk-finished",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "current bulk finished task",
          cleanup: "keep",
          createdAt: Date.now() - 5_000,
          startedAt: Date.now() - 4_000,
          endedAt: Date.now() - 1_000,
          outcome: { status: "ok" },
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
  });

  it("cascades through descendants for an ended current bulk target even when a stale older row is still active", async () => {
    const parentSessionKey = "agent:main:subagent:stale-bulk-desc-parent";
    const childSessionKey = `${parentSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      runId: "run-stale-bulk-desc-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale bulk parent task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-bulk-desc-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk parent task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-active-bulk-desc-child",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "active bulk child task",
      cleanup: "keep",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: {} as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-current-bulk-desc-parent",
          childSessionKey: parentSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "current bulk parent task",
          cleanup: "keep",
          createdAt: Date.now() - 5_000,
          startedAt: Date.now() - 4_000,
          endedAt: Date.now() - 1_000,
          outcome: { status: "ok" },
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["active bulk child task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
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

  it("steers an ended current run that is still waiting on active descendants even when stale older rows exist", async () => {
    const childSessionKey = "agent:main:subagent:stale-steer-worker";
    addSubagentRunForTests({
      runId: "run-stale-active-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active steer task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-ended-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended steer task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-descendant-active-steer",
      childSessionKey: `${childSessionKey}:subagent:leaf`,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "leaf task",
      cleanup: "keep",
      createdAt: Date.now() - 500,
      startedAt: Date.now() - 500,
    });

    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-steer" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
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
        runId: "run-current-ended-steer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "current ended steer task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "updated direction",
    });

    expect(result).toEqual({
      status: "accepted",
      runId: "run-followup-steer",
      sessionKey: childSessionKey,
      sessionId: undefined,
      mode: "restart",
      label: "current ended steer task",
      text: "steered current ended steer task.",
    });
  });
});
