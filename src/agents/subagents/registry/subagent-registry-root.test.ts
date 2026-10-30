import { afterEach, describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { resolveRootSubagentRequester } from "./subagent-registry-read.js";

afterEach(() => subagentRuns.clear());

describe("restart resume ancestry", () => {
  it.each([false, true])(
    "stops at the ordinary conversation despite a sessions_send requester (nested=%s)",
    (nested) => {
      const conversation = "agent:main:discord:channel:123";
      const child = "agent:main:subagent:child";
      subagentRuns.set(
        "send",
        createSubagentRunRecord({
          runId: "send",
          childSessionKey: conversation,
          requesterSessionKey: "agent:main:cron:excluded",
        }),
      );
      if (nested) {
        subagentRuns.set(
          "child",
          createSubagentRunRecord({
            runId: "child",
            childSessionKey: child,
            requesterSessionKey: conversation,
          }),
        );
      }
      expect(resolveRootSubagentRequester(nested ? child : conversation, "main")).toMatchObject({
        sessionKey: conversation,
        agentId: "main",
      });
    },
  );
});
