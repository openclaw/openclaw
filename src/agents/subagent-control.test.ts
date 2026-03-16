import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { sendControlledSubagentMessage } from "./subagent-control.js";

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
