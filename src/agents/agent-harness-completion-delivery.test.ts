import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { deliverAgentHarnessCompletion } from "../plugin-sdk/agent-harness-completion.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgentHarnessCompletionScope } from "./agent-harness-completion-scope.js";

afterEach(() => clearRuntimeConfigSnapshot());

it.each(["physical", "revision"] as const)(
  "rejects a contradictory historical requester %s before announcement",
  async (field) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:main";
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath: path.join(state.sessionsDir(), "sessions.json") },
        { sessionId: "current-physical", lifecycleRevision: "current-revision", updatedAt: 1 },
      );
      const delivery = await deliverAgentHarnessCompletion({
        scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
        isSourceSessionAdmissionAllowed: () => true,
        childSessionKey: "harness:child-1",
        childSessionId: "child-1",
        announceId: "example:parent:child-1:succeeded",
        status: "succeeded",
        result: "result",
        expectedRequester: {
          sessionId: field === "physical" ? "previous-physical" : "current-physical",
          lifecycleRevision: field === "revision" ? "previous-revision" : "current-revision",
        },
      });
      expect(delivery).toMatchObject({
        delivered: false,
        recoveryBlocked: true,
        error: "completion requester locator is missing or replaced",
      });
    });
  },
);
