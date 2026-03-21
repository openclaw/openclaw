import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { killSubagentRunAdmin, sendControlledSubagentMessage } from "./subagent-control.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("sendControlledSubagentMessage", () => {
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
});

describe("killSubagentRunAdmin", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
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
});
